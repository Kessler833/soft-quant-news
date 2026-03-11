import asyncio
import logging
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()


class KeysPayload(BaseModel):
    finnhub_key:         str = ''
    alpaca_key:          str = ''
    alpaca_secret:       str = ''
    marketaux_token:     str = ''
    newsapi_key:         str = ''
    ingest_interval_sec: int = 90
    local_llm_url:       str = ''
    local_llm_model:     str = ''


async def _validate_finnhub(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://finnhub.io/api/v1/news?category=general&token={key}&limit=1')
            return r.status_code == 200
    except: return False


async def _validate_alpaca(key: str, secret: str) -> bool:
    if not key or not secret: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get('https://paper-api.alpaca.markets/v2/account',
                            headers={'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret})
            return r.status_code == 200
    except: return False


async def _validate_marketaux(token: str) -> bool:
    if not token: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://api.marketaux.com/v1/news/all?api_token={token}&limit=1')
            return r.status_code == 200
    except: return False


async def _validate_newsapi(key: str) -> bool:
    if not key: return False
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f'https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey={key}')
            return r.status_code == 200
    except: return False


async def _post_key_tasks() -> None:
    from backend.api.feed import refresh_keywords, ingest_all_sources
    kw = db.get_latest_keywords()
    if not kw:
        logger.info('[health] No keyword cache — triggering refresh.')
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
        'newsapi_key':         payload.newsapi_key,
        'ingest_interval_sec': payload.ingest_interval_sec,
        'local_llm_url':       payload.local_llm_url,
        'local_llm_model':     payload.local_llm_model,
    }
    config.set_keys(keys_dict)

    validated = {
        'finnhub':   await _validate_finnhub(payload.finnhub_key),
        'alpaca':    await _validate_alpaca(payload.alpaca_key, payload.alpaca_secret),
        'marketaux': await _validate_marketaux(payload.marketaux_token),
        'newsapi':   await _validate_newsapi(payload.newsapi_key),
    }

    try:
        from backend.main import scheduler
        job = scheduler.get_job('ingest')
        if job:
            from apscheduler.triggers.interval import IntervalTrigger
            job.reschedule(trigger=IntervalTrigger(seconds=payload.ingest_interval_sec))
            logger.info(f'[health] Ingest interval updated to {payload.ingest_interval_sec}s')
    except Exception as e:
        logger.warning(f'[health] Could not reschedule ingest: {e}')

    asyncio.create_task(_post_key_tasks())
    logger.info(f'[health] Keys stored. Validation: {validated}')
    return {'status': 'ok', 'validated': validated}


@router.post('/health/reset-cache')
async def reset_cache():
    db.reset_article_cache()
    logger.info('[health] Article cache reset by user.')
    return {'status': 'ok', 'message': 'Cache cleared. Watchlist and API keys preserved.'}


@router.get('/health')
async def get_health():
    return {'status': 'ok'}


@router.get('/health/local-ai')
async def local_ai_health():
    from backend.api.local_ai import check_health
    return await check_health()
