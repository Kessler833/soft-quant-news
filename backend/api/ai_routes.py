import asyncio
import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_ai_sem = asyncio.Semaphore(5)


# ── Local LLM ──────────────────────────────────────────────────────────────────

async def _local_llm_call(prompt_text: str) -> str:
    from backend.api.local_ai import _call_local
    return await _call_local(
        system_prompt="You are a financial analyst. Always respond with the exact format requested. If JSON is requested, return raw valid JSON only — no markdown, no explanation.",
        user_prompt=prompt_text,
        max_tokens=2048,
        temperature=0.2,
    )


async def _ai_call(prompt_text: str) -> str:
    """Call the local LLM. Raises ValueError if not configured."""
    local_url = config.get('local_llm_url', '')
    if not local_url:
        raise ValueError('Local AI not configured. Set Ollama URL in Synchro.')
    return await _local_llm_call(prompt_text)


def _strip_json(raw: str) -> str:
    from backend.api.local_ai import repair_json
    parsed = repair_json(raw)
    if parsed is not None:
        return json.dumps(parsed)
    text = raw.strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-z]*\n?', '', text)
        text = re.sub(r'```$', '', text).strip()
    return text


# ── Pre-market brief ──────────────────────────────────────────────────────────

async def generate_premarket_brief() -> None:
    local_url = config.get('local_llm_url', '')
    if not local_url:
        logger.warning('[ai] Local AI not configured — skipping pre-market brief.')
        return

    articles  = db.get_articles_since(hours=12)
    high_med  = [a for a in articles if a.get('relevance') in ('HIGH', 'MEDIUM')]
    headlines = '\n'.join(f"- {a['title']}" for a in high_med[:60])

    from backend.api.calendar import get_events
    try:
        events_raw = await get_events()
        events_str = '\n'.join(
            f"- {e['name']} at {e.get('datetime_cet','')[:16]} CET (importance: {e['importance']})"
            for e in events_raw
        )
    except Exception:
        events_str = 'Calendar unavailable'

    prompt = f"""Generate a structured pre-market brief for a US equity day trader.
Return ONLY this exact JSON, no markdown:
{{
  "top_catalysts": [{{"ticker":"","headline":"","impact":""}}],
  "key_events_today": [{{"time_cet":"","event":"","importance":""}}],
  "sectors_to_watch": [{{"sector":"","reason":""}}],
  "market_bias": "Bullish" or "Bearish" or "Neutral",
  "bias_rationale": "2 sentence explanation",
  "tickers_to_watch": [{{"ticker":"","reason":""}}],
  "generated_at": "{datetime.now(timezone.utc).isoformat()}"
}}

Recent headlines:
{headlines if headlines else 'No headlines yet.'}

Today\'s events:
{events_str}"""

    try:
        raw    = await _ai_call(prompt)
        parsed = json.loads(_strip_json(raw))
        db.set_ai_cache('premarket_brief', json.dumps(parsed))
        logger.info('[ai] Pre-market brief generated.')
    except Exception as e:
        logger.error(f'[ai] Pre-market brief error: {e}')


async def generate_macro_narrative() -> None:
    from backend.api.analysis import generate_macro_narrative as _gen
    await _gen()


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get('/premarket-brief')
async def get_premarket_brief():
    raw = db.get_ai_cache('premarket_brief')
    if raw:
        try: return json.loads(raw)
        except Exception: pass
    await generate_premarket_brief()
    raw = db.get_ai_cache('premarket_brief')
    if raw:
        try: return json.loads(raw)
        except Exception: pass
    return {
        'top_catalysts': [], 'key_events_today': [], 'sectors_to_watch': [],
        'market_bias': 'Neutral', 'bias_rationale': 'Local AI not configured or still generating.',
        'tickers_to_watch': [], 'generated_at': None,
    }


@router.post('/premarket-brief')
async def trigger_premarket_brief():
    asyncio.create_task(generate_premarket_brief())
    return {'status': 'generating'}


@router.get('/macro-narrative')
async def get_macro_narrative():
    raw = db.get_ai_cache('macro_narrative')
    if raw:
        try: return json.loads(raw)
        except Exception: return {'narrative': raw, 'regime': 'NEUTRAL', 'generated_at': None}
    return {'narrative': 'Generating on startup...', 'regime': 'NEUTRAL', 'generated_at': None}


class ChatRequest(BaseModel):
    question: str
    context_hours: int = 4


@router.post('/chat')
async def ai_chat(body: ChatRequest):
    articles  = db.get_articles_since(body.context_hours)
    headlines = '\n'.join(f"- {a['title']}" for a in articles[:80])
    prompt = f"""You are a financial news analyst for a US day trader.
Answer this question based ONLY on the headlines provided. Be concise and trader-focused.

Question: {body.question}

Headlines:
{headlines if headlines else 'No headlines available yet.'}

If the headlines lack enough info, say so clearly."""
    try:
        answer = await _ai_call(prompt)
        return {'answer': answer.strip(), 'sources_used': len(articles)}
    except Exception as e:
        logger.error(f'[ai] Chat error: {e}')
        return {'answer': f'Error: {e}', 'sources_used': 0}


class BullBearRequest(BaseModel):
    ticker: str


@router.post('/bull-bear')
async def ai_bull_bear(body: BullBearRequest):
    ticker    = body.ticker.upper().strip()
    articles  = db.get_articles_for_ticker(ticker)
    headlines = '\n'.join(f"- {a['title']}" for a in articles[:30])
    prompt = f"""Based on today's news about {ticker}, generate bull and bear cases.
Return ONLY this JSON, no markdown:
{{
  "ticker": "{ticker}",
  "bull_case": ["point1","point2","point3"],
  "bear_case": ["point1","point2","point3"],
  "overall_lean": "Bullish" or "Bearish" or "Neutral",
  "confidence": "High" or "Medium" or "Low"
}}

Headlines about {ticker}:
{headlines if headlines else 'No specific headlines found.'}"""
    try:
        raw = await _ai_call(prompt)
        return json.loads(_strip_json(raw))
    except json.JSONDecodeError:
        return {'ticker': ticker, 'bull_case': [], 'bear_case': [], 'overall_lean': 'Neutral', 'confidence': 'Low'}
    except Exception as e:
        logger.error(f'[ai] Bull/bear error: {e}')
        return {'ticker': ticker, 'bull_case': [], 'bear_case': [], 'overall_lean': 'Neutral', 'confidence': 'Low'}
