// ── API rate caps (free tier, no Groq) ──────────────────────────────────────
const API_CAPS = [
  { id: 'finnhub',   name: 'Finnhub',   rpm: 60,   rpd: null, color: 'var(--accent-orange)', note: 'finnhub.io' },
  { id: 'newsapi',   name: 'NewsAPI',   rpm: null,  rpd: 100,  color: 'var(--accent-purple)', note: 'newsapi.org' },
  { id: 'marketaux', name: 'Marketaux', rpm: null,  rpd: 100,  color: 'var(--accent-green)',  note: 'marketaux.com' },
  { id: 'alpaca',    name: 'Alpaca',    rpm: 200,  rpd: null, color: 'var(--text-primary)',   note: 'Data stream (unlimited news)' },
]

let _synchroInitDone = false

async function initSynchro() {
  if (_synchroInitDone) return
  _synchroInitDone = true

  _synchroLoadFields()
  _rateCalcUpdate()

  document.getElementById('synchro-save-btn')?.addEventListener('click',        _synchroSave)
  document.getElementById('synchro-clear-btn')?.addEventListener('click',       _synchroClearKeys)
  document.getElementById('synchro-check-btn')?.addEventListener('click',       _synchroCheckAll)
  document.getElementById('synchro-reset-cache-btn')?.addEventListener('click', _synchroResetCache)
  document.getElementById('synchro-soft-reset-btn')?.addEventListener('click',  _synchroSoftReset)
  document.getElementById('rate-apply-btn')?.addEventListener('click',          _rateApply)
  document.getElementById('rate-from')?.addEventListener('input',               _rateCalcUpdate)
  document.getElementById('rate-until')?.addEventListener('input',              _rateCalcUpdate)
  document.getElementById('rate-always-on')?.addEventListener('change',         _rateCalcUpdate)

  await _synchroPushKeysToBackend()
  await _synchroCheckAll()
  _synchroLoadStats()

  // Wire Ollama IPC listeners for future events
  _registerOllamaIPC()

  // Catch up with any Ollama events that fired before Synchro was opened
  if (window.electronAPI?.getOllamaState) {
    const state = await window.electronAPI.getOllamaState()
    _applyOllamaState(state)
  }
}

// ── Auto-push keys to backend on launch ───────────────────────────────────

async function _synchroPushKeysToBackend() {
  const keys = QuantCache.loadApiKeys()
  const rate = QuantCache.loadRateSettings()
  const hasAnyKey = Object.values(keys).some(v => v && String(v).trim().length > 0)
  if (!hasAnyKey) return
  try {
    await apiHealth({
      ...keys,
      ingest_interval_sec: rate.intervalSec || 90,
    })
    console.log('[synchro] Keys auto-pushed to backend on launch.')
  } catch (e) {
    console.warn('[synchro] Auto-push failed:', e.message)
    setTimeout(async () => {
      try {
        await apiHealth({ ...keys, ingest_interval_sec: rate.intervalSec || 90 })
        console.log('[synchro] Keys auto-pushed (retry ok).')
      } catch (_) {}
    }, 3000)
  }
}

function _synchroLoadFields() {
  const keys = QuantCache.loadApiKeys()
  const rate = QuantCache.loadRateSettings()
  _set('key-alpaca-key',      keys.alpaca_key      || '')
  _set('key-alpaca-secret',   keys.alpaca_secret   || '')
  _set('key-finnhub',         keys.finnhub_key     || '')
  _set('key-newsapi',         keys.newsapi_key     || '')
  _set('key-marketaux',       keys.marketaux_token || '')
  _set('key-base-url',        keys.base_url        || '')
  _set('key-local-llm-url',   keys.local_llm_url   || '')
  _set('key-local-llm-model', keys.local_llm_model || 'qwen2.5:3b')
  if (rate.from)  _set('rate-from',  rate.from)
  if (rate.until) _set('rate-until', rate.until)
  if (rate.alwaysOn !== undefined) {
    const el = document.getElementById('rate-always-on')
    if (el) el.checked = rate.alwaysOn
  }
}

