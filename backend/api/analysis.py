import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

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
    if relevance == 'IGNORE': return 0.0
    weight = 2.0 if relevance == 'HIGH' else 1.0
    if sentiment == 'Bullish':  return weight
    elif sentiment == 'Bearish': return -weight
    return 0.0


@router.get('/sentiment')
async def get_sentiment():
    now = datetime.now(timezone.utc)
    cutoff_30m = (now - timedelta(minutes=30)).isoformat()
    all_articles = db.get_articles_since(hours=2)
    last_30m = [a for a in all_articles if a.get('published_at', '') >= cutoff_30m]

    def _overall(arts):
        if not arts: return 0.0
        return max(-100.0, min(100.0, (sum(_score_article(a) for a in arts) / len(arts)) * 50))

    overall_now = _overall(all_articles)
    overall_30m = _overall(last_30m)
    watchlist = db.get_watchlist()
    per_ticker = {}
    for ticker in watchlist:
        arts = []
        for a in all_articles:
            t = a.get('tickers', [])
            if isinstance(t, str): t = json.loads(t or '[]')
            if ticker in t: arts.append(a)
        per_ticker[ticker] = round(_overall(arts), 2)
    return {'overall': round(overall_now, 2), 'velocity': round(overall_now - overall_30m, 2), 'per_ticker': per_ticker, 'timestamp': now.isoformat()}


@router.get('/wsb')
async def get_wsb(): return []


@router.get('/heatmap')
async def get_heatmap():
    articles = db.get_articles_since(hours=2)
    sector_scores, sector_counts = {}, {}
    for article in articles:
        t = article.get('tickers', [])
        if isinstance(t, list): tickers = t
        else:
            try: tickers = json.loads(t or '[]')
            except: tickers = []
        score = _score_article(article)
        for ticker in tickers:
            sector = TICKER_SECTOR.get(ticker)
            if sector:
                sector_scores[sector] = sector_scores.get(sector, 0.0) + score
                sector_counts[sector] = sector_counts.get(sector, 0) + 1
    return {s: round(max(-100.0, min(100.0, (sector_scores[s] / sector_counts.get(s, 1)) * 50)), 2) for s in sector_scores}


@router.get('/narrative')
async def get_narrative():
    raw = db.get_ai_cache('macro_narrative')
    if raw:
        try: return json.loads(raw)
        except: return {'content': raw, 'generated_at': None}
    return {'content': 'Generating narrative...', 'generated_at': None}


async def generate_macro_narrative() -> None:
    """Build macro narrative via local AI. Called by scheduler every 30min."""
    local_url = config.get('local_llm_url', '')
    if not local_url:
        logger.warning('[analysis] Local AI not configured — skipping narrative.')
        return

    articles = db.get_latest_articles(limit=50)
    high_med = [a for a in articles if a.get('relevance') in ('HIGH', 'MEDIUM')]
    headlines = '\n'.join(f"- {a['title']}" for a in high_med[:50])

    prompt = f"""Based on these recent financial headlines, write a macro market narrative for a US equity day trader in exactly 4 sentences.
Then on a new line write the market regime as exactly one of: RISK-ON | RISK-OFF | EVENT-DRIVEN | CHOPPY

Headlines:
{headlines if headlines else 'No headlines available yet.'}"""

    try:
        from backend.api.ai_routes import _ai_call
        text   = await _ai_call(prompt)
        lines  = [l.strip() for l in text.strip().split('\n') if l.strip()]
        valid  = {'RISK-ON', 'RISK-OFF', 'EVENT-DRIVEN', 'CHOPPY'}
        regime = lines[-1] if lines and lines[-1] in valid else 'CHOPPY'
        narrative_lines = lines[:-1] if lines and lines[-1] in valid else lines
        result = json.dumps({
            'narrative':    ' '.join(narrative_lines),
            'regime':       regime,
            'generated_at': datetime.now(timezone.utc).isoformat(),
        })
        db.set_ai_cache('macro_narrative', result)
        logger.info(f'[analysis] Macro narrative updated. Regime: {regime}')
    except Exception as e:
        logger.error(f'[analysis] Narrative error: {e}')
