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

_status_queues: list = []
_raw_queues:    list = []

# Tracks when the last ingest ran so the frontend can show a countdown
_last_ingest_at: Optional[datetime] = None
INGEST_INTERVAL_SECONDS = 60

# Only articles published within this window are considered "already seen"
# for deduplication. Wider than the ingest interval to avoid gaps, but
# short enough that we don't keep 7 days of IDs in RAM every cycle.
_DEDUP_WINDOW_HOURS = 24

# ── Hardcoded always-on HIGH keyword set ──────────────────────────────────────

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

_TICKER_RE = re.compile(
    r'\b([A-Z]{1,5})\b(?=\s*[,)\]])|'
    r'\(([A-Z]{1,5})\)|'
    r'\$([A-Z]{1,5})\b|'
    r'(?:NYSE|NASDAQ|AMEX|TSX):\s*([A-Z]{1,5})\b'
)
_TICKER_BLACKLIST = {
    'A', 'AN', 'ARE', 'AS', 'AT', 'BE', 'BY', 'CAN', 'DO', 'FOR',
    'HAS', 'HE', 'IF', 'IN', 'IS', 'IT', 'MY', 'NO', 'OF', 'ON',
    'OR', 'SO', 'TO', 'UP', 'US', 'WE',
    'CEO', 'CFO', 'COO', 'CTO', 'IPO', 'ETF', 'GDP', 'CPI', 'FED',
    'SEC', 'DOJ', 'FTC', 'IMF', 'ECB', 'BOJ', 'PBOC', 'OPEC', 'PMI',
    'EPS', 'NYSE', 'AMEX', 'SPY', 'QQQ',
}


def _extract_tickers(text: str) -> list:
    found = set()
    for m in _TICKER_RE.finditer(text):
        ticker = next(t for t in m.groups() if t)
        if ticker not in _TICKER_BLACKLIST:
            found.add(ticker)
    return sorted(found)


# ── Hybrid scorer: hardcoded keywords + AI keywords from DB ───────────────────

def rule_score(article: dict) -> dict:
    text = (article.get('title', '') + ' ' + article.get('summary', '')).lower()

    # Load AI-generated context keywords (may be None if Ollama hasn't run yet)
    ai_kw = db.get_latest_keywords()
    ai_high   = [kw.lower() for kw in (ai_kw['high_kw']   if ai_kw else [])]
    ai_medium = [kw.lower() for kw in (ai_kw['medium_kw'] if ai_kw else [])]
    ai_low    = [kw.lower() for kw in (ai_kw['low_kw']    if ai_kw else [])]

    # Combine hardcoded + AI keywords; hardcoded always wins, AI adds on top
    effective_high   = _BASE_HIGH   + [kw for kw in ai_high   if kw not in _BASE_HIGH]
    effective_medium = _BASE_MEDIUM + [kw for kw in ai_medium if kw not in _BASE_MEDIUM]
    effective_low    = _BASE_LOW    + [kw for kw in ai_low    if kw not in _BASE_LOW]

    high_hits   = sum(1 for kw in effective_high   if kw in text)
    medium_hits = sum(1 for kw in effective_medium if kw in text)
    low_hits    = sum(1 for kw in effective_low    if kw in text)
    bull_hits   = sum(1 for kw in _BULL_KW         if kw in text)
    bear_hits   = sum(1 for kw in _BEAR_KW         if kw in text)

    # AI-only HIGH hit gets a small boost so AI-detected topics score correctly
    ai_high_hits = sum(1 for kw in ai_high if kw in text)

    if high_hits >= 2 or (high_hits >= 1 and ai_high_hits >= 1):
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
    catalyst  = 'Other'
    for cat, keywords in _CATALYST_MAP.items():
        if any(kw in text for kw in keywords):
            catalyst = cat
            break

    tickers = _extract_tickers(article.get('title', '') + ' ' + article.get('summary', ''))

    return {
        'relevance':    relevance,
        'sentiment':    sentiment,
        'impact_score': impact,
        'catalyst_type': catalyst,
        'tickers':      json.dumps(tickers),
    }


# ── SSE helpers ───────────────────────────────────────────────────────────────

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


# ── SSE route handlers ────────────────────────────────────────────────────────

