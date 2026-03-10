import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_groq_sem = asyncio.Semaphore(1)

# Broadcast ingest status to all SSE listeners
_status_queues: list[asyncio.Queue] = []

def _emit_status(msg: str):
    """Push a status string to all connected SSE clients."""
    dead = []
    for q in _status_queues:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        try:
            _status_queues.remove(q)
        except ValueError:
            pass

RSS_FEEDS = [
    'https://rss.forexlive.com',
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadline',
]

# ── Rule-based keyword scorer ─────────────────────────────────────────────────

_HIGH_KEYWORDS = [
    'fed ', 'federal reserve', 'fomc', 'rate cut', 'rate hike', 'interest rate',
    'cpi', 'inflation', 'gdp', 'nonfarm', 'payroll', 'jobs report', 'unemployment',
    'earnings', 'beats', 'misses', 'eps', 'revenue', 'guidance', 'outlook',
    'merger', 'acquisition', 'takeover', 'buyout', 'ipo',
    'circuit breaker', 'halt', 'crash', 'plunge', 'surge', 'spike',
    'bankruptcy', 'default', 'downgrade', 'upgrade',
    'tariff', 'sanction', 'war', 'crisis', 'emergency',
]
_MEDIUM_KEYWORDS = [
    's&p', 'nasdaq', 'dow', 'russell', 'sp500', 'spy', 'qqq',
    'stock', 'shares', 'equities', 'market', 'wall street', 'nyse',
    'analyst', 'price target', 'rating', 'forecast', 'estimate',
    'sector', 'energy', 'tech', 'finance', 'bank', 'retail',
    'oil', 'gold', 'dollar', 'treasury', 'bond', 'yield',
    'quarter', 'fiscal', 'annual', 'profit', 'loss',
]
_BULL_KEYWORDS = ['beat', 'beats', 'surge', 'rally', 'gain', 'rise', 'jump', 'upgrade',
                  'record', 'high', 'strong', 'growth', 'bullish', 'buy', 'positive']
_BEAR_KEYWORDS = ['miss', 'misses', 'plunge', 'fall', 'drop', 'decline', 'downgrade',
                  'weak', 'loss', 'cut', 'warning', 'bearish', 'sell', 'negative', 'crash']
_CATALYST_MAP = {
    'Earnings':    ['earnings', 'eps', 'revenue', 'guidance', 'quarter', 'beats', 'misses'],
    'Fed':         ['fed ', 'fomc', 'federal reserve', 'rate cut', 'rate hike', 'powell'],
    'Macro':       ['cpi', 'gdp', 'inflation', 'payroll', 'unemployment', 'jobs report'],
    'Analyst':     ['analyst', 'price target', 'upgrade', 'downgrade', 'rating', 'forecast'],
    'M&A':         ['merger', 'acquisition', 'takeover', 'buyout', 'deal'],
    'Regulatory':  ['sec', 'doj', 'ftc', 'regulatory', 'fine', 'penalty', 'lawsuit'],
    'Geopolitical':['war', 'sanction', 'tariff', 'trade', 'china', 'russia', 'iran'],
}


def rule_score(article: dict) -> dict:
    text = (article.get('title', '') + ' ' + article.get('summary', '')).lower()

    high_hits  = sum(1 for kw in _HIGH_KEYWORDS   if kw in text)
    med_hits   = sum(1 for kw in _MEDIUM_KEYWORDS  if kw in text)
    bull_hits  = sum(1 for kw in _BULL_KEYWORDS    if kw in text)
    bear_hits  = sum(1 for kw in _BEAR_KEYWORDS    if kw in text)

    if high_hits >= 1:
        relevance = 'HIGH'
        impact    = min(10, 5 + high_hits * 2)
    elif med_hits >= 1:
        relevance = 'MEDIUM'
        impact    = min(7, 3 + med_hits)
    else:
        relevance = 'IGNORE'
        impact    = 1

    sentiment = 'Bullish' if bull_hits > bear_hits else ('Bearish' if bear_hits > bull_hits else 'Neutral')

    catalyst = 'Other'
    for cat, keywords in _CATALYST_MAP.items():
        if any(kw in text for kw in keywords):
            catalyst = cat
            break

    return {
        'relevance':     relevance,
        'sentiment':     sentiment,
        'impact_score':  impact,
        'catalyst_type': catalyst,
    }


