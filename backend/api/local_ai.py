"""
Local AI Engine — self-contained news grading via Ollama.
Handles: article grading, market context generation, robust JSON parsing.
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone

import httpx

from data import config, db

logger = logging.getLogger(__name__)

_local_sem = asyncio.Semaphore(2)  # Allow 2 concurrent local LLM calls

SYSTEM_PROMPT_GRADING = (
    "You are a financial news classifier for a US equity day trader. "
    "Always respond with raw valid JSON only. No markdown, no explanation, "
    "no text outside the JSON. Never use code fences."
)

SYSTEM_PROMPT_CONTEXT = (
    "You are a financial market analyst. "
    "Always respond with raw valid JSON only. No markdown, no explanation, "
    "no text outside the JSON. Never use code fences."
)


def _get_endpoint() -> str:
    """Build the OpenAI-compatible chat completions URL from config."""
    url = config.get('local_llm_url', '')
    if not url:
        return ''
    endpoint = url.rstrip('/')
    if not endpoint.endswith('/v1/chat/completions'):
        endpoint += '/v1/chat/completions'
    return endpoint


def _get_model() -> str:
    return config.get('local_llm_model', 'qwen2.5:3b')


# ── Robust JSON parsing ─────────────────────────────────────────────────────

def repair_json(raw: str) -> object:
    """
    Attempt to parse JSON from LLM output, with multiple repair strategies:
    1. Direct parse
    2. Strip markdown fences
    3. Find first [ or { and last ] or }, parse that substring
    4. Regex extract individual JSON objects from an array response
    """
    text = raw.strip()

    # Strategy 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: strip markdown fences
    cleaned = text
    if cleaned.startswith('```'):
        cleaned = re.sub(r'^```[a-z]*\n?', '', cleaned)
        cleaned = re.sub(r'```\s*$', '', cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass

    # Strategy 3: find the JSON body by brackets
    for open_ch, close_ch in [('[', ']'), ('{', '}')]:
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end != -1 and end > start:
            candidate = text[start:end + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass

    # Strategy 4: extract individual {...} objects for array responses
    objects = []
    for match in re.finditer(r'\{[^{}]*\}', text):
        try:
            objects.append(json.loads(match.group()))
        except json.JSONDecodeError:
            pass
    if objects:
        return objects

    # All strategies failed
    logger.warning(f'[local_ai] JSON repair failed. Raw (first 200 chars): {text[:200]}')
    return None


# ── Local LLM call ───────────────────────────────────────────────────────────

async def _call_local(system_prompt: str, user_prompt: str, max_tokens: int = 2048, temperature: float = 0.1) -> str:
    """Make a call to the local Ollama-compatible LLM with system/user split."""
    endpoint = _get_endpoint()
    if not endpoint:
        raise ConnectionError('No local LLM URL configured')

    model = _get_model()

    async with _local_sem:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                endpoint,
                json={
                    'model': model,
                    'messages': [
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_prompt},
                    ],
                    'temperature': temperature,
                    'max_tokens': max_tokens,
                    'stream': False,
                },
            )
            r.raise_for_status()
            return r.json()['choices'][0]['message']['content'].strip()


# ── Article grading ──────────────────────────────────────────────────────────

async def grade_batch(batch: list) -> list:
    """Grade a batch of articles using the local LLM. Returns list of dicts or []."""
    if not batch:
        return []
    endpoint = _get_endpoint()
    if not endpoint:
        return []

    # Load current market context (if any) to inject into the prompt
    context_report = db.get_ai_cache('market_context')
    context_block = ''
    if context_report:
        try:
            ctx = json.loads(context_report)
            context_block = f"""
Current market context (auto-generated from recent news):
- Themes: {ctx.get('themes', 'Unknown')}
- Hot sectors: {', '.join(ctx.get('hot_sectors', []))}
- Key tickers: {', '.join(ctx.get('key_tickers', []))}
- Regime: {ctx.get('regime', 'Unknown')}
Use this context to improve your grading accuracy.
"""
        except Exception:
            pass

    headlines_json = json.dumps(
        [{'id': a['id'], 'title': a['title'], 'source': a['source']} for a in batch],
        ensure_ascii=False,
    )

    user_prompt = f"""Grade each headline for a US equity day trader.
{context_block}
For EACH headline return one object in a JSON array:
- "id": exact id string
- "relevance": "HIGH" | "MEDIUM" | "LOW" | "IGNORE"
- "tickers": array of affected US stock symbols e.g. ["SPY","NVDA"]
- "sentiment": "Bullish" | "Bearish" | "Neutral"
- "impact_score": integer 1-10
- "catalyst_type": "Earnings"|"Fed"|"Macro"|"Analyst"|"M&A"|"Regulatory"|"Geopolitical"|"Other"
- "summary": one trader-focused sentence (empty string if IGNORE or LOW)

