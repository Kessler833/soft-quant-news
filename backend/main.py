import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data import db
from backend.api import health, feed, analysis, watchlist, prices, calendar, polymarket, websocket

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(application: FastAPI):
    db.init_db()
    logger.info('[main] Database initialised.')

    from backend.api.feed import ingest_all_sources
    from backend.api.polymarket import update_polymarket

    scheduler.add_job(ingest_all_sources, 'interval', seconds=60,  id='ingest_all_sources')
    scheduler.add_job(update_polymarket,  'interval', seconds=300, id='update_polymarket')
    scheduler.start()
    logger.info('[main] Scheduler started.')

    import asyncio
    async def _startup_tasks():
        logger.info('[main] Running startup tasks...')
        try: await update_polymarket()
        except Exception as e: logger.warning(f'[main] Startup polymarket: {e}')

    asyncio.create_task(_startup_tasks())
    yield
    scheduler.shutdown(wait=False)
    logger.info('[main] Scheduler stopped.')


app = FastAPI(title='soft-quant-news', lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])

app.include_router(health.router,     prefix='/api')
app.include_router(feed.router,       prefix='/api/feed')
app.include_router(analysis.router,   prefix='/api/analysis')
app.include_router(watchlist.router,  prefix='/api/watchlist')
app.include_router(prices.router,     prefix='/api/prices')
app.include_router(calendar.router,   prefix='/api/calendar')
app.include_router(polymarket.router, prefix='/api/polymarket')
app.include_router(websocket.router)
