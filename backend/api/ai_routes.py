import json
import logging
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_OFFLINE_MSG = 'Ollama offline — start Ollama and set model in Synchro.'


def _ollama_url() -> str:
    return config.get('ollama_url', 'http://localhost:11434').rstrip('/')


def _ollama_model() -> str:
    return config.get('ollama_model', 'llama3')


async def _ollama_generate(prompt: str) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            _ollama_url() + '/api/generate',
            json={'model': _ollama_model(), 'prompt': prompt, 'stream': False},
        )
        r.raise_for_status()
        return r.json().get('response', '')


def _cache_fresh(key: str, max_age_minutes: int) -> dict | None:
    raw = db.get_ai_cache(key)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        gen = data.get('generated_at')
        if not gen:
            return None
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(gen)).total_seconds() / 60
        return data if age < max_age_minutes else None
    except Exception:
        return None


def _article_lines(articles: list, limit: int = 20) -> str:
    lines = []
    for a in articles[:limit]:
        rel  = a.get('relevance', 'LOW')
        sent = a.get('sentiment', 'Neutral')
        title = a.get('title', '')
        lines.append(f'[{rel}][{sent}] {title}')
    return '\n'.join(lines)


# ── GET /premarket-brief ─────────────────────────────────────────────────

async def _build_premarket_brief() -> dict:
    articles = db.get_articles_since(hours=4)
    if not articles:
        return {
            'top_catalysts': [], 'key_events_today': [], 'sectors_to_watch': [],
            'market_bias': 'Neutral', 'bias_rationale': 'No recent articles available.',
            'tickers_to_watch': [], 'generated_at': datetime.now(timezone.utc).isoformat(),
        }

    context = _article_lines(articles, limit=30)
    prompt = f"""You are a professional equity market analyst. Based on the following recent news headlines, produce a pre-market brief.

Headlines (format: [RELEVANCE][SENTIMENT] title):
{context}

Respond ONLY with valid JSON matching this exact schema (no markdown, no explanation):
{{
  "market_bias": "Bullish" | "Bearish" | "Neutral",
  "bias_rationale": "<1-2 sentence rationale>",
  "key_events_today": ["<event>", ...],
  "sectors_to_watch": ["<sector>", ...],
  "top_catalysts": [
    {{"ticker": "<TICKER or MACRO>", "headline": "<short headline>", "impact": "HIGH" | "MEDIUM" | "LOW"}}
  ],
  "tickers_to_watch": [
    {{"ticker": "<TICKER>"}}
  ]
}}"""

    try:
        text = await _ollama_generate(prompt)
        # Strip possible markdown fences
        text = text.strip()
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        data = json.loads(text)
        data['generated_at'] = datetime.now(timezone.utc).isoformat()
        db.set_ai_cache('premarket-brief', json.dumps(data))
        return data
    except Exception as e:
        logger.warning(f'[ai] premarket-brief error: {e}')
        return {
            'top_catalysts': [], 'key_events_today': [], 'sectors_to_watch': [],
            'market_bias': 'Neutral', 'bias_rationale': _OFFLINE_MSG,
            'tickers_to_watch': [], 'generated_at': datetime.now(timezone.utc).isoformat(),
            'error': _OFFLINE_MSG,
        }


@router.get('/premarket-brief')
async def get_premarket_brief():
    cached = _cache_fresh('premarket-brief', max_age_minutes=30)
    if cached:
        return cached
    return await _build_premarket_brief()


@router.post('/premarket-brief')
async def post_premarket_brief():
    return await _build_premarket_brief()


# ── GET /macro-narrative ─────────────────────────────────────────────────

@router.get('/macro-narrative')
async def get_macro_narrative():
    cached = _cache_fresh('macro-narrative', max_age_minutes=60)
    if cached:
        return cached

    articles = db.get_articles_since(hours=8)
    if not articles:
        return {'narrative': 'No recent data.', 'regime': 'NEUTRAL', 'generated_at': datetime.now(timezone.utc).isoformat()}

    context = _article_lines(articles, limit=40)
    prompt = f"""You are a macro strategist. Based on the recent news below, determine the current macro regime.

Headlines:
{context}

Respond ONLY with valid JSON (no markdown):
{{
  "regime": "RISK_ON" | "RISK_OFF" | "NEUTRAL",
  "narrative": "<2-4 sentence macro narrative>"
}}"""

    try:
        text = await _ollama_generate(prompt)
        text = text.strip()
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        data = json.loads(text)
        data['generated_at'] = datetime.now(timezone.utc).isoformat()
        db.set_ai_cache('macro-narrative', json.dumps(data))
        return data
    except Exception as e:
        logger.warning(f'[ai] macro-narrative error: {e}')
        return {'narrative': _OFFLINE_MSG, 'regime': 'NEUTRAL',
                'generated_at': datetime.now(timezone.utc).isoformat(), 'error': _OFFLINE_MSG}


# ── POST /chat ──────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    question: str
    context_hours: int = 4


@router.post('/chat')
async def ai_chat(body: ChatRequest):
    articles = db.get_articles_since(hours=body.context_hours)
    context = _article_lines(articles, limit=20)
    sources_used = min(len(articles), 20)

    if not articles:
        return {'answer': 'No recent news articles available to answer your question.', 'sources_used': 0}

    prompt = f"""You are a financial news assistant. Answer the user's question using ONLY the news context provided. Be concise and direct.

News context (last {body.context_hours}h, format: [RELEVANCE][SENTIMENT] title):
{context}

User question: {body.question}

Answer:"""

    try:
        answer = await _ollama_generate(prompt)
        return {'answer': answer.strip(), 'sources_used': sources_used}
    except Exception as e:
        logger.warning(f'[ai] chat error: {e}')
        return {'answer': _OFFLINE_MSG, 'sources_used': 0, 'error': _OFFLINE_MSG}


# ── POST /bull-bear ──────────────────────────────────────────────────────────

class BullBearRequest(BaseModel):
    ticker: str


@router.post('/bull-bear')
async def ai_bull_bear(body: BullBearRequest):
    ticker = body.ticker.upper()
    articles = db.get_articles_for_ticker(ticker)

    if not articles:
        return {
            'ticker': ticker, 'bull_case': [], 'bear_case': [],
            'overall_lean': 'Neutral', 'confidence': 'Low',
            'error': f'No recent news found for {ticker}.',
        }

    context = _article_lines(articles, limit=20)
    prompt = f"""You are an equity analyst. Based only on the news headlines below for {ticker}, produce a bull/bear analysis.

Headlines:
{context}

Respond ONLY with valid JSON (no markdown):
{{
  "bull_case": ["<bullet point>", ...],
  "bear_case": ["<bullet point>", ...],
  "overall_lean": "Bullish" | "Bearish" | "Neutral",
  "confidence": "High" | "Medium" | "Low"
}}"""

    try:
        text = await _ollama_generate(prompt)
        text = text.strip()
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        data = json.loads(text)
        data['ticker'] = ticker
        return data
    except Exception as e:
        logger.warning(f'[ai] bull-bear error: {e}')
        return {
            'ticker': ticker, 'bull_case': [], 'bear_case': [],
            'overall_lean': 'Neutral', 'confidence': 'Low', 'error': _OFFLINE_MSG,
        }
