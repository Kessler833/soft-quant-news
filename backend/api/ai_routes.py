# ai_routes.py — Groq and Gemini removed. AI features require Ollama (local).
# The /api/ai/* routes are kept as stubs returning empty/neutral responses
# so the frontend doesn't crash on any existing fetch calls.

import logging
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get('/premarket-brief')
async def get_premarket_brief():
    return {
        'top_catalysts': [], 'key_events_today': [], 'sectors_to_watch': [],
        'market_bias': 'Neutral', 'bias_rationale': 'AI features use local Ollama only.',
        'tickers_to_watch': [], 'generated_at': None,
    }


@router.get('/macro-narrative')
async def get_macro_narrative():
    return {'narrative': '', 'regime': 'NEUTRAL', 'generated_at': None}


class ChatRequest(BaseModel):
    question: str
    context_hours: int = 4


@router.post('/chat')
async def ai_chat(body: ChatRequest):
    return {'answer': 'AI chat requires Ollama to be running.', 'sources_used': 0}


class BullBearRequest(BaseModel):
    ticker: str


@router.post('/bull-bear')
async def ai_bull_bear(body: BullBearRequest):
    return {
        'ticker': body.ticker.upper(), 'bull_case': [], 'bear_case': [],
        'overall_lean': 'Neutral', 'confidence': 'Low',
    }
