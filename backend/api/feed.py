import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_gemini_sem = asyncio.Semaphore(1)

RSS_FEEDS = [
    'https://rss.forexlive.com',
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadline',
    'https://www.benzinga.com/feed',
    'https://seekingalpha.com/feed.xml',
]


async def _get_gemini_model():
    import google.generativeai as genai
    key = config.get('gemini_key', '')
    if key:
        genai.configure(api_key=key)
    try:
        return genai.GenerativeModel('gemini-2.0-flash')
    except Exception:
        return genai.GenerativeModel('gemini-1.5-flash')


async def gemini_filter_batch(batch: list) -> list:
    if not batch:
        return []
    gemini_key = config.get('gemini_key', '')
    if not gemini_key:
        logger.warning('[feed] No Gemini key — skipping AI filter.')
        return []

    headlines_json = json.dumps(
        [{'id': a['id'], 'title': a['title'], 'source': a['source']} for a in batch]
    )
    prompt = f"""You are filtering financial news for a US equity day trader.
Focus: S&P 500, Russell 2000, Nasdaq.
For EACH headline return a JSON array. Each element:
- "id": exact id string provided
- "relevance": "HIGH" | "MEDIUM" | "IGNORE"
- "tickers": array of affected US stock symbols ["SPY","NVDA"]
- "sentiment": "Bullish" | "Bearish" | "Neutral"
- "impact_score": integer 1-10
- "catalyst_type": "Earnings"|"Fed"|"Macro"|"Analyst"|"M&A"|"Regulatory"|"Geopolitical"|"Other"
- "summary": one trader-focused sentence (empty if IGNORE)

HIGH = genuinely market-moving for US equities today
MEDIUM = relevant but not urgent
IGNORE = irrelevant, noise, or non-US markets

Input (JSON array of {{id, title, source}}):
{headlines_json}

Return ONLY valid JSON array. No markdown. No explanation."""

    backoff = [5, 15, 30]
    async with _gemini_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                model = await _get_gemini_model()
                loop = asyncio.get_running_loop()
                response = await loop.run_in_executor(
                    None,
                    lambda: model.generate_content(prompt)
                )
                if not response.text:
                    return []
                text = response.text.strip()
                if text.startswith('```'):
                    text = text.split('```')[1]
                    if text.startswith('json'):
                        text = text[4:]
                return json.loads(text.strip())
            except Exception as e:
                err_name = type(e).__name__
                if 'ResourceExhausted' in err_name or '429' in str(e):
                    if delay:
                        logger.warning(f'[feed] Gemini rate limited, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                    else:
                        logger.error('[feed] Gemini exhausted all retries, skipping batch.')
                        return []
                else:
                    logger.error(f'[feed] Gemini error: {e}')
                    return []
    return []


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
            r = await client.get(
                f'https://finnhub.io/api/v1/news?category=general&token={key}'
            )
            r.raise_for_status()
            items = r.json()
            return [
                _normalize(i.get('headline', ''), 'Finnhub', i.get('url', ''),
                           datetime.fromtimestamp(i.get('datetime', 0), tz=timezone.utc).isoformat())
                for i in items if i.get('headline')
            ]
    except Exception as e:
        logger.warning(f'[feed] Finnhub general error: {e}')
        return []


async def _fetch_finnhub_company(key: str, ticker: str) -> list:
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://finnhub.io/api/v1/company-news?symbol={ticker}'
                f'&from={today}&to={today}&token={key}'
            )
            r.raise_for_status()
            items = r.json()
            return [
                _normalize(i.get('headline', ''), f'Finnhub/{ticker}', i.get('url', ''),
                           datetime.fromtimestamp(i.get('datetime', 0), tz=timezone.utc).isoformat())
                for i in items if i.get('headline')
            ]
    except Exception as e:
        logger.warning(f'[feed] Finnhub company {ticker} error: {e}')
        return []


