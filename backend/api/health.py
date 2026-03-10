import logging
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from data import config

logger = logging.getLogger(__name__)
router = APIRouter()


class KeysPayload(BaseModel):
    finnhub_key: str = ''
    alpaca_key: str = ''
    alpaca_secret: str = ''
    marketaux_token: str = ''
    gemini_key: str = ''
    benzinga_key: str = ''
    newsapi_key: str = ''
    stockgeist_token: str = ''


async def _validate_finnhub(key: str) -> bool:
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f'https://finnhub.io/api/v1/news?category=general&token={key}&limit=1'
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_alpaca(key: str, secret: str) -> bool:
    if not key or not secret:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                'https://paper-api.alpaca.markets/v2/account',
                headers={'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret}
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_marketaux(token: str) -> bool:
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f'https://api.marketaux.com/v1/news/all?api_token={token}&limit=1'
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_gemini(key: str) -> bool:
    """Validate by listing models — no generation call, no rate limit burn."""
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f'https://generativelanguage.googleapis.com/v1beta/models?key={key}'
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_benzinga(key: str) -> bool:
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f'https://api.benzinga.com/api/v2/news?token={key}&pageSize=1'
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_newsapi(key: str) -> bool:
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f'https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey={key}'
            )
            return r.status_code == 200
    except Exception:
        return False


async def _validate_stockgeist(token: str) -> bool:
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                f'https://api.stockgeist.ai/stock/en/hist/meta-message?symbols=SPY&token={token}'
            )
            return r.status_code == 200
    except Exception:
        return False


@router.post('/health')
async def post_health(payload: KeysPayload):
    keys_dict = {
        'finnhub_key':       payload.finnhub_key,
        'alpaca_key':        payload.alpaca_key,
        'alpaca_secret':     payload.alpaca_secret,
        'marketaux_token':   payload.marketaux_token,
        'gemini_key':        payload.gemini_key,
        'benzinga_key':      payload.benzinga_key,
        'newsapi_key':       payload.newsapi_key,
        'stockgeist_token':  payload.stockgeist_token,
    }
    config.set_keys(keys_dict)

    # Pre-configure Gemini SDK globally if key provided
    if payload.gemini_key:
        try:
            import google.generativeai as genai
            genai.configure(api_key=payload.gemini_key)
        except Exception as e:
            logger.warning(f'[health] Gemini configure failed: {e}')

    validated = {
        'finnhub':    await _validate_finnhub(payload.finnhub_key),
        'alpaca':     await _validate_alpaca(payload.alpaca_key, payload.alpaca_secret),
        'marketaux':  await _validate_marketaux(payload.marketaux_token),
        'gemini':     await _validate_gemini(payload.gemini_key),
        'benzinga':   await _validate_benzinga(payload.benzinga_key),
        'newsapi':    await _validate_newsapi(payload.newsapi_key),
        'stockgeist': await _validate_stockgeist(payload.stockgeist_token),
    }

    logger.info(f'[health] Keys stored. Validation: {validated}')
    return {'status': 'ok', 'validated': validated}


@router.get('/health')
async def get_health():
    return {'status': 'ok'}
