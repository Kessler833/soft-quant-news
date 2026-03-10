import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data import db
from backend.api import health, feed, analysis, watchlist, prices, calendar, ai_routes, polymarket, websocket

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(application: FastAPI):
    db.init_db()
    logger.info('[main] Database initialised.')

    from backend.api.feed import ingest_all_sources
    from backend.api.polymarket import update_polymarket
    from backend.api.analysis import generate_macro_narrative
    from backend.api.ai_routes import generate_premarket_brief

    # ── Scheduled jobs ────────────────────────────────────────────────────
    scheduler.add_job(ingest_all_sources,       'interval', seconds=60,   id='ingest')
    scheduler.add_job(update_polymarket,         'interval', seconds=300,  id='polymarket')
    scheduler.add_job(generate_macro_narrative,  'interval', seconds=1800, id='macro_narrative')
    scheduler.add_job(
        generate_premarket_brief,
        'cron', hour=7, minute=0,
        timezone='UTC', id='premarket_brief'
    )
    scheduler.start()
    logger.info('[main] Scheduler started.')

    # ── Immediate startup run (don't wait for first cron tick) ────────────
    import asyncio
    async def _startup_tasks():
        logger.info('[main] Running startup ingest...')
        try:
            await ingest_all_sources()
        except Exception as e:
            logger.warning(f'[main] Startup ingest error: {e}')
        logger.info('[main] Running startup polymarket update...')
        try:
            await update_polymarket()
        except Exception as e:
            logger.warning(f'[main] Startup polymarket error: {e}')
        logger.info('[main] Running startup macro narrative...')
        try:
            await generate_macro_narrative()
        except Exception as e:
            logger.warning(f'[main] Startup macro narrative error: {e}')
        # Only generate brief if none cached yet
        if not db.get_ai_cache('premarket_brief'):
            logger.info('[main] No cached brief — generating now...')
            try:
                await generate_premarket_brief()
            except Exception as e:
                logger.warning(f'[main] Startup brief error: {e}')

    asyncio.create_task(_startup_tasks())

    yield

    scheduler.shutdown(wait=False)
    logger.info('[main] Scheduler stopped.')


app = FastAPI(title='soft-quant-news', lifespan=lifespan)

# CORS — MUST be added before any routers
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Routers
app.include_router(health.router,     prefix='/api')
app.include_router(feed.router,       prefix='/api/feed')
app.include_router(analysis.router,   prefix='/api/analysis')
app.include_router(watchlist.router,  prefix='/api/watchlist')
app.include_router(prices.router,     prefix='/api/prices')
app.include_router(calendar.router,   prefix='/api/calendar')
app.include_router(ai_routes.router,  prefix='/api/ai')
app.include_router(polymarket.router, prefix='/api/polymarket')
app.include_router(websocket.router)
