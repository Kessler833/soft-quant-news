import asyncio
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter

from data import db

logger = logging.getLogger(__name__)
router = APIRouter()

TRADING_KEYWORDS = [
    'Fed', 'rate', 'recession', 'CPI', 'inflation', 'tariff',
    'GDP', 'unemployment', 'S&P', 'earnings', 'FOMC', 'jobs',
    'treasury', 'dollar', 'yield', 'interest',
]

POLYMARKET_HEADERS = {
    'Accept':     'application/json',
    'User-Agent': 'soft-quant-news/1.0',
}


def _matches_keywords(question: str) -> bool:
    q_lower = question.lower()
    return any(kw.lower() in q_lower for kw in TRADING_KEYWORDS)


async def update_polymarket() -> None:
    """Fetch active Polymarket markets, filter for trading-relevant ones. Called by scheduler."""
    try:
        async with httpx.AsyncClient(timeout=15, headers=POLYMARKET_HEADERS) as client:
            r = await client.get(
                'https://gamma-api.polymarket.com/markets?active=true&limit=100'
            )
            r.raise_for_status()
            markets = r.json()
    except Exception as e:
        logger.warning(f'[polymarket] Fetch error (non-fatal): {e}')
        return

    if not isinstance(markets, list):
        markets = markets.get('markets', markets.get('results', []))

    # Get existing stored markets for prev_probability
    existing = {m['id']: m for m in db.get_polymarket_markets()}

    filtered = []
    for m in markets:
        question = m.get('question', '') or m.get('title', '')
        if not _matches_keywords(question):
            continue

        # Extract probability — Polymarket returns outcomePrices or outcomes
        prob = 0.0
        try:
            outcome_prices = m.get('outcomePrices')
            if outcome_prices:
                import json
                prices = json.loads(outcome_prices) if isinstance(outcome_prices, str) else outcome_prices
                if prices and len(prices) > 0:
                    prob = float(prices[0])
            elif 'probability' in m:
                prob = float(m['probability'])
        except Exception:
            prob = 0.0

        volume = 0.0
        try:
            volume = float(m.get('volume', m.get('volumeNum', 0)) or 0)
        except Exception:
            volume = 0.0

        market_id = str(m.get('id', m.get('conditionId', '')))
        prev_prob  = existing.get(market_id, {}).get('probability', prob)

        filtered.append({
            'id':               market_id,
            'question':         question,
            'probability':      round(prob, 4),
            'volume':           round(volume, 2),
            'prev_probability': round(prev_prob, 4),
        })

    # Top 20 by volume
    filtered.sort(key=lambda x: x['volume'], reverse=True)
    top20 = filtered[:20]

    if top20:
        db.save_polymarket_markets(top20)
        logger.info(f'[polymarket] Saved {len(top20)} markets.')
    else:
        logger.info('[polymarket] No trading-relevant markets found this cycle.')


@router.get('/markets')
async def get_markets():
    return db.get_polymarket_markets()


@router.get('/alerts')
async def get_alerts():
    return db.get_polymarket_alerts(threshold=0.05)
