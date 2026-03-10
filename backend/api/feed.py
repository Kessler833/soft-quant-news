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
_status_queues: list = []
_raw_queues: list = []

RSS_FEEDS = [
    'https://rss.forexlive.com',
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadline',
]

# ── Base hardcoded keywords (fallback) ───────────────────────────────────────

_BASE_HIGH = [
    'fed ', 'federal reserve', 'fomc', 'rate cut', 'rate hike', 'interest rate',
    'cpi', 'inflation', 'gdp', 'nonfarm', 'payroll', 'jobs report', 'unemployment',
    'earnings', 'beats', 'misses', 'eps', 'revenue', 'guidance', 'outlook',
    'merger', 'acquisition', 'takeover', 'buyout', 'ipo',
    'circuit breaker', 'halt', 'crash', 'plunge', 'surge', 'spike',
    'bankruptcy', 'default', 'downgrade', 'upgrade',
    'tariff', 'sanction', 'war', 'crisis', 'emergency',
    'ecb', 'pboc', 'bank of japan', 'boj', 'opec', 'powell', 'yellen',
]
_BASE_MEDIUM = [
    's&p', 'nasdaq', 'dow', 'russell', 'sp500', 'spy', 'qqq',
    'stock', 'shares', 'equities', 'market', 'wall street', 'nyse',
    'analyst', 'price target', 'rating', 'forecast', 'estimate',
    'sector', 'energy', 'tech', 'finance', 'bank', 'retail',
    'oil', 'gold', 'dollar', 'treasury', 'bond', 'yield',
    'quarter', 'fiscal', 'annual', 'profit', 'loss',
    'china', 'europe', 'japan', 'germany', 'pmi', 'manufacturing',
]
_BASE_LOW = [
    'company', 'report', 'announce', 'says', 'update', 'plan', 'launch',
    'appoint', 'ceo', 'executive', 'partnership', 'contract', 'deal',
    'crypto', 'bitcoin', 'ethereum', 'commodity', 'currency',
]
_BULL_KW = ['beat', 'beats', 'surge', 'rally', 'gain', 'rise', 'jump', 'upgrade',
            'record', 'strong', 'growth', 'bullish', 'buy', 'positive', 'rebound']
_BEAR_KW = ['miss', 'misses', 'plunge', 'fall', 'drop', 'decline', 'downgrade',
            'weak', 'loss', 'cut', 'warning', 'bearish', 'sell', 'negative', 'crash']
_CATALYST_MAP = {
    'Earnings':     ['earnings', 'eps', 'revenue', 'guidance', 'quarter', 'beats', 'misses'],
    'Fed':          ['fed ', 'fomc', 'federal reserve', 'rate cut', 'rate hike', 'powell'],
    'Macro':        ['cpi', 'gdp', 'inflation', 'payroll', 'unemployment', 'jobs report', 'pmi'],
    'Analyst':      ['analyst', 'price target', 'upgrade', 'downgrade', 'rating', 'forecast'],
    'M&A':          ['merger', 'acquisition', 'takeover', 'buyout', 'deal'],
    'Regulatory':   ['sec', 'doj', 'ftc', 'regulatory', 'fine', 'penalty', 'lawsuit'],
    'Geopolitical': ['war', 'sanction', 'tariff', 'trade', 'china', 'russia', 'iran', 'opec'],
}

_cached_kw = {'high': None, 'medium': None, 'low': None, '_loaded_at': None}


def _get_active_keywords():
    now = datetime.now(timezone.utc)
    if _cached_kw['_loaded_at'] and (now - _cached_kw['_loaded_at']).seconds < 300:
        return _cached_kw['high'], _cached_kw['medium'], _cached_kw['low']
    kw = db.get_latest_keywords()
    if kw:
        high   = list(set(_BASE_HIGH   + [k.lower() for k in kw['high_kw']]))
        medium = list(set(_BASE_MEDIUM + [k.lower() for k in kw['medium_kw']]))
        low    = list(set(_BASE_LOW    + [k.lower() for k in kw['low_kw']]))
    else:
        high, medium, low = _BASE_HIGH, _BASE_MEDIUM, _BASE_LOW
    _cached_kw.update({'high': high, 'medium': medium, 'low': low, '_loaded_at': now})
    return high, medium, low