// ── Ollama inline install IPC ─────────────────────────────────────────────

function _getOllamaEls() {
  return {
    card:      document.getElementById('ollama-installer-card'),
    bar:       document.getElementById('ollama-progress-bar'),
    statusEl:  document.getElementById('ollama-status-text'),
    stepLabel: document.getElementById('ollama-step-label'),
    dots:      ['ollama-dot-1', 'ollama-dot-2', 'ollama-dot-3'].map(id => document.getElementById(id)),
    conns:     ['ollama-conn-1', 'ollama-conn-2'].map(id => document.getElementById(id)),
  }
}

function _ollamaShowCard() {
  const { card } = _getOllamaEls()
  if (card) card.style.display = 'block'
}

function _ollamaSetStep(step) {
  const { dots, conns } = _getOllamaEls()
  dots.forEach((d, i) => {
    if (!d) return
    d.className = 'step-dot' + (i + 1 < step ? ' done' : i + 1 === step ? ' active' : '')
  })
  conns.forEach((c, i) => {
    if (!c) return
    c.className = 'step-connector' + (i + 1 < step ? ' done' : '')
  })
}

// Apply a cached state object (for catch-up on late Synchro open)
function _applyOllamaState(state) {
  if (!state || state.type === 'idle') return
  const { bar, statusEl, stepLabel, card } = _getOllamaEls()

  if (state.type === 'done') {
    // Already finished — show briefly then hide
    _ollamaShowCard()
    _ollamaSetStep(4)
    if (bar)       { bar.style.width = '100%'; bar.style.background = 'var(--accent-green)' }
    if (stepLabel) stepLabel.textContent = 'Ready!'
    if (statusEl)  statusEl.textContent  = 'Local AI is running — all systems go.'
    setTimeout(() => { if (card) card.style.display = 'none' }, 2500)
    return
  }

  if (state.type === 'error') {
    _ollamaShowCard()
    if (bar)       { bar.style.width = '100%'; bar.style.background = 'var(--accent-red)' }
    if (stepLabel) stepLabel.textContent = 'Setup failed'
    if (statusEl)  statusEl.textContent  = `Error: ${state.msg}`
    return
  }

  if (state.type === 'step') {
    _ollamaShowCard()
    _ollamaSetStep(state.step)
    if (stepLabel) stepLabel.textContent = state.label
    if (bar)       { bar.style.width = '2%'; bar.style.background = 'var(--accent-blue)' }
    return
  }

  if (state.type === 'progress') {
    _ollamaShowCard()
    if (bar) bar.style.width = (state.pct || 0) + '%'
    return
  }

  if (state.type === 'status') {
    if (statusEl) statusEl.textContent = state.msg
    return
  }
}

function _registerOllamaIPC() {
  if (!window.electronAPI) return

  window.electronAPI.onOllamaStep(({ step, total, label }) => {
    _ollamaShowCard()
    _ollamaSetStep(step)
    const { bar, stepLabel } = _getOllamaEls()
    if (stepLabel) stepLabel.textContent = label
    if (bar) { bar.style.width = '2%'; bar.style.background = 'var(--accent-blue)' }
  })

  window.electronAPI.onOllamaProgress(({ pct }) => {
    _ollamaShowCard()
    const { bar } = _getOllamaEls()
    if (bar) bar.style.width = pct + '%'
  })

  window.electronAPI.onOllamaStatus(({ msg }) => {
    const { statusEl } = _getOllamaEls()
    if (statusEl) statusEl.textContent = msg
  })

  window.electronAPI.onOllamaDone(() => {
    const { bar, stepLabel, statusEl, card } = _getOllamaEls()
    _ollamaSetStep(4)
    if (bar)       { bar.style.width = '100%'; bar.style.background = 'var(--accent-green)' }
    if (stepLabel) stepLabel.textContent = 'Ready!'
    if (statusEl)  statusEl.textContent  = 'Local AI is running — all systems go.'
    setTimeout(() => { if (card) card.style.display = 'none' }, 3500)
  })

  window.electronAPI.onOllamaError(({ msg }) => {
    const { bar, stepLabel, statusEl } = _getOllamaEls()
    _ollamaShowCard()
    if (bar)       { bar.style.width = '100%'; bar.style.background = 'var(--accent-red)' }
    if (stepLabel) stepLabel.textContent = 'Setup failed'
    if (statusEl)  statusEl.textContent  = `Error: ${msg} — check Ollama URL below and retry.`
    const badge = document.getElementById('local-ai-badge')
    if (badge) { badge.textContent = '● Error'; badge.style.color = 'var(--accent-red)' }
  })
}

