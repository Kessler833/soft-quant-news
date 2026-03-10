import logging
from typing import Optional

from fastapi import APIRouter
from data import config

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_client():
    key    = config.get('alpaca_key', '')
    secret = config.get('alpaca_secret', '')
    if not key or not secret:
        return None, None
    from alpaca.data.historical import StockHistoricalDataClient
    return StockHistoricalDataClient(api_key=key, secret_key=secret), (key, secret)


async def get_quote_price(symbol: str) -> Optional[float]:
    """Helper used by drift tracking in feed.py."""
    try:
        from alpaca.data.requests import StockLatestQuoteRequest
        from alpaca.data.enums import DataFeed
        client, creds = _get_client()
        if client is None:
            return None
        req = StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=DataFeed.IEX)
        quote = client.get_stock_latest_quote(req)
        q = quote.get(symbol)
        if q:
            return float((q.ask_price + q.bid_price) / 2)
        return None
    except Exception as e:
        logger.warning(f'[prices] get_quote_price({symbol}) error: {e}')
        return None


@router.get('/quote')
async def get_quote(symbol: str = 'SPY'):
    key = config.get('alpaca_key', '')
    if not key:
        return {'error': 'Alpaca keys not configured'}
    try:
        from alpaca.data.requests import StockLatestQuoteRequest
        from alpaca.data.enums import DataFeed
        client, _ = _get_client()
        req = StockLatestQuoteRequest(
            symbol_or_symbols=symbol.upper(),
            feed=DataFeed.IEX
        )
        quote_data = client.get_stock_latest_quote(req)
        q = quote_data.get(symbol.upper())
        if not q:
            return {'error': f'No quote data for {symbol}'}
        mid = (q.ask_price + q.bid_price) / 2
        return {
            'symbol':    symbol.upper(),
            'price':     round(float(mid), 4),
            'bid':       round(float(q.bid_price), 4),
            'ask':       round(float(q.ask_price), 4),
            'timestamp': q.timestamp.isoformat() if q.timestamp else None,
        }
    except Exception as e:
        logger.error(f'[prices] quote error: {e}')
        return {'error': str(e)}


@router.get('/bars')
async def get_bars(
    symbol: str = 'SPY',
    timeframe: str = '5Min',
    limit: int = 100,
):
    key = config.get('alpaca_key', '')
    if not key:
        return {'error': 'Alpaca keys not configured'}
    try:
        from alpaca.data.requests import StockBarsRequest
        from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
        from alpaca.data.enums import DataFeed

        tf_map = {
            '1Min':  TimeFrame(1,  TimeFrameUnit.Minute),
            '5Min':  TimeFrame(5,  TimeFrameUnit.Minute),
            '15Min': TimeFrame(15, TimeFrameUnit.Minute),
            '1Hour': TimeFrame(1,  TimeFrameUnit.Hour),
            '1Day':  TimeFrame(1,  TimeFrameUnit.Day),
        }
        tf = tf_map.get(timeframe, TimeFrame(5, TimeFrameUnit.Minute))
        client, _ = _get_client()
        req = StockBarsRequest(
            symbol_or_symbols=symbol.upper(),
            timeframe=tf,
            limit=limit,
            feed=DataFeed.IEX,
        )
        bars_data = client.get_stock_bars(req)
        bars = bars_data.get(symbol.upper(), [])
        return [
            {
                't': b.timestamp.isoformat(),
                'o': round(float(b.open),  4),
                'h': round(float(b.high),  4),
                'l': round(float(b.low),   4),
                'c': round(float(b.close), 4),
                'v': int(b.volume),
            }
            for b in bars
        ]
    except Exception as e:
        logger.error(f'[prices] bars error: {e}')
        return {'error': str(e)}
