import re
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from data import db

logger = logging.getLogger(__name__)
router = APIRouter()

_TICKER_RE = re.compile(r'^[A-Z]{1,5}$')


class TickerPayload(BaseModel):
    ticker: str


@router.get('/')
async def get_watchlist():
    return db.get_watchlist()


@router.post('/')
async def add_ticker(payload: TickerPayload):
    ticker = payload.ticker.upper().strip()
    if not _TICKER_RE.match(ticker):
        raise HTTPException(status_code=422, detail=f'Invalid ticker: {ticker}')
    db.add_to_watchlist(ticker)
    logger.info(f'[watchlist] Added: {ticker}')
    return {'status': 'ok', 'ticker': ticker}


@router.delete('/{ticker}')
async def remove_ticker(ticker: str):
    ticker = ticker.upper().strip()
    db.remove_from_watchlist(ticker)
    logger.info(f'[watchlist] Removed: {ticker}')
    return {'status': 'ok', 'ticker': ticker}