// ── Rate Limit Calculator ─────────────────────────────────────────────────────

function _calcApiStats(cap, activeMinutes) {
  const BUFFER = 0.85
  const safeRpm = cap.rpm ? Math.floor(cap.rpm * BUFFER) : null
  const safeRpd = cap.rpd ? Math.floor(cap.rpd * BUFFER) : null
  let intervalSec = safeRpd ? Math.ceil((activeMinutes * 60) / safeRpd) : Math.ceil(60 / safeRpm)
  if (safeRpm) intervalSec = Math.max(intervalSec, Math.ceil(60 / safeRpm))
  const reqPerDay  = Math.floor((activeMinutes * 60) / intervalSec)
  const reqPerHour = Math.floor(3600 / intervalSec)
  const hh = String(Math.floor(intervalSec / 60)).padStart(2, '0')
  const ss = String(intervalSec % 60).padStart(2, '0')
  return { intervalSec, intervalLabel: intervalSec >= 60 ? `${hh}m ${ss}s` : `${intervalSec}s`, reqPerDay, reqPerHour, safeRpm, safeRpd }
}

function _rateCalcUpdate() {
  const alwaysOn  = document.getElementById('rate-always-on')?.checked
  const container = document.getElementById('rate-all-results')
  if (!container) return
  let activeMinutes
  const fromEl  = document.getElementById('rate-from')
  const untilEl = document.getElementById('rate-until')
  if (alwaysOn) {
    activeMinutes = 1440
    if (fromEl)  fromEl.disabled  = true
    if (untilEl) untilEl.disabled = true
  } else {
    if (fromEl)  fromEl.disabled  = false
    if (untilEl) untilEl.disabled = false
    const from  = _timeToMinutes(_get('rate-from')  || '07:00')
    const until = _timeToMinutes(_get('rate-until') || '22:00')
    activeMinutes = until > from ? until - from : (1440 - from + until)
  }
  const windowLabel = alwaysOn ? '24h' : `${_get('rate-from') || '07:00'}\u2013${_get('rate-until') || '22:00'} (${Math.round(activeMinutes / 60 * 10) / 10}h)`
  const firstStats = _calcApiStats(API_CAPS[0], activeMinutes)
  container.dataset.intervalSec = firstStats.intervalSec
  container.innerHTML = API_CAPS.map(cap => {
    const s = _calcApiStats(cap, activeMinutes)
    const rpdLabel  = cap.rpd  ? `${cap.rpd} req/day`  : '&infin;'
    const rpmLabel  = cap.rpm  ? `${cap.rpm} RPM`       : '&infin;'
    const usedLabel = cap.rpd  ? `${s.reqPerDay} <span style="font-size:10px;color:var(--text-muted);">/ ${cap.rpd}</span>` : `${s.reqPerDay}`
    return `<div style="padding:12px 14px;background:var(--bg-panel);border:1px solid var(--border);border-left:3px solid ${cap.color};border-radius:6px;font-size:12px;line-height:1.8;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:700;color:${cap.color};">${cap.name}</span>
        <span style="font-size:10px;color:var(--text-muted);">${rpmLabel} &middot; ${rpdLabel} &middot; ${cap.note}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">
        <div><div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;">Ingest Every</div><div style="color:${cap.color};font-size:17px;font-weight:700;">${s.intervalLabel}</div></div>
        <div><div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;">Req / Hour</div><div style="color:var(--text-primary);font-size:17px;font-weight:700;">${s.reqPerHour}</div></div>
        <div><div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;">Req / Day</div><div style="font-size:17px;font-weight:700;color:var(--accent-green);">${usedLabel}</div></div>
        <div><div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;">Window</div><div style="color:var(--text-muted);font-size:12px;font-weight:600;">${windowLabel}</div></div>
      </div>
    </div>`
  }).join('')
}

