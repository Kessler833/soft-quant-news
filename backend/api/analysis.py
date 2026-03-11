import json
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter

from data import db

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
        ticker_arts = [
            a for a in all_articles
            if ticker in (a.get('tickers') if isinstance(a.get('tickers'), list)
                          else json.loads(a.get('tickers', '[]')))
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