def rule_score(article: dict) -> dict:
    text = (article.get('title', '') + ' ' + article.get('summary', '')).lower()
    high_kw, medium_kw, low_kw = _get_active_keywords()

    high_hits   = sum(1 for kw in high_kw   if kw in text)
    medium_hits = sum(1 for kw in medium_kw if kw in text)
    low_hits    = sum(1 for kw in low_kw    if kw in text)
    bull_hits   = sum(1 for kw in _BULL_KW  if kw in text)
    bear_hits   = sum(1 for kw in _BEAR_KW  if kw in text)

    if high_hits >= 2:
        relevance = 'HIGH';   impact = min(10, 5 + high_hits * 2)
    elif high_hits == 1 and (medium_hits >= 1 or bull_hits + bear_hits >= 1):
        relevance = 'HIGH';   impact = min(9, 5 + medium_hits)
    elif high_hits == 1:
        relevance = 'MEDIUM'; impact = 6
    elif medium_hits >= 2:
        relevance = 'MEDIUM'; impact = min(7, 3 + medium_hits)
    elif medium_hits == 1:
        relevance = 'LOW';    impact = 3
    elif low_hits >= 1:
        relevance = 'LOW';    impact = 2
    else:
        relevance = 'IGNORE'; impact = 1

    sentiment = 'Bullish' if bull_hits > bear_hits else ('Bearish' if bear_hits > bull_hits else 'Neutral')
    catalyst = 'Other'
    for cat, keywords in _CATALYST_MAP.items():
        if any(kw in text for kw in keywords):
            catalyst = cat
            break

    return {'relevance': relevance, 'sentiment': sentiment, 'impact_score': impact, 'catalyst_type': catalyst}


# ── Keyword refresh ──────────────────────────────────────────────────────────

async def refresh_keywords() -> None:
    groq_key = config.get('groq_key', '')
    if not groq_key:
        logger.warning('[feed] No Groq key — skipping keyword refresh.')
        return
    kw = db.get_latest_keywords()
    if kw and kw.get('generated_at'):
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(kw['generated_at'].replace('Z', '+00:00'))).total_seconds()
            if age < 21600:
                logger.info(f'[feed] Keywords fresh ({int(age/3600)}h old), skipping refresh.')
                return
        except Exception:
            pass

    prompt = """You are a financial news filter for a US equity day trader.
Based on CURRENT macro market conditions (consider Fed policy stance, active earnings season, geopolitical tensions, sector rotations happening right now), generate keyword lists for filtering financial news headlines.
Return ONLY this JSON, no markdown:
{
  "high": ["keyword1","keyword2",...],
  "medium": ["keyword1","keyword2",...],
  "low": ["keyword1","keyword2",...],
  "context_note": "one sentence describing current market regime"
}
HIGH = 25-30 keywords/phrases that indicate genuinely market-moving events for US equities right now.
MEDIUM = 25-30 keywords for relevant but non-urgent news.
LOW = 15-20 keywords for marginally relevant news worth tracking.
Be specific to current market themes, not just generic finance words."""

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                'https://api.groq.com/openai/v1/chat/completions',
                headers={'Authorization': f'Bearer {groq_key}', 'Content-Type': 'application/json'},
                json={'model': 'llama-3.3-70b-versatile', 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0.3, 'max_tokens': 1024}
            )
            r.raise_for_status()
            text = r.json()['choices'][0]['message']['content'].strip()
            if text.startswith('```'):
                text = re.sub(r'^```[a-z]*\n?', '', text)
                text = re.sub(r'```$', '', text).strip()
            parsed = json.loads(text)
            db.save_keywords(parsed.get('high', []), parsed.get('medium', []), parsed.get('low', []), parsed.get('context_note', ''))
            _cached_kw['_loaded_at'] = None
            logger.info('[feed] Keywords refreshed from Groq.')
    except Exception as e:
        logger.error(f'[feed] Keyword refresh error: {e}')


