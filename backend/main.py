import logging
import asyncio
from contextlib import asynccontextmanager

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data import db, config
from backend.api import health, feed, analysis, watchlist, prices, calendar, polymarket, websocket, ai_routes

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()

DEFAULT_MODEL = 'phi4-mini'
KEYWORD_REFRESH_INTERVAL = 15 * 60   # 15 minutes in seconds
INGEST_INTERVAL          = 60        # Finnhub poll every 60 seconds


async def _ensure_model_pulled(model: str = DEFAULT_MODEL) -> None:
    url = config.get('ollama_url', 'http://localhost:11434').rstrip('/')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f'{url}/api/tags')
            if r.status_code == 200:
                installed = [m['name'] for m in r.json().get('models', [])]
                already_present = any(
                    m == model or m.startswith(model + ':')
                    for m in installed
                )
                if already_present:
                    logger.info(f'[main] Model "{model}" already installed, skipping pull.')
                    return

        logger.info(f'[main] Model "{model}" not found \u2014 pulling now (this may take a few minutes)...')
        async with httpx.AsyncClient(timeout=600) as client:
            async with client.stream(
                'POST',
                f'{url}/api/pull',
                json={'name': model, 'stream': True},
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line:
                        logger.info(f'[ollama pull] {line}')
        logger.info(f'[main] Model "{model}" pulled successfully.')
    except Exception as e:
        logger.warning(f'[main] Could not pull model "{model}": {e}. '
                       'Make sure Ollama is running before using AI features.')


async def _warm_model(model: str = DEFAULT_MODEL) -> None:
    """Send a minimal generate request so Ollama loads the model weights into RAM."""
    url = config.get('ollama_url', 'http://localhost:11434').rstrip('/')
    logger.info(f'[main] Pre-warming model "{model}" into RAM...')
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                f'{url}/api/generate',
                json={'model': model, 'prompt': 'hi', 'stream': False},
            )
            r.raise_for_status()
        logger.info(f'[main] Model "{model}" is warm and ready.')
    except Exception as e:
        logger.warning(f'[main] Model warm-up failed (non-fatal): {e}')


@asynccontextmanager
async def lifespan(application: FastAPI):
    db.init_db()
    logger.info('[main] Database initialised.')

    from backend.api.feed import ingest_all_sources
    from backend.api.polymarket import update_polymarket
    from backend.api.ai_routes import refresh_keywords

    # Finnhub: every 60 seconds
    scheduler.add_job(ingest_all_sources, 'interval', seconds=INGEST_INTERVAL,         id='ingest_all_sources')
    # Polymarket: every 5 minutes
    scheduler.add_job(update_polymarket,  'interval', seconds=300,                      id='update_polymarket')
    # AI keyword refresh: every 15 minutes
    scheduler.add_job(refresh_keywords,   'interval', seconds=KEYWORD_REFRESH_INTERVAL, id='refresh_keywords')
    scheduler.start()
    logger.info('[main] Scheduler started.')

    async def _startup_tasks():
        logger.info('[main] Running startup tasks...')
        model = config.get('ollama_model', DEFAULT_MODEL)
        # 1. Pull model if not present
        await _ensure_model_pulled(model)
        # 2. Pre-warm: load model weights into RAM so first user request is instant
        await _warm_model(model)
        # 3. Initial keyword generation so scorer has context from first ingest
        try: await refresh_keywords()
        except Exception as e: logger.warning(f'[main] Startup keyword refresh: {e}')
        # 4. Polymarket
        try: await update_polymarket()
        except Exception as e: logger.warning(f'[main] Startup polymarket: {e}')
        # 5. First news ingest
        try: await ingest_all_sources()
        except Exception as e: logger.warning(f'[main] Startup ingest: {e}')

    asyncio.create_task(_startup_tasks())
    yield
    scheduler.shutdown(wait=False)
    logger.info('[main] Scheduler stopped.')


app = FastAPI(title='soft-quant-news', lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])

app.include_router(health.router,      prefix='/api')
app.include_router(feed.router,        prefix='/api/feed')
app.include_router(analysis.router,    prefix='/api/analysis')
app.include_router(watchlist.router,   prefix='/api/watchlist')
app.include_router(prices.router,      prefix='/api/prices')
app.include_router(calendar.router,    prefix='/api/calendar')
app.include_router(polymarket.router,  prefix='/api/polymarket')
app.include_router(ai_routes.router,   prefix='/api/ai')
app.include_router(websocket.router)
