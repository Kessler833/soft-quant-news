// ── API rate caps (free tier) ───────────────────────────────────────────────────
const API_CAPS = [
  { id: 'groq',      name: 'Groq AI',   rpm: 30,   rpd: 1000, color: 'var(--accent-blue)',   note: 'console.groq.com' },
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
  document.getElementById('synchro-soft-reset-btn')?.addEventListener('click', _synchroSoftReset)
  document.getElementById('rate-apply-btn')?.addEventListener('click',          _rateApply)
  document.getElementById('rate-from')?.addEventListener('input',               _rateCalcUpdate)
  document.getElementById('rate-until')?.addEventListener('input',              _rateCalcUpdate)
  document.getElementById('rate-always-on')?.addEventListener('change',         _rateCalcUpdate)

  // Auto-push saved keys to backend on every launch so config is never empty
  await _synchroPushKeysToBackend()

  await _synchroCheckAll()
  _synchroLoadStats()
}

// Push whatever is in QuantCache to the backend immediately.
async function _synchroPushKeysToBackend() {
  const keys = QuantCache.loadApiKeys()
  const rate = QuantCache.loadRateSettings()
  const hasAnyKey = Object.values(keys).some(v => v && String(v).trim().length > 0)
  if (!hasAnyKey) return
  try {
    await apiHealth({
      ...keys,
      groq_rpm:            rate.groqRpm     || 25,
      ingest_interval_sec: rate.intervalSec || 90,
    })
    console.log('[synchro] Keys auto-pushed to backend on launch.')
  } catch (e) {
    console.warn('[synchro] Auto-push failed (backend may still be starting):', e.message)
    setTimeout(async () => {
      try {
        await apiHealth({
          ...keys,
          groq_rpm:            rate.groqRpm     || 25,
          ingest_interval_sec: rate.intervalSec || 90,
        })
        console.log('[synchro] Keys auto-pushed to backend (retry ok).')
      } catch (_) {}
    }, 3000)
  }
}

function _synchroLoadFields() {
  const keys = QuantCache.loadApiKeys()
  const rate = QuantCache.loadRateSettings()
  _set('key-alpaca-key',      keys.alpaca_key      || '')
  _set('key-alpaca-secret',   keys.alpaca_secret   || '')
  _set('key-groq',            keys.groq_key        || '')
  _set('key-finnhub',         keys.finnhub_key     || '')
  _set('key-newsapi',         keys.newsapi_key     || '')
  _set('key-marketaux',       keys.marketaux_token || '')
  _set('key-base-url',        keys.base_url        || '')
  _set('key-local-llm-url',   keys.local_llm_url   || '')
  _set('key-local-llm-model', keys.local_llm_model || 'qwen2.5:3b')
  if (rate.from)    _set('rate-from',  rate.from)
  if (rate.until)   _set('rate-until', rate.until)
  if (rate.alwaysOn !== undefined) {
    const el = document.getElementById('rate-always-on')
    if (el) el.checked = rate.alwaysOn
  }
}

// ── Rate Limit Calculator ───────────────────────────────────────────────────

function _calcApiStats(cap, activeMinutes) {
  const BUFFER = 0.85
  const safeRpm = cap.rpm ? Math.floor(cap.rpm * BUFFER) : null
  const safeRpd = cap.rpd ? Math.floor(cap.rpd * BUFFER) : null
  let intervalSec
  if (safeRpd) {
    intervalSec = Math.ceil((activeMinutes * 60) / safeRpd)
  } else {
    intervalSec = Math.ceil(60 / safeRpm)
  }
  if (safeRpm) {
    intervalSec = Math.max(intervalSec, Math.ceil(60 / safeRpm))
  }
  const reqPerDay  = Math.floor((activeMinutes * 60) / intervalSec)
  const reqPerHour = Math.floor(3600 / intervalSec)
  const hh = String(Math.floor(intervalSec / 60)).padStart(2, '0')
  const ss = String(intervalSec % 60).padStart(2, '0')
  const intervalLabel = intervalSec >= 60 ? `${hh}m ${ss}s` : `${intervalSec}s`
  return { intervalSec, intervalLabel, reqPerDay, reqPerHour, safeRpm, safeRpd }
}

