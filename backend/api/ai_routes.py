import json
import logging
import re
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from data import config, db

logger = logging.getLogger(__name__)
router = APIRouter()

KEYWORD_CACHE_TTL_MINUTES = 15
KEYWORD_MIN_TOTAL = 40  # minimum combined keywords for a refresh to be considered valid


def _strip_json(raw: str) -> str:
    raw = raw.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)
    return raw.strip()


async def _ensure_ollama_ready(url: str, model: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f'{url}/api/tags')
            if r.status_code != 200:
                return False
            models = [m['name'] for m in r.json().get('models', [])]
            return any(m == model or m.startswith(model + ':') for m in models)
    except Exception:
        return False


async def _ollama_generate(prompt: str, url: str, model: str) -> Optional[str]:
    """Call Ollama /api/generate with retries. Returns raw text or None."""
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                r = await client.post(
                    f'{url}/api/generate',
                    json={'model': model, 'prompt': prompt, 'stream': False},
                )
                r.raise_for_status()
                return r.json().get('response', '')
        except Exception as e:
            logger.warning(f'[ai] Ollama attempt {attempt + 1}/3: {e}')
    return None


# ── Keyword context refresh (called by scheduler every 15 min) ────────────────

async def refresh_keywords() -> dict:
    """Ask Ollama to analyse recent headlines and return context-aware keywords.
    Only saves to keyword_cache if total keyword count >= KEYWORD_MIN_TOTAL (40).
    Falls back to the previous cache if the result is too sparse.
    Returns the keyword dict (new or fallback)."""
    url   = config.get('ollama_url',   'http://localhost:11434').rstrip('/')
    model = config.get('ollama_model', 'phi4-mini')

    if not await _ensure_ollama_ready(url, model):
        logger.warning('[ai] refresh_keywords: Ollama not ready, skipping.')
        return db.get_latest_keywords() or {}

    # Get recent headlines to give Ollama context about what is happening NOW
    recent = db.get_articles_since(hours=2)
    headlines = [a.get('title', '') for a in recent[:40] if a.get('title')]
    headlines_text = '\n'.join(f'- {h}' for h in headlines) if headlines else '(no recent headlines yet)'

    prompt = f"""You are a financial news scoring assistant for a US equity day-trading platform.
Below are up to 40 recent market news headlines from the last 2 hours.

Based on these headlines, identify the currently most market-moving topics and keywords.
Return ONLY a compact JSON object — no explanation, no markdown:
{{
  "high_kw":    ["keyword1", "keyword2", ...],   // 15-20 words/phrases, HIGH relevance right now
  "medium_kw":  ["keyword1", "keyword2", ...],   // 15-20 words/phrases, MEDIUM relevance
  "low_kw":     ["keyword1", "keyword2", ...],   // 10-15 words/phrases, LOW relevance
  "context_note": "One-sentence summary of current market regime (e.g. risk-off, rate fears, earnings season)"
}}

Guidelines:
- You MUST return at least 15 high_kw, 15 medium_kw, and 10 low_kw entries. This is required.
- Focus on what is CURRENTLY driving price action today, not general evergreen terms.
- Do NOT include generic words already obvious from any day (e.g. 'stock', 'market', 'company').
- Prefer specific topics visible in the headlines: tickers, events, macro catalysts, geopolitical themes.
- Fill remaining slots with the most relevant evergreen financial terms if headlines are sparse.
- All keywords lowercase.

Recent headlines:
{headlines_text}

JSON only:"""

    raw = await _ollama_generate(prompt, url, model)
    if not raw:
        logger.warning('[ai] refresh_keywords: no response from Ollama.')
        return db.get_latest_keywords() or {}

    try:
        data = json.loads(_strip_json(raw))
        high   = [str(k).lower() for k in data.get('high_kw',   []) if k]
        medium = [str(k).lower() for k in data.get('medium_kw', []) if k]
        low    = [str(k).lower() for k in data.get('low_kw',    []) if k]
        note   = str(data.get('context_note', ''))

        total = len(high) + len(medium) + len(low)
        if total < KEYWORD_MIN_TOTAL:
            # Result is too sparse — keep the previous cache, do not overwrite
            prev = db.get_latest_keywords()
            logger.warning(
                f'[ai] refresh_keywords: only {total} keywords returned '
                f'({len(high)}H/{len(medium)}M/{len(low)}L) — '
                f'threshold is {KEYWORD_MIN_TOTAL}. Keeping previous cache.'
            )
            return prev or {}

        db.save_keywords(high, medium, low, note)
        logger.info(
            f'[ai] Keywords refreshed: {len(high)}H/{len(medium)}M/{len(low)}L '
            f'(total {total}) | {note}'
        )
        return {'high_kw': high, 'medium_kw': medium, 'low_kw': low, 'context_note': note}
    except Exception as e:
        logger.warning(f'[ai] refresh_keywords JSON parse failed: {e} | raw={raw[:200]}')
        return db.get_latest_keywords() or {}


