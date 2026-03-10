import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import APIRouter

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_wsb_cache = {'data': None, 'updated_at': None}

TICKER_SECTOR = {
    'AAPL': 'Tech', 'MSFT': 'Tech', 'NVDA': 'Tech', 'META': 'Tech',
    'GOOGL': 'Tech', 'AMZN': 'Tech', 'AMD': 'Tech', 'TSLA': 'Tech',
    'INTC': 'Tech', 'QCOM': 'Tech',
    'JPM': 'Finance', 'GS': 'Finance', 'BAC': 'Finance',
    'WFC': 'Finance', 'MS': 'Finance', 'C': 'Finance',
    'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'SLB': 'Energy',
    'JNJ': 'Health', 'PFE': 'Health', 'MRNA': 'Health',
    'UNH': 'Health', 'LLY': 'Health', 'ABBV': 'Health',
    'BA': 'Industrial', 'CAT': 'Industrial', 'GE': 'Industrial', 'HON': 'Industrial',
    'WMT': 'Consumer', 'TGT': 'Consumer', 'COST': 'Consumer',
    'SPG': 'Real Estate', 'AMT': 'Real Estate', 'PLD': 'Real Estate',
    'NEE': 'Utilities', 'DUK': 'Utilities', 'SO': 'Utilities',
    'LIN': 'Materials', 'APD': 'Materials', 'NEM': 'Materials',
}


def _score_article(article: dict) -> float:
    relevance = article.get('relevance', 'MEDIUM')
    sentiment = article.get('sentiment', 'Neutral')
    if relevance == 'IGNORE':
        return 0.0
    weight = 2.0 if relevance == 'HIGH' else 1.0
    if sentiment == 'Bullish':
        return weight
    elif sentiment == 'Bearish':
        return -weight
    return 0.0


@router.get('/sentiment')
async def get_sentiment():
    now = datetime.now(timezone.utc)
    cutoff_30m = (now - timedelta(minutes=30)).isoformat()

    all_articles = db.get_articles_since(hours=2)
    last_30m = [a for a in all_articles if a.get('published_at', '') >= cutoff_30m]

    def _overall(arts: list) -> float:
        if not arts:
            return 0.0
        total = sum(_score_article(a) for a in arts)
        count = len(arts)
        return max(-100.0, min(100.0, (total / count) * 50))

    overall_now = _overall(all_articles)
    overall_30m = _overall(last_30m)
    velocity    = round(overall_now - overall_30m, 2)

    watchlist = db.get_watchlist()
    per_ticker = {}
    for ticker in watchlist:
        tickers_field = a.get('tickers', [])
        ticker_arts = [
            a for a in all_articles
            if ticker in (tickers_field if isinstance(tickers_field, list) else json.loads(tickers_field or '[]'))
            for tickers_field in [a.get('tickers', [])]
        ]
        per_ticker[ticker] = round(_overall(ticker_arts), 2)

    return {
        'overall':    round(overall_now, 2),
        'velocity':   velocity,
        'per_ticker': per_ticker,
        'timestamp':  now.isoformat(),
    }


@router.get('/heatmap')
async def get_heatmap():
    articles = db.get_articles_since(hours=2)
    sector_scores: dict = {}
    sector_counts: dict = {}

    for article in articles:
        tickers_field = article.get('tickers', [])
        if isinstance(tickers_field, list):
            tickers = tickers_field
        else:
            try:
                tickers = json.loads(tickers_field or '[]')
            except Exception:
                tickers = []
        score = _score_article(article)
        for ticker in tickers:
            sector = TICKER_SECTOR.get(ticker)
            if sector:
                sector_scores[sector] = sector_scores.get(sector, 0.0) + score
                sector_counts[sector] = sector_counts.get(sector, 0) + 1

    heatmap = {}
    for sector, total in sector_scores.items():
        count = sector_counts.get(sector, 1)
        heatmap[sector] = round(max(-100.0, min(100.0, (total / count) * 50)), 2)

    return heatmap


@router.get('/narrative')
async def get_narrative():
    raw = db.get_ai_cache('macro_narrative')
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            return {'content': raw, 'generated_at': None}
    return {'content': 'Generating narrative...', 'generated_at': None}


@router.get('/wsb')
async def get_wsb():
    now = datetime.now(timezone.utc)
    if (_wsb_cache['data'] is not None and _wsb_cache['updated_at'] is not None
            and (now - _wsb_cache['updated_at']).total_seconds() < 900):
        return _wsb_cache['data']

    await update_wsb_sentiment()
    return _wsb_cache['data'] or []


async def update_wsb_sentiment() -> None:
    """Fetch WSB Reddit sentiment. Called by scheduler every 15min."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get('https://dashboard.nbshare.io/api/v1/apps/reddit')
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                top20 = data[:20]
            elif isinstance(data, dict):
                top20 = (
                    data.get('data', data.get('tickers', data.get('results', [])))[:20]
                )
            else:
                top20 = []
            _wsb_cache['data']       = top20
            _wsb_cache['updated_at'] = datetime.now(timezone.utc)
            logger.info(f'[analysis] WSB cache updated: {len(top20)} tickers.')
    except Exception as e:
        logger.warning(f'[analysis] WSB fetch error: {e}')
        if _wsb_cache['data'] is None:
            _wsb_cache['data'] = []


async def generate_macro_narrative() -> None:
    """Build 4-sentence macro narrative via Gemini. Called by scheduler every 30min."""
    gemini_key = config.get('gemini_key', '')
    if not gemini_key:
        logger.warning('[analysis] No Gemini key — skipping narrative generation.')
        return

    import google.generativeai as genai
    genai.configure(api_key=gemini_key)  # fix: configure at call-time

    articles = db.get_latest_articles(limit=50, relevance_filter=None)
    high_med = [a for a in articles if a.get('relevance') in ('HIGH', 'MEDIUM')]
    headlines = '\n'.join(f"- {a['title']}" for a in high_med[:50])

    prompt = f"""Based on these recent financial headlines, write a macro market
narrative for a US equity day trader in exactly 4 sentences.
Then on a new line write the market regime as exactly one of:
RISK-ON | RISK-OFF | EVENT-DRIVEN | CHOPPY

Headlines:
{headlines}"""

    try:
        model = genai.GenerativeModel('gemini-2.0-flash')
        loop = asyncio.get_running_loop()  # fix: get_running_loop
        response = await loop.run_in_executor(None, lambda: model.generate_content(prompt))
        if not response.text:
            logger.warning('[analysis] Gemini returned empty narrative.')
            return
        text = response.text.strip()
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        regime_line = lines[-1] if lines else 'CHOPPY'
        valid_regimes = {'RISK-ON', 'RISK-OFF', 'EVENT-DRIVEN', 'CHOPPY'}
        regime = regime_line if regime_line in valid_regimes else 'CHOPPY'
        narrative_lines = lines[:-1] if regime_line in valid_regimes else lines
        narrative = ' '.join(narrative_lines)

        result = json.dumps({
            'narrative':    narrative,
            'regime':       regime,
            'generated_at': datetime.now(timezone.utc).isoformat(),
        })
        db.set_ai_cache('macro_narrative', result)
        logger.info(f'[analysis] Macro narrative updated. Regime: {regime}')
    except Exception as e:
        logger.error(f'[analysis] Narrative generation error: {e}')
