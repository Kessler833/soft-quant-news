import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

_gemini_sem = asyncio.Semaphore(5)


async def _get_gemini_model():
    import google.generativeai as genai
    key = config.get('gemini_key', '')
    if key:
        genai.configure(api_key=key)  # fix: configure at call-time
    try:
        return genai.GenerativeModel('gemini-2.0-flash')
    except Exception:
        return genai.GenerativeModel('gemini-1.5-flash')


async def _gemini_call(prompt_text: str) -> str:
    gemini_key = config.get('gemini_key', '')
    if not gemini_key:
        raise ValueError('Gemini API key not configured')

    backoff = [2, 4, 8]
    async with _gemini_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                model = await _get_gemini_model()
                loop = asyncio.get_running_loop()  # fix: get_running_loop
                response = await loop.run_in_executor(
                    None,
                    lambda: model.generate_content(prompt_text)
                )
                if not response.text:
                    raise ValueError('Empty Gemini response')
                return response.text
            except Exception as e:
                err_name = type(e).__name__
                if 'ResourceExhausted' in err_name or '429' in str(e):
                    if delay:
                        logger.warning(f'[ai] Gemini rate limited, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                    else:
                        raise
                else:
                    raise
    raise RuntimeError('Gemini call failed after all retries')


async def generate_premarket_brief() -> None:
    """Generate structured pre-market brief via Gemini. Called by scheduler at 07:00 UTC."""
    gemini_key = config.get('gemini_key', '')
    if not gemini_key:
        logger.warning('[ai] No Gemini key — skipping pre-market brief.')
        return

    articles = db.get_articles_since(hours=12)
    high_med  = [a for a in articles if a.get('relevance') in ('HIGH', 'MEDIUM')]
    headlines = '\n'.join(f"- {a['title']}" for a in high_med[:60])

    from backend.api.calendar import get_events
    events_raw = await get_events()
    events_str = '\n'.join(
        f"- {e['name']} at {e.get('datetime_cet','')[:16]} CET (importance: {e['importance']})"
        for e in events_raw
    )

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
{headlines}

Today's events:
{events_str}"""

    try:
        raw = await _gemini_call(prompt)
        text = raw.strip()
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        parsed = json.loads(text.strip())
        db.set_ai_cache('premarket_brief', json.dumps(parsed))
        logger.info('[ai] Pre-market brief generated.')
    except Exception as e:
        logger.error(f'[ai] Pre-market brief error: {e}')


async def generate_macro_narrative() -> None:
    """Alias used by main.py scheduler — delegates to analysis module."""
    from backend.api.analysis import generate_macro_narrative as _gen
    await _gen()


# ─── Routes ────────────────────────────────────────────────────────────────

@router.get('/premarket-brief')
async def get_premarket_brief():
    raw = db.get_ai_cache('premarket_brief')
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    await generate_premarket_brief()
    raw = db.get_ai_cache('premarket_brief')
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return {
        'top_catalysts': [], 'key_events_today': [], 'sectors_to_watch': [],
        'market_bias': 'Neutral', 'bias_rationale': 'Generating...',
        'tickers_to_watch': [], 'generated_at': None
    }


@router.get('/macro-narrative')
async def get_macro_narrative():
    raw = db.get_ai_cache('macro_narrative')
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            return {'narrative': raw, 'regime': 'NEUTRAL', 'generated_at': None}
    return {'narrative': 'Generating...', 'regime': 'NEUTRAL', 'generated_at': None}


class ChatRequest(BaseModel):
    question: str
    context_hours: int = 4


@router.post('/chat')
async def ai_chat(body: ChatRequest):
    articles  = db.get_articles_since(body.context_hours)
    headlines = '\n'.join(f"- {a['title']}" for a in articles[:80])

    prompt = f"""You are a financial news analyst for a US day trader.
Answer this question based ONLY on the headlines provided.
Be concise and trader-focused.

Question: {body.question}

Headlines:
{headlines}

If the headlines lack enough info, say so clearly."""

    try:
        answer = await _gemini_call(prompt)
        return {'answer': answer.strip(), 'sources_used': len(articles)}
    except Exception as e:
        logger.error(f'[ai] Chat error: {e}')
        return {'answer': f'Error: {e}', 'sources_used': 0}


class BullBearRequest(BaseModel):
    ticker: str


@router.post('/bull-bear')
async def ai_bull_bear(body: BullBearRequest):
    ticker   = body.ticker.upper().strip()
    articles = db.get_articles_for_ticker(ticker)
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
{headlines}

If no headlines found, base on general market knowledge."""

    try:
        raw = await _gemini_call(prompt)
        text = raw.strip()
        if text.startswith('```'):
            text = text.split('```')[1]
            if text.startswith('json'):
                text = text[4:]
        return json.loads(text.strip())
    except json.JSONDecodeError:
        return {
            'ticker': ticker, 'bull_case': [], 'bear_case': [],
            'overall_lean': 'Neutral', 'confidence': 'Low'
        }
    except Exception as e:
        logger.error(f'[ai] Bull/bear error: {e}')
        return {
            'ticker': ticker, 'bull_case': [], 'bear_case': [],
            'overall_lean': 'Neutral', 'confidence': 'Low'
        }