# ── HTTP endpoints ────────────────────────────────────────────────────────────

@router.post('/keyword-context')
async def post_keyword_context():
    """Manually trigger an immediate keyword refresh and return the result."""
    result = await refresh_keywords()
    if not result:
        return JSONResponse({'error': 'Keyword refresh failed — check Ollama status'}, status_code=503)
    return result


@router.get('/keyword-context')
async def get_keyword_context():
    """Return the latest cached keyword context without triggering a refresh."""
    kw = db.get_latest_keywords()
    if not kw:
        return JSONResponse({'error': 'No keyword context yet — trigger a refresh first'}, status_code=404)
    return kw


@router.post('/chat')
async def chat(payload: dict):
    url   = config.get('ollama_url',   'http://localhost:11434').rstrip('/')
    model = config.get('ollama_model', 'phi4-mini')

    if not await _ensure_ollama_ready(url, model):
        return JSONResponse({'error': 'Ollama not ready'}, status_code=503)

    recent   = db.get_articles_since(hours=4)
    context  = '\n'.join(f"- [{a.get('relevance')}] {a.get('title','')}" for a in recent[:20])
    question = payload.get('message', '')

    kw = db.get_latest_keywords()
    regime_note = f"\nCurrent market regime: {kw['context_note']}" if kw and kw.get('context_note') else ''

    prompt = f"""You are a concise financial news analyst for a US equity day-trading platform.{regime_note}
Recent headlines (last 4h):
{context}

User: {question}
Assistant:"""

    response = await _ollama_generate(prompt, url, model)
    if response is None:
        return JSONResponse({'error': 'Ollama generate failed after 3 attempts'}, status_code=503)
    return {'response': response}


@router.post('/premarket-brief')
async def premarket_brief():
    url   = config.get('ollama_url',   'http://localhost:11434').rstrip('/')
    model = config.get('ollama_model', 'phi4-mini')

    if not await _ensure_ollama_ready(url, model):
        return JSONResponse({'error': 'Ollama not ready'}, status_code=503)

    articles = db.get_articles_since(hours=12)
    if not articles:
        return {'brief': 'No articles available for briefing.'}

    headlines = '\n'.join(f"- [{a.get('relevance')}][{a.get('sentiment')}] {a.get('title','')}" for a in articles[:30])
    kw = db.get_latest_keywords()
    regime_note = f"\nCurrent market regime: {kw['context_note']}" if kw and kw.get('context_note') else ''

    prompt = f"""You are a financial analyst. Write a concise pre-market briefing (max 150 words) for a US equity day trader.{regime_note}
Recent news headlines:
{headlines}

Brief:"""

    response = await _ollama_generate(prompt, url, model)
    if response is None:
        return JSONResponse({'error': 'Ollama generate failed'}, status_code=503)
    return {'brief': response}


@router.get('/macro-narrative')
async def macro_narrative():
    url   = config.get('ollama_url',   'http://localhost:11434').rstrip('/')
    model = config.get('ollama_model', 'phi4-mini')

    if not await _ensure_ollama_ready(url, model):
        return JSONResponse({'error': 'Ollama not ready'}, status_code=503)

    articles = db.get_articles_since(hours=6)
    if not articles:
        return {'narrative': 'No data available.'}

    headlines = '\n'.join(f"- {a.get('title','')}" for a in articles[:25])
    prompt = f"""Summarise the macro market narrative in 2-3 sentences based on these headlines:\n{headlines}\n\nNarrative:"""

    response = await _ollama_generate(prompt, url, model)
    if response is None:
        return JSONResponse({'error': 'Ollama generate failed'}, status_code=503)
    return {'narrative': response}


@router.post('/bull-bear')
async def bull_bear(payload: dict):
    url   = config.get('ollama_url',   'http://localhost:11434').rstrip('/')
    model = config.get('ollama_model', 'phi4-mini')
    ticker = payload.get('ticker', 'SPY').upper()

    if not await _ensure_ollama_ready(url, model):
        return JSONResponse({'error': 'Ollama not ready'}, status_code=503)

    articles = db.get_articles_for_ticker(ticker)
    if not articles:
        return {'bull': 'No data.', 'bear': 'No data.'}

    headlines = '\n'.join(f"- [{a.get('sentiment')}] {a.get('title','')}" for a in articles[:20])
    prompt = f"""For the ticker {ticker}, list 2-3 bull case points and 2-3 bear case points based on these headlines (be concise):\n{headlines}\n\nBull:\n"""

    response = await _ollama_generate(prompt, url, model)
    if response is None:
        return JSONResponse({'error': 'Ollama generate failed'}, status_code=503)

    parts  = response.split('Bear:')
    bull_t = parts[0].replace('Bull:', '').strip() if parts else response
    bear_t = parts[1].strip() if len(parts) > 1 else ''
    return {'bull': bull_t, 'bear': bear_t}