async function _rateApply() {
  const container   = document.getElementById('rate-all-results')
  const intervalSec = parseInt(container?.dataset.intervalSec || '90')
  const alwaysOn    = document.getElementById('rate-always-on')?.checked
  QuantCache.saveRateSettings({ from: _get('rate-from'), until: _get('rate-until'), alwaysOn, intervalSec })
  const keys = QuantCache.loadApiKeys()
  try {
    await apiHealth({ ...keys, ingest_interval_sec: intervalSec })
    _synchroShowSaveMsg(`Schedule applied — ingest every ${intervalSec}s.`, 'success')
  } catch (e) {
    _synchroShowSaveMsg(`Saved locally. Backend: ${e.message}`, 'warning')
  }
}

// ── Save keys ──────────────────────────────────────────────────────────────

async function _synchroSave() {
  const rate = QuantCache.loadRateSettings()
  const apiKeys = {
    alpaca_key:          _get('key-alpaca-key'),
    alpaca_secret:       _get('key-alpaca-secret'),
    finnhub_key:         _get('key-finnhub'),
    newsapi_key:         _get('key-newsapi'),
    marketaux_token:     _get('key-marketaux'),
    base_url:            _get('key-base-url'),
    local_llm_url:       _get('key-local-llm-url'),
    local_llm_model:     _get('key-local-llm-model'),
    ingest_interval_sec: rate.intervalSec || 90,
  }
  QuantCache.saveApi(apiKeys)
  try {
    await apiHealth(apiKeys)
    _synchroShowSaveMsg('&#10003; Saved. Backend acknowledged.', 'success')
    await _synchroCheckAll()
  } catch (e) {
    _synchroShowSaveMsg(`Saved locally. Backend offline: ${e.message}`, 'warning')
  }
}

function _synchroClearKeys() {
  if (!confirm('Clear all saved API keys from browser?')) return
  QuantCache.saveApi({})
  _synchroLoadFields()
  _synchroShowSaveMsg('Keys cleared.', 'success')
}

// ── Status tiles ─────────────────────────────────────────────────────────────

async function _synchroCheckAll() {
  const grid = document.getElementById('synchro-status-grid')
  if (!grid) return
  const checks = [
    { name: 'Backend',    fn: () => fetch('http://localhost:8000/api/health').then(r => r.ok ? 'Online' : 'Error') },
    { name: 'WebSocket',  fn: () => _wsCheck() },
    { name: 'Alpaca',     fn: () => _keyCheck('alpaca_key') },
    { name: 'Finnhub',    fn: () => _keyCheck('finnhub_key') },
    { name: 'NewsAPI',    fn: () => _keyCheck('newsapi_key') },
    { name: 'Marketaux',  fn: () => _keyCheck('marketaux_token') },
    { name: 'Polymarket', fn: () => fetch('http://localhost:8000/api/polymarket/markets').then(r => r.ok ? 'Connected' : 'Error') },
    { name: 'Local AI',   fn: () => fetch('http://localhost:8000/api/health/local-ai').then(r => r.json()).then(j => j.status === 'online' ? `Online (${j.model})` : j.status === 'not_configured' ? 'Not configured' : j.status === 'model_missing' ? `Model missing (${j.model})` : 'Offline') },
  ]
  grid.innerHTML = checks.map(c => `
    <div class="status-tile">
      <span class="status-tile-name">${c.name}</span>
      <span class="status-tile-val" id="status-${c.name.toLowerCase().replace(' ', '-')}"><div class="spinner" style="display:inline-block;"></div></span>
    </div>`).join('')
  await Promise.allSettled(checks.map(async c => {
    const id = 'status-' + c.name.toLowerCase().replace(' ', '-')
    const el = document.getElementById(id)
    try {
      const result = await Promise.race([c.fn(), new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 4000))])
      if (el) {
        el.textContent = result
        el.className = `status-tile-val ${result === 'Missing' || result.includes('Error') || result === 'Offline' || result === 'Not configured' ? 'status-warn' : 'status-ok'}`
      }
    } catch (e) {
      if (el) { el.textContent = 'Offline'; el.className = 'status-tile-val status-error' }
    }
  }))
}