Input:
{headlines_json}"""

    try:
        t0 = time.time()
        raw = await _call_local(SYSTEM_PROMPT_GRADING, user_prompt, max_tokens=2048)
        elapsed = round(time.time() - t0, 1)
        logger.info(f'[local_ai] Graded batch of {len(batch)} in {elapsed}s')

        parsed = repair_json(raw)
        if parsed is None:
            return []
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            return []
        # Validate each item has at least 'id' and 'relevance'
        return [item for item in parsed if isinstance(item, dict) and 'id' in item]
    except Exception as e:
        logger.warning(f'[local_ai] grade_batch failed: {e}')
        return []


# ── Self-generated market context ────────────────────────────────────────────

async def generate_market_context() -> None:
    """
    Generate a market context report from recent HIGH/MEDIUM articles.
    This is injected into future grading prompts so the local model stays
    aware of current market conditions — no cloud calls needed.
    """
    endpoint = _get_endpoint()
    if not endpoint:
        logger.info('[local_ai] No local LLM — skipping context generation.')
        return

    articles = db.get_articles_since(hours=2)
    high_med = [a for a in articles if a.get('relevance') in ('HIGH', 'MEDIUM')]
    if len(high_med) < 3:
        logger.info(f'[local_ai] Only {len(high_med)} HIGH/MED articles — skipping context gen.')
        return

    headlines = '\n'.join(f"- [{a.get('relevance')}] {a['title']}" for a in high_med[:40])

    user_prompt = f"""Based on these recent graded financial headlines, generate a market context summary.

Headlines:
{headlines}

Return this JSON:
{{"themes": "2-3 sentence summary of dominant market themes right now",
"hot_sectors": ["sector1", "sector2", "sector3"],
"key_tickers": ["TICKER1", "TICKER2", "TICKER3", "TICKER4", "TICKER5"],
"regime": "RISK-ON" or "RISK-OFF" or "EVENT-DRIVEN" or "CHOPPY",
"generated_at": "{datetime.now(timezone.utc).isoformat()}"}}"""

    try:
        t0 = time.time()
        raw = await _call_local(SYSTEM_PROMPT_CONTEXT, user_prompt, max_tokens=512, temperature=0.2)
        elapsed = round(time.time() - t0, 1)

        parsed = repair_json(raw)
        if parsed and isinstance(parsed, dict):
            db.set_ai_cache('market_context', json.dumps(parsed))
            logger.info(f'[local_ai] Market context updated in {elapsed}s. Regime: {parsed.get("regime", "?")}')
        else:
            logger.warning('[local_ai] Context generation returned unparseable JSON.')
    except Exception as e:
        logger.warning(f'[local_ai] Context generation failed: {e}')


# ── Keyword generation (local replacement for Groq keyword refresh) ──────────

async def generate_keywords_local() -> bool:
    """Generate filter keywords using the local LLM. Returns True if successful."""
    endpoint = _get_endpoint()
    if not endpoint:
        return False

    # Include market context if available
    context_report = db.get_ai_cache('market_context')
    context_block = ''
    if context_report:
        try:
            ctx = json.loads(context_report)
            context_block = f"\nCurrent market context: {ctx.get('themes', '')}\nHot sectors: {', '.join(ctx.get('hot_sectors', []))}\n"
        except Exception:
            pass

    user_prompt = f"""Generate keyword lists for filtering US equity financial news headlines.
{context_block}
Return this JSON:
{{"high": ["keyword1","keyword2",...],
"medium": ["keyword1","keyword2",...],
"low": ["keyword1","keyword2",...],
"context_note": "one sentence describing current market regime"}}

HIGH = 20-25 keywords/phrases for genuinely market-moving events.
MEDIUM = 20-25 keywords for relevant but non-urgent news.
LOW = 10-15 keywords for marginally relevant news."""

    try:
        raw = await _call_local(SYSTEM_PROMPT_CONTEXT, user_prompt, max_tokens=1024, temperature=0.3)
        parsed = repair_json(raw)
        if parsed and isinstance(parsed, dict) and 'high' in parsed:
            db.save_keywords(
                parsed.get('high', []),
                parsed.get('medium', []),
                parsed.get('low', []),
                parsed.get('context_note', ''),
            )
            logger.info('[local_ai] Keywords generated locally.')
            return True
    except Exception as e:
        logger.warning(f'[local_ai] Local keyword generation failed: {e}')
    return False


# ── Health check ─────────────────────────────────────────────────────────────

async def check_health() -> dict:
    """Check if local LLM is reachable. Returns status dict."""
    endpoint = _get_endpoint()
    if not endpoint:
        return {'status': 'not_configured', 'model': None}

    base_url = config.get('local_llm_url', '').rstrip('/')
    model = _get_model()

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f'{base_url}/v1/models')
            if r.status_code == 200:
                return {'status': 'online', 'model': model}
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f'{base_url}/api/tags')
            if r.status_code == 200:
                tags = r.json()
                models = [m.get('name', '') for m in tags.get('models', [])]
                has_model = any(model in m for m in models)
                return {
                    'status': 'online' if has_model else 'model_missing',
                    'model': model,
                    'available_models': models[:5],
                }
    except Exception:
        pass

    return {'status': 'offline', 'model': model}