function _rateCalcUpdate() {
  const alwaysOn = document.getElementById('rate-always-on')?.checked
  const fromEl   = document.getElementById('rate-from')
  const untilEl  = document.getElementById('rate-until')
  const container = document.getElementById('rate-all-results')
  if (!container) return

  let activeMinutes
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

  const windowLabel = alwaysOn
    ? '24h'
    : `${_get('rate-from') || '07:00'}\u2013${_get('rate-until') || '22:00'} (${Math.round(activeMinutes / 60 * 10) / 10}h)`

  const groqStats = _calcApiStats(API_CAPS.find(c => c.id === 'groq'), activeMinutes)
  container.dataset.intervalSec = groqStats.intervalSec
  container.dataset.safeRpm     = groqStats.safeRpm

  container.innerHTML = API_CAPS.map(cap => {
    const s = _calcApiStats(cap, activeMinutes)
    const rpdLabel  = cap.rpd  ? `${cap.rpd} req/day`  : '&infin;'
    const rpmLabel  = cap.rpm  ? `${cap.rpm} RPM`       : '&infin;'
    const usedLabel = cap.rpd  ? `${s.reqPerDay} <span style="font-size:10px;color:var(--text-muted);">/ ${cap.rpd}</span>` : `${s.reqPerDay}`
    return `
      <div style="
        padding:12px 14px;
        background:var(--bg-panel);border:1px solid var(--border);
        border-left:3px solid ${cap.color};
        border-radius:6px;font-size:12px;line-height:1.8;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:13px;font-weight:700;color:${cap.color};">${cap.name}</span>
          <span style="font-size:10px;color:var(--text-muted);">${rpmLabel} &nbsp;&middot;&nbsp; ${rpdLabel} &nbsp;&middot;&nbsp; ${cap.note}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">
          <div>
            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Ingest Every</div>
            <div style="color:${cap.color};font-size:17px;font-weight:700;">${s.intervalLabel}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Req / Hour</div>
            <div style="color:var(--text-primary);font-size:17px;font-weight:700;">${s.reqPerHour}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Req / Day</div>
            <div style="font-size:17px;font-weight:700;color:var(--accent-green);">${usedLabel}</div>
          </div>
          <div>
            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Window</div>
            <div style="color:var(--text-muted);font-size:12px;font-weight:600;">${windowLabel}</div>
          </div>
        </div>
      </div>`
  }).join('')
}

async function _rateApply() {
  const container   = document.getElementById('rate-all-results')
  const intervalSec = parseInt(container?.dataset.intervalSec || '90')
  const safeRpm     = parseInt(container?.dataset.safeRpm     || '25')
  const alwaysOn    = document.getElementById('rate-always-on')?.checked

  QuantCache.saveRateSettings({
    from:        _get('rate-from'),
    until:       _get('rate-until'),
    alwaysOn:    alwaysOn,
    intervalSec: intervalSec,
    groqRpm:     safeRpm,
  })

  const keys = QuantCache.loadApiKeys()
  try {
    await apiHealth({ ...keys, ingest_interval_sec: intervalSec, groq_rpm: safeRpm })
    _synchroShowSaveMsg(`Schedule applied — Groq ingest every ${intervalSec}s.`, 'success')
  } catch (e) {
    _synchroShowSaveMsg(`Saved locally. Backend: ${e.message}`, 'warning')
  }
}

// ── Save keys ───────────────────────────────────────────────────────────────

async function _synchroSave() {
  const rate = QuantCache.loadRateSettings()
  const apiKeys = {
    alpaca_key:          _get('key-alpaca-key'),
    alpaca_secret:       _get('key-alpaca-secret'),
    groq_key:            _get('key-groq'),
    finnhub_key:         _get('key-finnhub'),
    newsapi_key:         _get('key-newsapi'),
    marketaux_token:     _get('key-marketaux'),
    base_url:            _get('key-base-url'),
    local_llm_url:       _get('key-local-llm-url'),
    local_llm_model:     _get('key-local-llm-model'),
    groq_rpm:            rate.groqRpm     || 25,
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

// ── Status tiles ──────────────────────────────────────────────────────────────

async function _synchroCheckAll() {
  const grid = document.getElementById('synchro-status-grid')
  if (!grid) return

  const checks = [
    { name: 'Backend',    fn: () => fetch('http://localhost:8000/api/health').then(r => r.ok ? 'Online' : 'Error') },
    { name: 'WebSocket',  fn: () => _wsCheck() },
    { name: 'Alpaca',     fn: () => _keyCheck('alpaca_key') },
    { name: 'Groq AI',    fn: () => _keyCheck('groq_key') },
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

// ── Feed stats ──────────────────────────────────────────────────────────────

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
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div><span style="color:var(--text-muted);">Total</span><br><strong style="color:var(--text-primary);font-size:16px;">${total}</strong></div>
        <div><span style="color:var(--text-muted);">HIGH / MED</span><br><strong style="color:var(--accent-red);">${high}</strong> / <strong style="color:var(--accent-orange);">${medium}</strong></div>
        <div><span style="color:var(--text-muted);">Bull / Bear</span><br><strong style="color:var(--accent-green);">${bull}</strong> / <strong style="color:var(--accent-red);">${bear}</strong></div>
      </div>`
  } catch (e) {
    el.textContent = 'Stats unavailable (backend offline).'
  }
}

// ── Misc ───────────────────────────────────────────────────────────────────────

async function _synchroSoftReset() {
  if (!confirm('Clear all articles, AI cache, and keywords? Watchlist and API keys will be preserved.')) return
  try {
    await apiResetCache()
    _synchroShowSaveMsg('\u2713 Article cache cleared. Restart to re-ingest.', 'success')
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
