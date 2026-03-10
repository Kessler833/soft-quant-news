import asyncio
import logging
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()


class KeysPayload(BaseModel):
    finnhub_key: str = ''
    alpaca_key: str = ''
    alpaca_secret: str = ''
    marketaux_token: str = ''
    groq_key: str = ''
    benzinga_key: str = ''
    newsapi_key: str = ''
    stockgeist_token: str = ''
    groq_rpm: int = 25
    ingest_interval_sec: int = 90


async def _validate_finnhub(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://finnhub.io/api/v1/news?category=general&token={key}&limit=1')
            return r.status_code == 200
    except Exception:
        return False


async def _validate_alpaca(key: str, secret: str) -> bool:
    if not key or not secret: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get('https://paper-api.alpaca.markets/v2/account',
                            headers={'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret})
            return r.status_code == 200
    except Exception:
        return False


async def _validate_marketaux(token: str) -> bool:
    if not token: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://api.marketaux.com/v1/news/all?api_token={token}&limit=1')
            return r.status_code == 200
    except Exception:
        return False


async def _validate_groq(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get('https://api.groq.com/openai/v1/models',
                            headers={'Authorization': f'Bearer {key}'})
            return r.status_code == 200
    except Exception:
        return False


async def _validate_newsapi(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey={key}')
            return r.status_code == 200
    except Exception:
        return False


async def _validate_benzinga(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://api.benzinga.com/api/v2/news?token={key}&pageSize=1')
            return r.status_code == 200
    except Exception:
        return False


async def _post_key_tasks(groq_key: str) -> None:
    """Run after keys are stored: refresh keywords if no cache exists, then ingest."""
    from backend.api.feed import refresh_keywords, ingest_all_sources

    if groq_key:
        kw = db.get_latest_keywords()
        if not kw:
            logger.info('[health] No keyword cache — triggering immediate refresh.')
            await refresh_keywords(force=True)
        else:
            logger.info('[health] Keyword cache exists — skipping forced refresh.')

    await ingest_all_sources()


@router.post('/health')
async def post_health(payload: KeysPayload):
    keys_dict = {
        'finnhub_key':         payload.finnhub_key,
        'alpaca_key':          payload.alpaca_key,
        'alpaca_secret':       payload.alpaca_secret,
        'marketaux_token':     payload.marketaux_token,
        'groq_key':            payload.groq_key,
        'benzinga_key':        payload.benzinga_key,
        'newsapi_key':         payload.newsapi_key,
        'stockgeist_token':    payload.stockgeist_token,
        'groq_rpm':            payload.groq_rpm,
        'ingest_interval_sec': payload.ingest_interval_sec,
    }
    config.set_keys(keys_dict)

    validated = {
        'finnhub':   await _validate_finnhub(payload.finnhub_key),
        'alpaca':    await _validate_alpaca(payload.alpaca_key, payload.alpaca_secret),
        'marketaux': await _validate_marketaux(payload.marketaux_token),
        'groq':      await _validate_groq(payload.groq_key),
        'benzinga':  await _validate_benzinga(payload.benzinga_key),
        'newsapi':   await _validate_newsapi(payload.newsapi_key),
    }

    # Reschedule ingest interval if changed
    try:
        from backend.main import scheduler
        job = scheduler.get_job('ingest_all_sources')
        if job:
            from apscheduler.triggers.interval import IntervalTrigger
            job.reschedule(trigger=IntervalTrigger(seconds=payload.ingest_interval_sec))
            logger.info(f'[health] Ingest interval updated to {payload.ingest_interval_sec}s')
    except Exception as e:
        logger.warning(f'[health] Could not reschedule ingest: {e}')

    # Fire keyword refresh + ingest in background now that keys are available
    asyncio.create_task(_post_key_tasks(payload.groq_key))

    logger.info(f'[health] Keys stored. Validation: {validated}')
    return {'status': 'ok', 'validated': validated}


@router.get('/health')
async def get_health():
    return {'status': 'ok'}
