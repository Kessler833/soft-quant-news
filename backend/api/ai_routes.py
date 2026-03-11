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


# ── Unified AI call: local first, Groq, then Gemini ──────────────────────────

async def _local_llm_call(prompt_text: str) -> str:
    """Call local LLM using the local_ai engine with robust JSON handling."""
    from backend.api.local_ai import _call_local
    return await _call_local(
        system_prompt="You are a financial analyst. Always respond with the exact format requested. If JSON is requested, return raw valid JSON only — no markdown, no explanation.",
        user_prompt=prompt_text,
        max_tokens=2048,
        temperature=0.2,
    )


async def _ai_call(prompt_text: str) -> str:
    """Call local LLM first, then Groq, then Gemini."""
    local_url  = config.get('local_llm_url', '')
    groq_key   = config.get('groq_key', '')
    gemini_key = config.get('gemini_key', '')

    if local_url:
        try:
            return await _local_llm_call(prompt_text)
        except Exception as e:
            logger.warning(f'[ai] Local LLM failed ({e}), trying next provider...')

    if groq_key:
        return await _groq_call(prompt_text, groq_key)
    elif gemini_key:
        return await _gemini_call(prompt_text, gemini_key)
    else:
        raise ValueError('No AI API key configured. Add a Groq key in Synchro.')


async def _groq_call(prompt_text: str, groq_key: str) -> str:
    import httpx
    backoff = [5, 15, 30]
    async with _ai_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    r = await client.post(
                        'https://api.groq.com/openai/v1/chat/completions',
                        headers={
                            'Authorization': f'Bearer {groq_key}',
                            'Content-Type': 'application/json',
                        },
                        json={
                            'model': 'llama-3.3-70b-versatile',
                            'messages': [{'role': 'user', 'content': prompt_text}],
                            'temperature': 0.2,
                            'max_tokens': 2048,
                        }
                    )
                if r.status_code == 429:
                    if delay:
                        logger.warning(f'[ai] Groq rate limited, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                        continue
                    else:
                        raise RuntimeError('Groq rate limit exhausted after retries')
                r.raise_for_status()
                return r.json()['choices'][0]['message']['content'].strip()
            except Exception as e:
                if delay:
                    logger.warning(f'[ai] Groq error ({e}), retrying in {delay}s...')
                    await asyncio.sleep(delay)
                else:
                    raise
    raise RuntimeError('Groq call failed')


async def _gemini_call(prompt_text: str, gemini_key: str) -> str:
    import google.generativeai as genai
    genai.configure(api_key=gemini_key)
    backoff = [2, 4, 8]
    async with _ai_sem:
        for attempt, delay in enumerate(backoff + [None]):
            try:
                try:
                    model = genai.GenerativeModel('gemini-2.0-flash')
                except Exception:
                    model = genai.GenerativeModel('gemini-1.5-flash')
                loop = asyncio.get_running_loop()
                response = await loop.run_in_executor(
                    None, lambda: model.generate_content(prompt_text)
                )
                if not response.text:
                    raise ValueError('Empty Gemini response')
                return response.text
            except Exception as e:
                err = type(e).__name__
                if 'ResourceExhausted' in err or '429' in str(e):
                    if delay:
                        logger.warning(f'[ai] Gemini rate limited, retrying in {delay}s...')
                        await asyncio.sleep(delay)
                        continue
                    else:
                        raise
                else:
                    raise
    raise RuntimeError('Gemini call failed')


def _strip_json(raw: str) -> str:
    """Remove markdown code fences if present, with robust fallback."""
    from backend.api.local_ai import repair_json
    parsed = repair_json(raw)
    if parsed is not None:
        return json.dumps(parsed)
    # Fallback to original strip behavior
    text = raw.strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-z]*\n?', '', text)
        text = re.sub(r'```$', '', text).strip()
    return text


# ── Pre-market brief ──────────────────────────────────────────────────────────

async def generate_premarket_brief() -> None:
    groq_key   = config.get('groq_key', '')
    gemini_key = config.get('gemini_key', '')
    local_url  = config.get('local_llm_url', '')
    if not groq_key and not gemini_key and not local_url:
        logger.warning('[ai] No AI configured — skipping pre-market brief.')
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
{headlines if headlines else 'No headlines yet — market just opened or feed is starting.'}

Today's events:
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
        'market_bias': 'Neutral', 'bias_rationale': 'No AI key configured or still generating.',
        'tickers_to_watch': [], 'generated_at': None
    }


@router.post('/premarket-brief')
async def trigger_premarket_brief():
    asyncio.create_task(generate_premarket_brief())
    return {'status': 'generating'}


@router.get('/macro-narrative')
async def get_macro_narrative():
    raw = db.get_ai_cache('macro_narrative')
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            return {'narrative': raw, 'regime': 'NEUTRAL', 'generated_at': None}
    return {'narrative': 'Generating on startup...', 'regime': 'NEUTRAL', 'generated_at': None}


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
{headlines if headlines else 'No specific headlines found — base on general knowledge.'}"""

    try:
        raw  = await _ai_call(prompt)
        return json.loads(_strip_json(raw))
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