# ── Groq AI enrichment ────────────────────────────────────────────────────────

async def groq_filter_batch(batch: list) -> list:
    if not batch:
        return []
    groq_key = config.get('groq_key', '')
    if not groq_key:
        return []

    headlines_json = json.dumps(
        [{'id': a['id'], 'title': a['title'], 'source': a['source']} for a in batch]
    )
    prompt = f"""You are filtering financial news for a US equity day trader.
Focus: S&P 500, Russell 2000, Nasdaq.
For EACH headline return a JSON array. Each element:
- "id": exact id string provided
- "relevance": "HIGH" | "MEDIUM" | "IGNORE"
- "tickers": array of affected US stock symbols e.g. ["SPY","NVDA"]
- "sentiment": "Bullish" | "Bearish" | "Neutral"
- "impact_score": integer 1-10
- "catalyst_type": "Earnings"|"Fed"|"Macro"|"Analyst"|"M&A"|"Regulatory"|"Geopolitical"|"Other"
- "summary": one trader-focused sentence (empty string if IGNORE)

HIGH = genuinely market-moving for US equities today
MEDIUM = relevant but not urgent
IGNORE = irrelevant, noise, or non-US markets

Input:
{headlines_json}

Return ONLY a valid JSON array. No markdown. No explanation."""

    backoff = [5, 15, 30]
    async with _groq_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        headers={
                            'Authorization': f'Bearer {groq_key}',
                            'Content-Type': 'application/json',
                        },
                        json={
                            'model': 'llama-3.3-70b-versatile',
                            'messages': [{'role': 'user', 'content': prompt}],
                            'temperature': 0.1,
                            'max_tokens': 2048,
                        }
                    )
                if r.status_code == 429:
                    if delay:
                        logger.warning(f'[feed] Groq rate limited, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                    else:
                        logger.error('[feed] Groq exhausted retries, falling back to rule-based.')
                        return []
                    continue
                r.raise_for_status()
                text = r.json()['choices'][0]['message']['content'].strip()
                if text.startswith('```'):
                    text = re.sub(r'^```[a-z]*\n?', '', text)
                    text = re.sub(r'```$', '', text).strip()
                return json.loads(text)
            except Exception as e:
                if delay:
                    logger.warning(f'[feed] Groq error ({e}), retrying in {delay}s...')
                    await asyncio.sleep(delay)
                else:
                    logger.error(f'[feed] Groq failed: {e}')
                    return []
    return []


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_id(title: str) -> str:
    return hashlib.sha256(title.lower().strip().encode()).hexdigest()[:24]


def _normalize(title: str, source: str, url: str = '', published_at: str = '') -> dict:
    return {
        'id':            _make_id(title),
        'title':         title,
        'source':        source,
        'url':           url,
        'published_at':  published_at or datetime.now(timezone.utc).isoformat(),
        'summary':       '',
        'tickers':       '[]',
        'sentiment':     'Neutral',
        'relevance':     'MEDIUM',
        'impact_score':  5,
        'catalyst_type': 'Other',
        'processed_at':  datetime.now(timezone.utc).isoformat(),
    }


async def _fetch_finnhub_general(key: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://finnhub.io/api/v1/news?category=general&token={key}')
            r.raise_for_status()
            return [
                _normalize(i.get('headline', ''), 'Finnhub', i.get('url', ''),
                           datetime.fromtimestamp(i.get('datetime', 0), tz=timezone.utc).isoformat())
                for i in r.json() if i.get('headline')
            ]
    except Exception as e:
        logger.warning(f'[feed] Finnhub general error: {e}')
        return []


async def _fetch_finnhub_company(key: str, ticker: str) -> list:
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://finnhub.io/api/v1/company-news?symbol={ticker}&from={today}&to={today}&token={key}'
            )
            r.raise_for_status()
            return [
                _normalize(i.get('headline', ''), f'Finnhub/{ticker}', i.get('url', ''),
                           datetime.fromtimestamp(i.get('datetime', 0), tz=timezone.utc).isoformat())
                for i in r.json() if i.get('headline')
            ]
    except Exception as e:
        logger.warning(f'[feed] Finnhub company {ticker} error: {e}')
        return []


async def _fetch_marketaux(token: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://api.marketaux.com/v1/news/all?api_token={token}&language=en&limit=50&filter_entities=true'
            )
            r.raise_for_status()
            return [
                _normalize(i.get('title', ''), 'Marketaux', i.get('url', ''), i.get('published_at', ''))
                for i in r.json().get('data', []) if i.get('title')
            ]
    except Exception as e:
        logger.warning(f'[feed] Marketaux error: {e}')
        return []


async def _fetch_newsapi(key: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://newsapi.org/v2/top-headlines?category=business&pageSize=50&apiKey={key}'
            )
            r.raise_for_status()
            return [
                _normalize(i.get('title', ''), 'NewsAPI', i.get('url', ''), i.get('publishedAt', ''))
                for i in r.json().get('articles', []) if i.get('title')
            ]
    except Exception as e:
        logger.warning(f'[feed] NewsAPI error: {e}')
        return []


async def _fetch_rss(url: str) -> list:
    try:
        import feedparser, time
        loop = asyncio.get_running_loop()
        feed = await loop.run_in_executor(None, feedparser.parse, url)
        results = []
        for entry in feed.entries:
            title = entry.get('title', '')
            if not title:
                continue
            pub = ''
            if hasattr(entry, 'published_parsed') and entry.published_parsed:
                pub = datetime.fromtimestamp(time.mktime(entry.published_parsed), tz=timezone.utc).isoformat()
            results.append(_normalize(title, f'RSS:{url.split("/")[2]}', entry.get('link', ''), pub))
        return results
    except Exception as e:
        logger.warning(f'[feed] RSS {url} error: {e}')
        return []


async def _empty_list() -> list:
    return []


# ── Main ingest ───────────────────────────────────────────────────────────────

async def ingest_all_sources() -> None:
    finnhub_key   = config.get('finnhub_key', '')
    marketaux_tok = config.get('marketaux_token', '')
    newsapi_key   = config.get('newsapi_key', '')
    benzinga_key  = config.get('benzinga_key', '')
    groq_key      = config.get('groq_key', '')

    if not any([finnhub_key, marketaux_tok, newsapi_key, benzinga_key]):
        _emit_status('idle: No news API keys configured')
        logger.warning('[feed] No news API keys configured — RSS only ingest.')

    _emit_status('fetching: Collecting articles from all sources...')

    watchlist_tickers = db.get_watchlist()
    tasks = [_fetch_finnhub_general(finnhub_key) if finnhub_key else _empty_list()]
    for t in watchlist_tickers:
        if finnhub_key:
            tasks.append(_fetch_finnhub_company(finnhub_key, t))
    if marketaux_tok:
        tasks.append(_fetch_marketaux(marketaux_tok))
    if newsapi_key:
        tasks.append(_fetch_newsapi(newsapi_key))
    for rss_url in RSS_FEEDS:
        tasks.append(_fetch_rss(rss_url))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    all_articles = [a for r in results if isinstance(r, list) for a in r]

    existing_ids = {a['id'] for a in db.get_latest_articles(limit=500)}
    new_articles = [a for a in all_articles if a['id'] not in existing_ids]

    if not new_articles:
        _emit_status('idle: Feed up to date — no new articles')
        logger.info('[feed] No new articles after dedup.')
        return

    _emit_status(f'scoring: Rule-based scoring {len(new_articles)} articles...')
    logger.info(f'[feed] {len(new_articles)} new articles — applying rule-based filter...')

    for article in new_articles:
        scores = rule_score(article)
        article.update(scores)

    if groq_key:
        to_enrich = [a for a in new_articles if a['relevance'] != 'IGNORE']
        if to_enrich:
            groq_rpm   = int(config.get('groq_rpm', 25))
            batch_size = min(25, groq_rpm)
            batch      = to_enrich[:batch_size]
            delay_sec  = max(2.5, 60.0 / groq_rpm)

            _emit_status(f'ai: Groq enriching {len(batch)} of {len(to_enrich)} articles (batch {batch_size})...')
            logger.info(f'[feed] Groq enriching {len(batch)} articles (rpm={groq_rpm})...')
            groq_results = await groq_filter_batch(batch)
            groq_map     = {g['id']: g for g in groq_results if isinstance(g, dict)}

            enriched = 0
            for article in batch:
                if article['id'] in groq_map:
                    g = groq_map[article['id']]
                    article['relevance']     = g.get('relevance',     article['relevance'])
                    article['tickers']       = json.dumps(g.get('tickers', []))
                    article['sentiment']     = g.get('sentiment',     article['sentiment'])
                    article['impact_score']  = g.get('impact_score',  article['impact_score'])
                    article['catalyst_type'] = g.get('catalyst_type', article['catalyst_type'])
                    article['summary']       = g.get('summary',       '')
                    enriched += 1

            _emit_status(f'ai: Groq enriched {enriched}/{len(batch)} articles')
            await asyncio.sleep(delay_sec)
    else:
        _emit_status('scoring: Rule-based only (no Groq key)')

    saved = 0
    for article in new_articles:
        db.save_article(article)
        saved += 1
        if article.get('relevance') in ('HIGH', 'MEDIUM'):
            from backend.api import websocket as ws_module
            await ws_module.broadcast(article)
        if article.get('relevance') == 'HIGH':
            tickers = json.loads(article.get('tickers', '[]'))
            for ticker in tickers[:3]:
                _schedule_drift(article['id'], ticker)

    _emit_status(f'done: Saved {saved} articles ({len([a for a in new_articles if a["relevance"] == "HIGH"])} HIGH, {len([a for a in new_articles if a["relevance"] == "MEDIUM"])} MEDIUM)')
    logger.info(f'[feed] Saved {saved} articles.')


def _schedule_drift(article_id: str, ticker: str) -> None:
    try:
        from backend.main import scheduler
        now = datetime.now(timezone.utc)
        for minutes in [5, 15, 30]:
            run_at = now + timedelta(minutes=minutes)
            scheduler.add_job(
                _track_drift, 'date', run_date=run_at,
                args=[article_id, ticker, minutes],
                id=f'drift_{article_id}_{ticker}_{minutes}',
                replace_existing=True, misfire_grace_time=60,
            )
    except Exception as e:
        logger.warning(f'[feed] Drift scheduling error: {e}')


async def _track_drift(article_id: str, ticker: str, minutes: int) -> None:
    try:
        from backend.api.prices import get_quote_price
        price = await get_quote_price(ticker)
        if price is None: return
        db.save_drift(article_id, ticker, minutes, price)
    except Exception as e:
        logger.warning(f'[feed] Drift track error ({ticker} +{minutes}m): {e}')


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get('/latest')
async def get_latest(limit: int = 50, relevance: Optional[str] = None,
                     sentiment: Optional[str] = None, catalyst: Optional[str] = None,
                     ticker: Optional[str] = None):
    return db.get_latest_articles(limit=limit, relevance_filter=relevance,
                                   sentiment_filter=sentiment, catalyst_filter=catalyst,
                                   ticker_filter=ticker)


@router.get('/ticker/{symbol}')
async def get_ticker_feed(symbol: str):
    return db.get_articles_for_ticker(symbol.upper())


@router.get('/all')
async def get_all(limit: int = 200, relevance: Optional[str] = None,
                  sentiment: Optional[str] = None, catalyst: Optional[str] = None,
                  ticker: Optional[str] = None):
    return db.get_latest_articles(limit=limit, relevance_filter=relevance,
                                   sentiment_filter=sentiment, catalyst_filter=catalyst,
                                   ticker_filter=ticker)


@router.get('/ingest-status')
async def ingest_status_stream():
    """SSE endpoint — streams live ingest status messages to the frontend."""
    q: asyncio.Queue = asyncio.Queue(maxsize=50)
    _status_queues.append(q)

    async def event_generator():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f'data: {msg}\n\n'
                except asyncio.TimeoutError:
                    yield 'data: ping\n\n'  # keepalive
        except asyncio.CancelledError:
            pass
        finally:
            try:
                _status_queues.remove(q)
            except ValueError:
                pass

    return StreamingResponse(
        event_generator(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        }
    )
