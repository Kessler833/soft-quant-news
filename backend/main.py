import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

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
    # Startup
    db.init_db()
    logger.info('[main] Database initialised.')

    # Import scheduler jobs (imported here to avoid circular imports)
    from backend.api.feed import ingest_all_sources
    from backend.api.polymarket import update_polymarket
    from backend.api.analysis import update_wsb_sentiment, generate_macro_narrative
    from backend.api.ai_routes import generate_premarket_brief

    scheduler.add_job(ingest_all_sources,        'interval', seconds=60,   id='ingest')
    scheduler.add_job(update_polymarket,         'interval', seconds=300,  id='polymarket')
    scheduler.add_job(update_wsb_sentiment,      'interval', seconds=900,  id='wsb')
    scheduler.add_job(generate_macro_narrative,  'interval', seconds=1800, id='macro_narrative')
    scheduler.add_job(
        generate_premarket_brief,
        'cron', hour=7, minute=0,
        timezone='UTC', id='premarket_brief'
    )
    scheduler.start()
    logger.info('[main] Scheduler started.')

    yield

    # Shutdown
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
app.include_router(health.router,      prefix='/api')
app.include_router(feed.router,        prefix='/api/feed')
app.include_router(analysis.router,    prefix='/api/analysis')
app.include_router(watchlist.router,   prefix='/api/watchlist')
app.include_router(prices.router,      prefix='/api/prices')
app.include_router(calendar.router,    prefix='/api/calendar')
app.include_router(ai_routes.router,   prefix='/api/ai')
app.include_router(polymarket.router,  prefix='/api/polymarket')
app.include_router(websocket.router)


@app.get('/api/health')
async def health_ping():
    """Electron waitForBackend polling endpoint."""
    return {'status': 'ok'}