# ── SSE helpers ──────────────────────────────────────────────────────────────

def _emit_status(msg: str):
    dead = []
    for q in _status_queues:
        try: q.put_nowait(msg)
        except: dead.append(q)
    for q in dead:
        try: _status_queues.remove(q)
        except: pass


def _emit_raw(article: dict):
    payload = json.dumps({
        'id':           article.get('id', ''),
        'title':        article.get('title', ''),
        'source':       article.get('source', ''),
        'relevance':    article.get('relevance', 'IGNORE'),
        'sentiment':    article.get('sentiment', 'Neutral'),
        'published_at': article.get('published_at', ''),
    })
    dead = []
    for q in _raw_queues:
        try: q.put_nowait(payload)
        except: dead.append(q)
    for q in dead:
        try: _raw_queues.remove(q)
        except: pass


# ── Groq enrichment ──────────────────────────────────────────────────────────

async def groq_filter_batch(batch: list) -> list:
    if not batch:
        return []
    groq_key = config.get('groq_key', '')
    if not groq_key:
        return []

    headlines_json = json.dumps([{'id': a['id'], 'title': a['title'], 'source': a['source']} for a in batch])
    prompt = f"""You are filtering financial news for a US equity day trader.
For EACH headline return a JSON array. Each element:
- "id": exact id string
- "relevance": "HIGH" | "MEDIUM" | "LOW" | "IGNORE"
- "tickers": array of affected US stock symbols e.g. ["SPY","NVDA"]
- "sentiment": "Bullish" | "Bearish" | "Neutral"
- "impact_score": integer 1-10
- "catalyst_type": "Earnings"|"Fed"|"Macro"|"Analyst"|"M&A"|"Regulatory"|"Geopolitical"|"Other"
- "summary": one trader-focused sentence (empty string if IGNORE or LOW)

HIGH = genuinely market-moving for US equities today
MEDIUM = relevant, worth watching
LOW = marginally relevant, minor news
IGNORE = not relevant to US equity markets

Input:
{headlines_json}

Return ONLY a valid JSON array. No markdown."""

    backoff = [5, 15, 30]
    async with _groq_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        headers={'Authorization': f'Bearer {groq_key}', 'Content-Type': 'application/json'},
                        json={'model': 'llama-3.1-8b-instant', 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0.1, 'max_tokens': 1536}
                    )
                if r.status_code == 429:
                    if delay:
                        logger.warning(f'[feed] Groq 429, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                        continue
                    else:
                        return []
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


# ── Source fetchers ──────────────────────────────────────────────────────────

def _make_id(title):
    return hashlib.sha256(title.lower().strip().encode()).hexdigest()[:24]


def _normalize(title, source, url='', published_at=''):
    return {
        'id': _make_id(title), 'title': title, 'source': source, 'url': url,
        'published_at': published_at or datetime.now(timezone.utc).isoformat(),
        'summary': '', 'tickers': '[]', 'sentiment': 'Neutral',
        'relevance': 'LOW', 'impact_score': 2, 'catalyst_type': 'Other',
        'processed_at': datetime.now(timezone.utc).isoformat(),
    }


async def _fetch_finnhub_general(key):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://finnhub.io/api/v1/news?category=general&token={key}')
            r.raise_for_status()
            return [_normalize(i.get('headline',''), 'Finnhub', i.get('url',''),
                    datetime.fromtimestamp(i.get('datetime',0), tz=timezone.utc).isoformat())
                    for i in r.json() if i.get('headline')]
    except Exception as e:
        logger.warning(f'[feed] Finnhub general: {e}'); return []


async def _fetch_finnhub_company(key, ticker):
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://finnhub.io/api/v1/company-news?symbol={ticker}&from={today}&to={today}&token={key}')
            r.raise_for_status()
            return [_normalize(i.get('headline',''), f'Finnhub/{ticker}', i.get('url',''),
                    datetime.fromtimestamp(i.get('datetime',0), tz=timezone.utc).isoformat())
                    for i in r.json() if i.get('headline')]
    except Exception as e:
        logger.warning(f'[feed] Finnhub {ticker}: {e}'); return []


async def _fetch_marketaux(token):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://api.marketaux.com/v1/news/all?api_token={token}&language=en&limit=50&filter_entities=true')
            r.raise_for_status()
            return [_normalize(i.get('title',''), 'Marketaux', i.get('url',''), i.get('published_at',''))
                    for i in r.json().get('data',[]) if i.get('title')]
    except Exception as e:
        logger.warning(f'[feed] Marketaux: {e}'); return []


async def _fetch_newsapi(key):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://newsapi.org/v2/top-headlines?category=business&pageSize=50&apiKey={key}')
            r.raise_for_status()
            return [_normalize(i.get('title',''), 'NewsAPI', i.get('url',''), i.get('publishedAt',''))
                    for i in r.json().get('articles',[]) if i.get('title')]
    except Exception as e:
        logger.warning(f'[feed] NewsAPI: {e}'); return []


async def _fetch_rss(url):
    try:
        import feedparser, time
        loop = asyncio.get_running_loop()
        feed = await loop.run_in_executor(None, feedparser.parse, url)
        results = []
        for entry in feed.entries:
            title = entry.get('title', '')
            if not title: continue
            pub = ''
            if hasattr(entry, 'published_parsed') and entry.published_parsed:
                pub = datetime.fromtimestamp(time.mktime(entry.published_parsed), tz=timezone.utc).isoformat()
            results.append(_normalize(title, f'RSS:{url.split("/")[2]}', entry.get('link',''), pub))
        return results
    except Exception as e:
        logger.warning(f'[feed] RSS {url}: {e}'); return []


async def _empty_list(): return []


# ── Main ingest ──────────────────────────────────────────────────────────────

async def ingest_all_sources() -> None:
    finnhub_key   = config.get('finnhub_key', '')
    marketaux_tok = config.get('marketaux_token', '')
    newsapi_key   = config.get('newsapi_key', '')
    groq_key      = config.get('groq_key', '')

    _emit_status('fetching: Collecting articles from all sources...')

    watchlist_tickers = db.get_watchlist()
    tasks = [_fetch_finnhub_general(finnhub_key) if finnhub_key else _empty_list()]
    for t in watchlist_tickers:
        if finnhub_key:
            tasks.append(_fetch_finnhub_company(finnhub_key, t))
    if marketaux_tok: tasks.append(_fetch_marketaux(marketaux_tok))
    if newsapi_key:   tasks.append(_fetch_newsapi(newsapi_key))
    for rss_url in RSS_FEEDS:
        tasks.append(_fetch_rss(rss_url))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    all_articles = [a for r in results if isinstance(r, list) for a in r]
    existing_ids = {a['id'] for a in db.get_latest_articles(limit=500)}
    new_articles = [a for a in all_articles if a['id'] not in existing_ids]

    if not new_articles:
        _emit_status('idle: Feed up to date — no new articles')
        return

    _emit_status(f'scoring: Rule-scoring {len(new_articles)} articles...')
    for article in new_articles:
        article.update(rule_score(article))

    # Broadcast raw (pre-Groq) to Raw News panel immediately
    for article in new_articles:
        _emit_raw(article)

    if groq_key:
        to_enrich = [a for a in new_articles if a['relevance'] not in ('IGNORE',)]
        if to_enrich:
            batch = to_enrich[:15]
            _emit_status(f'ai: Groq enriching {len(batch)}/{len(to_enrich)} articles...')
            groq_results = await groq_filter_batch(batch)
            groq_map = {g['id']: g for g in groq_results if isinstance(g, dict)}
            enriched = 0
            for article in batch:
                if article['id'] in groq_map:
                    g = groq_map[article['id']]
                    article['relevance']     = g.get('relevance',     article['relevance'])
                    article['tickers']       = json.dumps(g.get('tickers', []))
                    article['sentiment']     = g.get('sentiment',     article['sentiment'])
                    article['impact_score']  = g.get('impact_score',  article['impact_score'])
                    article['catalyst_type'] = g.get('catalyst_type', article['catalyst_type'])
                    article['summary']       = g.get('summary', '')
                    enriched += 1
            _emit_status(f'ai: Enriched {enriched}/{len(batch)} articles')
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

    high_n = len([a for a in new_articles if a['relevance'] == 'HIGH'])
    med_n  = len([a for a in new_articles if a['relevance'] == 'MEDIUM'])
    low_n  = len([a for a in new_articles if a['relevance'] == 'LOW'])
    _emit_status(f'done: {saved} saved — {high_n} HIGH · {med_n} MEDIUM · {low_n} LOW')


def _schedule_drift(article_id, ticker):
    try:
        from backend.main import scheduler
        now = datetime.now(timezone.utc)
        for minutes in [5, 15, 30]:
            run_at = now + timedelta(minutes=minutes)
            scheduler.add_job(_track_drift, 'date', run_date=run_at, args=[article_id, ticker, minutes],
                              id=f'drift_{article_id}_{ticker}_{minutes}', replace_existing=True, misfire_grace_time=60)
    except Exception as e:
        logger.warning(f'[feed] Drift schedule: {e}')


async def _track_drift(article_id, ticker, minutes):
    try:
        from backend.api.prices import get_quote_price
        price = await get_quote_price(ticker)
        if price: db.save_drift(article_id, ticker, minutes, price)
    except Exception as e:
        logger.warning(f'[feed] Drift track: {e}')


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get('/latest')
async def get_latest(limit: int = 50, relevance: Optional[str] = None,
                     sentiment: Optional[str] = None, catalyst: Optional[str] = None,
                     ticker: Optional[str] = None):
    return db.get_latest_articles(limit=limit, relevance_filter=relevance,
                                   sentiment_filter=sentiment, catalyst_filter=catalyst, ticker_filter=ticker)


@router.get('/ticker/{symbol}')
async def get_ticker_feed(symbol: str):
    return db.get_articles_for_ticker(symbol.upper())


@router.get('/all')
async def get_all(limit: int = 200, relevance: Optional[str] = None,
                  sentiment: Optional[str] = None, catalyst: Optional[str] = None,
                  ticker: Optional[str] = None):
    return db.get_latest_articles(limit=limit, relevance_filter=relevance,
                                   sentiment_filter=sentiment, catalyst_filter=catalyst, ticker_filter=ticker)


@router.get('/keyword-status')
async def keyword_status():
    kw = db.get_latest_keywords()
    if not kw:
        return {'generated_at': None, 'next_at': None, 'high_count': 0, 'medium_count': 0, 'low_count': 0, 'context_note': None}
    try:
        gen = datetime.fromisoformat(kw['generated_at'].replace('Z', '+00:00'))
        next_at = (gen + timedelta(hours=6)).isoformat()
    except Exception:
        next_at = None
    return {
        'generated_at': kw['generated_at'],
        'next_at':      next_at,
        'high_count':   len(kw['high_kw']),
        'medium_count': len(kw['medium_kw']),
        'low_count':    len(kw['low_kw']),
        'context_note': kw['context_note'],
    }


@router.post('/refresh-keywords')
async def trigger_refresh_keywords():
    asyncio.create_task(refresh_keywords())
    return {'status': 'generating'}


@router.get('/ingest-status')
async def ingest_status_stream():
    q = asyncio.Queue(maxsize=50)
    _status_queues.append(q)
    async def gen():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f'data: {msg}\n\n'
                except asyncio.TimeoutError:
                    yield 'data: ping\n\n'
        except asyncio.CancelledError:
            pass
        finally:
            try: _status_queues.remove(q)
            except: pass
    return StreamingResponse(gen(), media_type='text/event-stream', headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})


@router.get('/raw-stream')
async def raw_stream():
    q = asyncio.Queue(maxsize=200)
    _raw_queues.append(q)
    async def gen():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f'data: {msg}\n\n'
                except asyncio.TimeoutError:
                    yield 'data: ping\n\n'
        except asyncio.CancelledError:
            pass
        finally:
            try: _raw_queues.remove(q)
            except: pass
    return StreamingResponse(gen(), media_type='text/event-stream', headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})