@router.get('/ingest-status')
async def stream_ingest_status():
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    _status_queues.append(q)

    async def _gen():
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield f'data: {msg}\n\n'
                except asyncio.TimeoutError:
                    yield ': ping\n\n'
        except GeneratorExit:
            pass
        finally:
            try: _status_queues.remove(q)
            except ValueError: pass

    return StreamingResponse(_gen(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.get('/raw-stream')
async def stream_raw_articles():
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _raw_queues.append(q)

    async def _gen():
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=25)
                    yield f'data: {payload}\n\n'
                except asyncio.TimeoutError:
                    yield ': ping\n\n'
        except GeneratorExit:
            pass
        finally:
            try: _raw_queues.remove(q)
            except ValueError: pass

    return StreamingResponse(_gen(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.get('/cycle-status')
async def get_cycle_status():
    """Returns timing info for the ingest dashboard in the raw panel."""
    global _last_ingest_at
    now = datetime.now(timezone.utc)
    last_iso = _last_ingest_at.isoformat() if _last_ingest_at else None
    if _last_ingest_at:
        elapsed  = (now - _last_ingest_at).total_seconds()
        next_in  = max(0, INGEST_INTERVAL_SECONDS - elapsed)
    else:
        next_in  = 0

    ai_kw = db.get_latest_keywords()
    return {
        'last_ingest':       last_iso,
        'next_in_seconds':   round(next_in),
        'interval_seconds':  INGEST_INTERVAL_SECONDS,
        'keyword_generated_at': ai_kw['generated_at'] if ai_kw else None,
        'keyword_count': {
            'high':   len(ai_kw['high_kw'])   if ai_kw else 0,
            'medium': len(ai_kw['medium_kw']) if ai_kw else 0,
            'low':    len(ai_kw['low_kw'])    if ai_kw else 0,
        },
        'context_note': ai_kw['context_note'] if ai_kw else '',
    }


@router.post('/force-ingest')
async def force_ingest():
    """Trigger an immediate ingest + keyword refresh cycle from the dashboard."""
    from backend.api.ai_routes import refresh_keywords
    asyncio.create_task(refresh_keywords())
    asyncio.create_task(ingest_all_sources())
    return {'status': 'triggered'}


# ── Normalisation / ID ────────────────────────────────────────────────────────

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


# ── Finnhub fetchers ──────────────────────────────────────────────────────────

async def _fetch_finnhub_general(key):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'https://finnhub.io/api/v1/news?category=general&token={key}')
            r.raise_for_status()
            articles = []
            for i in r.json():
                if not i.get('headline'):
                    continue
                ts = i.get('datetime', 0)
                # Skip articles with obviously broken/missing timestamps (epoch 0 or very old)
                if ts and ts > 0:
                    pub = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
                else:
                    # No timestamp — treat as just-published so it isn't filtered
                    pub = datetime.now(timezone.utc).isoformat()
                articles.append(_normalize(i['headline'], 'Finnhub', i.get('url', ''), pub))
            return articles
    except Exception as e:
        logger.warning(f'[feed] Finnhub general: {e}')
        return []


async def _fetch_finnhub_company(key, ticker):
    now       = datetime.now(timezone.utc)
    today     = now.strftime('%Y-%m-%d')
    yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f'https://finnhub.io/api/v1/company-news'
                f'?symbol={ticker}&from={yesterday}&to={today}&token={key}'
            )
            r.raise_for_status()
            articles = []
            for i in r.json():
                if not i.get('headline'):
                    continue
                ts = i.get('datetime', 0)
                if ts and ts > 0:
                    pub = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
                else:
                    pub = datetime.now(timezone.utc).isoformat()
                articles.append(_normalize(i['headline'], f'Finnhub/{ticker}', i.get('url', ''), pub))
            return articles
    except Exception as e:
        logger.warning(f'[feed] Finnhub {ticker}: {e}')
        return []


# ── Price drift tracking ──────────────────────────────────────────────────────

def _schedule_drift(article_id: str, ticker: str) -> None:
    try:
        import backend.main as _main_mod
        scheduler = _main_mod.scheduler
        now = datetime.now(timezone.utc)
        for minutes in [5, 15, 30]:
            run_at = now + timedelta(minutes=minutes)
            scheduler.add_job(
                _track_drift, 'date',
                run_date=run_at,
                args=[article_id, ticker, minutes],
                id=f'drift_{article_id}_{ticker}_{minutes}',
                replace_existing=True,
                misfire_grace_time=60,
            )
        logger.info(f'[feed] Drift jobs scheduled: {ticker} +5/+15/+30m (article {article_id[:8]})')
    except Exception as e:
        logger.warning(f'[feed] Drift schedule: {e}')


async def _track_drift(article_id: str, ticker: str, minutes: int) -> None:
    try:
        from backend.api.prices import get_quote_price
        price = await get_quote_price(ticker)
        if price:
            db.save_drift(article_id, ticker, minutes, price)
            logger.info(f'[feed] Drift tracked: {ticker} +{minutes}m = {price}')
        else:
            logger.warning(f'[feed] Drift track: no price for {ticker} +{minutes}m')
    except Exception as e:
        logger.warning(f'[feed] Drift track: {e}')


# ── Main ingest ───────────────────────────────────────────────────────────────

async def ingest_all_sources() -> None:
    global _last_ingest_at
    finnhub_key = config.get('finnhub_key', '')

    if not finnhub_key:
        _emit_status('idle: No Finnhub API key — add it in Settings')
        return

    _emit_status('fetching: Collecting articles from Finnhub…')

    watchlist_tickers = db.get_watchlist()
    tasks = [_fetch_finnhub_general(finnhub_key)]
    for t in watchlist_tickers:
        tasks.append(_fetch_finnhub_company(finnhub_key, t))

    results      = await asyncio.gather(*tasks, return_exceptions=True)
    all_articles = [a for r in results if isinstance(r, list) for a in r]

    # ── Deduplication: only check IDs of articles published in the last 24h ──
    # This prevents the entire article history from blocking new articles that
    # happen to share an ID with an old entry (e.g. republished stories).
    # It also avoids loading thousands of stale rows on every 60-second tick.
    recent_existing = db.get_articles_since(hours=_DEDUP_WINDOW_HOURS)
    existing_ids    = {a['id'] for a in recent_existing}
    new_articles    = [a for a in all_articles if a['id'] not in existing_ids]

    _last_ingest_at = datetime.now(timezone.utc)

    if not new_articles:
        _emit_status('idle: Feed up to date — no new articles')
        return

    _emit_status(f'scoring: Hybrid-scoring {len(new_articles)} new articles…')
    for article in new_articles:
        article.update(rule_score(article))

    for article in new_articles:
        _emit_raw(article)

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

    high_n = sum(1 for a in new_articles if a['relevance'] == 'HIGH')
    med_n  = sum(1 for a in new_articles if a['relevance'] == 'MEDIUM')
    low_n  = sum(1 for a in new_articles if a['relevance'] == 'LOW')
    _emit_status(f'done: {saved} saved — {high_n} HIGH · {med_n} MEDIUM · {low_n} LOW')