async def _fetch_marketaux(token: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://api.marketaux.com/v1/news/all?api_token={token}'
                '&language=en&limit=50&filter_entities=true'
            )
            r.raise_for_status()
            items = r.json().get('data', [])
            return [
                _normalize(i.get('title', ''), 'Marketaux', i.get('url', ''),
                           i.get('published_at', ''))
                for i in items if i.get('title')
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
            items = r.json().get('articles', [])
            return [
                _normalize(i.get('title', ''), 'NewsAPI', i.get('url', ''),
                           i.get('publishedAt', ''))
                for i in items if i.get('title')
            ]
    except Exception as e:
        logger.warning(f'[feed] NewsAPI error: {e}')
        return []


async def _fetch_benzinga(key: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://api.benzinga.com/api/v2/news?token={key}&pageSize=50&displayOutput=full'
            )
            r.raise_for_status()
            raw = r.json()
            items = raw if isinstance(raw, list) else raw.get('result', [])
            return [
                _normalize(i.get('title', ''), 'Benzinga', i.get('url', ''),
                           i.get('created', ''))
                for i in items if i.get('title')
            ]
    except Exception as e:
        logger.warning(f'[feed] Benzinga error: {e}')
        return []


async def _fetch_rss(url: str) -> list:
    try:
        import feedparser
        loop = asyncio.get_running_loop()
        feed = await loop.run_in_executor(None, feedparser.parse, url)
        results = []
        for entry in feed.entries:
            title = entry.get('title', '')
            if not title:
                continue
            pub = ''
            if hasattr(entry, 'published_parsed') and entry.published_parsed:
                import time
                pub = datetime.fromtimestamp(
                    time.mktime(entry.published_parsed), tz=timezone.utc
                ).isoformat()
            results.append(_normalize(title, f'RSS:{url.split("/")[2]}',
                                      entry.get('link', ''), pub))
        return results
    except Exception as e:
        logger.warning(f'[feed] RSS {url} error: {e}')
        return []


async def _empty_list() -> list:
    return []


async def ingest_all_sources() -> None:
    finnhub_key   = config.get('finnhub_key', '')
    marketaux_tok = config.get('marketaux_token', '')
    newsapi_key   = config.get('newsapi_key', '')
    benzinga_key  = config.get('benzinga_key', '')

    if not any([finnhub_key, marketaux_tok, newsapi_key, benzinga_key]):
        logger.warning('[feed] No news API keys configured — skipping ingest.')
        return

    watchlist_tickers = db.get_watchlist()

    tasks = [
        _fetch_finnhub_general(finnhub_key) if finnhub_key else _empty_list()
    ]
    for t in watchlist_tickers:
        if finnhub_key:
            tasks.append(_fetch_finnhub_company(finnhub_key, t))
    if marketaux_tok:
        tasks.append(_fetch_marketaux(marketaux_tok))
    if newsapi_key:
        tasks.append(_fetch_newsapi(newsapi_key))
    if benzinga_key:
        tasks.append(_fetch_benzinga(benzinga_key))
    for rss_url in RSS_FEEDS:
        tasks.append(_fetch_rss(rss_url))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_articles = []
    for r in results:
        if isinstance(r, list):
            all_articles.extend(r)

    existing_ids = {a['id'] for a in db.get_latest_articles(limit=500)}
    new_articles = [a for a in all_articles if a['id'] not in existing_ids]

    if not new_articles:
        logger.info('[feed] No new articles after dedup.')
        return

    logger.info(f'[feed] Processing {len(new_articles)} new articles through Gemini...')

    # Cap first-run at 30 articles to avoid rate limit storm
    new_articles = new_articles[:30]

    batch_size = 10
    batches = [new_articles[i:i+batch_size] for i in range(0, len(new_articles), batch_size)]

    for i, batch in enumerate(batches):
        if i > 0:
            await asyncio.sleep(6)  # 6s between batches — safe for free tier (10 RPM)
        gemini_results = await gemini_filter_batch(batch)
        gemini_map = {g['id']: g for g in gemini_results if isinstance(g, dict)}

        for article in batch:
            if article['id'] in gemini_map:
                g = gemini_map[article['id']]
                article['relevance']     = g.get('relevance', 'MEDIUM')
                article['tickers']       = json.dumps(g.get('tickers', []))
                article['sentiment']     = g.get('sentiment', 'Neutral')
                article['impact_score']  = g.get('impact_score', 5)
                article['catalyst_type'] = g.get('catalyst_type', 'Other')
                article['summary']       = g.get('summary', '')

            db.save_article(article)

            if article.get('relevance') in ('HIGH', 'MEDIUM'):
                from backend.api import websocket as ws_module
                await ws_module.broadcast(article)

            if article.get('relevance') == 'HIGH':
                tickers = json.loads(article.get('tickers', '[]'))
                for ticker in tickers[:3]:
                    _schedule_drift(article['id'], ticker)


def _schedule_drift(article_id: str, ticker: str) -> None:
    try:
        from backend.main import scheduler
        now = datetime.now(timezone.utc)
        for minutes in [5, 15, 30]:
            run_at = now + timedelta(minutes=minutes)
            scheduler.add_job(
                _track_drift,
                'date',
                run_date=run_at,
                args=[article_id, ticker, minutes],
                id=f'drift_{article_id}_{ticker}_{minutes}',
                replace_existing=True,
                misfire_grace_time=60,
            )
    except Exception as e:
        logger.warning(f'[feed] Drift scheduling error: {e}')


async def _track_drift(article_id: str, ticker: str, minutes: int) -> None:
    try:
        from backend.api.prices import get_quote_price
        price = await get_quote_price(ticker)
        if price is None:
            return
        db.save_drift(article_id, ticker, minutes, price)
    except Exception as e:
        logger.warning(f'[feed] Drift track error ({ticker} +{minutes}m): {e}')


# ─── Routes ─────────────────────────────────────────────────────────────────────────────

@router.get('/latest')
async def get_latest(
    limit: int = 50,
    relevance: Optional[str] = None,
    sentiment: Optional[str] = None,
    catalyst: Optional[str] = None,
    ticker: Optional[str] = None,
):
    return db.get_latest_articles(
        limit=limit,
        relevance_filter=relevance,
        sentiment_filter=sentiment,
        catalyst_filter=catalyst,
        ticker_filter=ticker,
    )


@router.get('/ticker/{symbol}')
async def get_ticker_feed(symbol: str):
    return db.get_articles_for_ticker(symbol.upper())


@router.get('/all')
async def get_all(
    limit: int = 200,
    relevance: Optional[str] = None,
    sentiment: Optional[str] = None,
    catalyst: Optional[str] = None,
    ticker: Optional[str] = None,
):
    return db.get_latest_articles(
        limit=limit,
        relevance_filter=relevance,
        sentiment_filter=sentiment,
        catalyst_filter=catalyst,
        ticker_filter=ticker,
    )
