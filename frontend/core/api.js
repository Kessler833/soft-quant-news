// API Client — mirrors QuantTERMINAL_OS api.js pattern
// All functions are globally scoped plain async functions.
// No import/export.

const BASE = 'http://localhost:8000'

async function _get(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) {
    let detail = r.statusText
    try { const j = await r.json(); detail = j.detail || j.error || detail } catch (_) {}
    throw new Error(`GET ${path} failed [${r.status}]: ${detail}`)
  }
  return r.json()
}

async function _post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    let detail = r.statusText
    try { const j = await r.json(); detail = j.detail || j.error || detail } catch (_) {}
    throw new Error(`POST ${path} failed [${r.status}]: ${detail}`)
  }
  return r.json()
}

async function _delete(path) {
  const r = await fetch(BASE + path, { method: 'DELETE' })
  if (!r.ok) {
    let detail = r.statusText
    try { const j = await r.json(); detail = j.detail || j.error || detail } catch (_) {}
    throw new Error(`DELETE ${path} failed [${r.status}]: ${detail}`)
  }
  return r.json()
}

// ── Health ───────────────────────────────────────────────────────────────
async function apiHealth(keysObj) {
  return _post('/api/health', keysObj)
}

// ── Feed ─────────────────────────────────────────────────────────────────
async function apiFeedLatest(params = {}) {
  const qs = new URLSearchParams()
  if (params.limit)     qs.set('limit', params.limit)
  if (params.relevance) qs.set('relevance', params.relevance)
  if (params.sentiment) qs.set('sentiment', params.sentiment)
  if (params.catalyst)  qs.set('catalyst', params.catalyst)
  if (params.ticker)    qs.set('ticker', params.ticker)
  const q = qs.toString()
  return _get('/api/feed/latest' + (q ? '?' + q : ''))
}

async function apiFeedTicker(symbol) {
  return _get('/api/feed/ticker/' + encodeURIComponent(symbol))
}

async function apiFeedAll(params = {}) {
  const qs = new URLSearchParams()
  if (params.limit)     qs.set('limit', params.limit || 200)
  if (params.relevance) qs.set('relevance', params.relevance)
  if (params.sentiment) qs.set('sentiment', params.sentiment)
  if (params.catalyst)  qs.set('catalyst', params.catalyst)
  if (params.ticker)    qs.set('ticker', params.ticker)
  const q = qs.toString()
  return _get('/api/feed/all' + (q ? '?' + q : ''))
}

// ── Analysis ─────────────────────────────────────────────────────────────
async function apiAnalysisSentiment() {
  return _get('/api/analysis/sentiment')
}
async function apiAnalysisHeatmap() {
  return _get('/api/analysis/heatmap')
}
async function apiAnalysisNarrative() {
  return _get('/api/analysis/narrative')
}
async function apiAnalysisWsb() {
  return _get('/api/analysis/wsb')
}

// ── Polymarket ────────────────────────────────────────────────────────────
async function apiPolymarkets() {
  return _get('/api/polymarket/markets')
}
async function apiPolymarketAlerts() {
  return _get('/api/polymarket/alerts')
}

// ── Prices ───────────────────────────────────────────────────────────────
async function apiPriceQuote(symbol) {
  return _get('/api/prices/quote?symbol=' + encodeURIComponent(symbol))
}
async function apiPriceBars(symbol, timeframe = '5Min', limit = 100) {
  return _get(
    `/api/prices/bars?symbol=${encodeURIComponent(symbol)}` +
    `&timeframe=${timeframe}&limit=${limit}`
  )
}

// ── Calendar ─────────────────────────────────────────────────────────────
async function apiCalendarEvents() {
  return _get('/api/calendar/events')
}

// ── Watchlist ─────────────────────────────────────────────────────────────
async function apiWatchlistGet() {
  return _get('/api/watchlist/')
}
async function apiWatchlistAdd(ticker) {
  return _post('/api/watchlist/', { ticker })
}
async function apiWatchlistRemove(ticker) {
  return _delete('/api/watchlist/' + encodeURIComponent(ticker))
}

// ── AI ───────────────────────────────────────────────────────────────────
async function apiAiPremarketBrief() {
  return _get('/api/ai/premarket-brief')
}
async function apiAiMacroNarrative() {
  return _get('/api/ai/macro-narrative')
}
async function apiAiChat(question, contextHours = 4) {
  return _post('/api/ai/chat', { question, context_hours: contextHours })
}
async function apiAiBullBear(ticker) {
  return _post('/api/ai/bull-bear', { ticker })
}