function _keyCheck(keyName) {
  return Promise.resolve(QuantCache.getApiKey(keyName) ? 'Configured' : 'Missing')
}

function _wsCheck() {
  return new Promise(resolve => {
    try {
      const ws = new WebSocket('ws://localhost:8000/ws/feed')
      const t = setTimeout(() => { ws.close(); resolve('Timeout') }, 2000)
      ws.onopen  = () => { clearTimeout(t); ws.close(); resolve('Connected') }
      ws.onerror = () => { clearTimeout(t); resolve('Error') }
    } catch (_) { resolve('Error') }
  })
}

// ── Feed stats ───────────────────────────────────────────────────────────────

async function _synchroLoadStats() {
  const el = document.getElementById('synchro-stats')
  if (!el) return
  try {
    const articles = await apiFeedAll({ limit: 200 })
    const total  = articles.length
    const high   = articles.filter(a => a.relevance === 'HIGH').length
    const medium = articles.filter(a => a.relevance === 'MEDIUM').length
    const bull   = articles.filter(a => a.sentiment === 'Bullish').length
    const bear   = articles.filter(a => a.sentiment === 'Bearish').length
    el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div><span style="color:var(--text-muted);">Total</span><br><strong style="color:var(--text-primary);font-size:16px;">${total}</strong></div>
      <div><span style="color:var(--text-muted);">HIGH / MED</span><br><strong style="color:var(--accent-red);">${high}</strong> / <strong style="color:var(--accent-orange);">${medium}</strong></div>
      <div><span style="color:var(--text-muted);">Bull / Bear</span><br><strong style="color:var(--accent-green);">${bull}</strong> / <strong style="color:var(--accent-red);">${bear}</strong></div>
    </div>`
  } catch (e) {
    el.textContent = 'Stats unavailable (backend offline).'
  }
}

// ── Misc ─────────────────────────────────────────────────────────────────────

async function _synchroSoftReset() {
  if (!confirm('Clear all articles, AI cache, and keywords? Watchlist and API keys will be preserved.')) return
  try {
    await apiResetCache()
    _synchroShowSaveMsg('\u2713 Article cache cleared.', 'success')
  } catch (e) {
    _synchroShowSaveMsg(`Reset failed: ${e.message}`, 'error')
  }
}

function _synchroResetCache() {
  if (!confirm('Reset all cached settings?')) return
  QuantCache.resetFull()
  _synchroInitDone = false
  initSynchro()
  _synchroShowSaveMsg('Cache reset.', 'success')
}

function _synchroShowSaveMsg(msg, type) {
  const el = document.getElementById('synchro-save-msg')
  if (el) {
    el.innerHTML = `<div class="notification notification--${type}">${msg}</div>`
    setTimeout(() => { if (el) el.innerHTML = '' }, 4000)
  }
}

function _timeToMinutes(t) {
  const [h, m] = (t || '00:00').split(':').map(Number)
  return h * 60 + (m || 0)
}

function _set(id, val) { const el = document.getElementById(id); if (el) el.value = val }
function _get(id)      { return (document.getElementById(id)?.value || '').trim() }
