let _synchroInitDone = false

async function initSynchro() {
  if (_synchroInitDone) return
  _synchroInitDone = true

  _synchroLoadFields()

  document.getElementById('synchro-save-btn')?.addEventListener('click',        _synchroSave)
  document.getElementById('synchro-clear-btn')?.addEventListener('click',       _synchroClearKeys)
  document.getElementById('synchro-check-btn')?.addEventListener('click',       _synchroCheckAll)
  document.getElementById('synchro-reset-cache-btn')?.addEventListener('click', _synchroResetCache)

  await _synchroCheckAll()
  _synchroLoadStats()
}

function _synchroLoadFields() {
  const keys = QuantCache.loadApiKeys()
  _set('key-alpaca-key',    keys.alpaca_key      || '')
  _set('key-alpaca-secret', keys.alpaca_secret   || '')
  _set('key-gemini',        keys.gemini_key      || '')
  _set('key-finnhub',       keys.finnhub_key     || '')
  _set('key-newsapi',       keys.newsapi_key     || '')
  _set('key-marketaux',     keys.marketaux_token || '')
  _set('key-base-url',      keys.base_url        || '')
}

async function _synchroSave() {
  const apiKeys = {
    alpaca_key:      _get('key-alpaca-key'),
    alpaca_secret:   _get('key-alpaca-secret'),
    gemini_key:      _get('key-gemini'),
    finnhub_key:     _get('key-finnhub'),
    newsapi_key:     _get('key-newsapi'),
    marketaux_token: _get('key-marketaux'),
    base_url:        _get('key-base-url'),
  }
  QuantCache.saveApi(apiKeys)

  const msg = document.getElementById('synchro-save-msg')

  try {
    const result = await apiHealth(apiKeys)
    if (msg) {
      msg.innerHTML = '<div class="notification notification--success">&#10003; Saved. Backend acknowledged.</div>'
      setTimeout(() => { if (msg) msg.innerHTML = '' }, 3000)
    }
    await _synchroCheckAll()
  } catch (e) {
    QuantCache.saveApi(apiKeys)
    if (msg) {
      msg.innerHTML = `<div class="notification notification--warning">Saved locally. Backend offline: ${e.message}</div>`
      setTimeout(() => { if (msg) msg.innerHTML = '' }, 5000)
    }
  }
}

function _synchroClearKeys() {
  if (!confirm('Clear all saved API keys from browser?')) return
  QuantCache.saveApi({})
  _synchroLoadFields()
  _synchroShowSaveMsg('Keys cleared.', 'success')
}

async function _synchroCheckAll() {
  const grid = document.getElementById('synchro-status-grid')
  if (!grid) return

  const checks = [
    { name: 'Backend',    fn: () => fetch('http://localhost:8000/api/health').then(r => r.ok ? 'Online' : 'Error') },
    { name: 'WebSocket',  fn: () => _wsCheck() },
    { name: 'Alpaca',     fn: () => _keyCheck('alpaca_key') },
    { name: 'Gemini',     fn: () => _keyCheck('gemini_key') },
    { name: 'Finnhub',    fn: () => _keyCheck('finnhub_key') },
    { name: 'NewsAPI',    fn: () => _keyCheck('newsapi_key') },
    { name: 'Marketaux',  fn: () => _keyCheck('marketaux_token') },
    { name: 'Polymarket', fn: () => fetch('http://localhost:8000/api/polymarket/markets').then(r => r.ok ? 'Connected' : 'Error') },
  ]

  grid.innerHTML = checks.map(c => `
    <div class="status-tile">
      <span class="status-tile-name">${c.name}</span>
      <span class="status-tile-val status-check" id="status-${c.name.toLowerCase()}"><div class="spinner" style="display:inline-block;"></div></span>
    </div>`).join('')

  await Promise.allSettled(checks.map(async c => {
    const el = document.getElementById('status-' + c.name.toLowerCase())
    try {
      const result = await Promise.race([
        c.fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 4000))
      ])
      if (el) {
        el.textContent = result
        el.className = `status-tile-val ${result.includes('Error') || result === 'Missing' ? 'status-warn' : 'status-ok'}`
      }
    } catch (e) {
      if (el) { el.textContent = 'Offline'; el.className = 'status-tile-val status-error' }
    }
  }))
}

function _keyCheck(keyName) {
  const val = QuantCache.getApiKey(keyName)
  return Promise.resolve(val ? 'Configured' : 'Missing')
}

function _wsCheck() {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket('ws://localhost:8000/ws/feed')
      const timer = setTimeout(() => { ws.close(); resolve('Timeout') }, 2000)
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('Connected') }
      ws.onerror = () => { clearTimeout(timer); resolve('Error') }
    } catch (_) { resolve('Error') }
  })
}

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
        <div><span style="color:var(--text-muted);">Total articles</span><br><strong style="color:var(--text-primary);font-size:16px;">${total}</strong></div>
        <div><span style="color:var(--text-muted);">HIGH / MEDIUM</span><br><strong style="color:var(--accent-red);">${high}</strong> / <strong style="color:var(--accent-orange);">${medium}</strong></div>
        <div><span style="color:var(--text-muted);">Bull / Bear</span><br><strong style="color:var(--accent-green);">${bull}</strong> / <strong style="color:var(--accent-red);">${bear}</strong></div>
      </div>`
  } catch (e) {
    el.textContent = 'Stats unavailable (backend offline).'
  }
}

function _synchroResetCache() {
  if (!confirm('Reset all cached settings? This cannot be undone.')) return
  QuantCache.resetFull()
  _synchroInitDone = false
  initSynchro()
  _synchroShowSaveMsg('Cache reset.', 'success')
}

function _synchroShowSaveMsg(msg, type) {
  const el = document.getElementById('synchro-save-msg')
  if (el) {
    el.innerHTML = `<div class="notification notification--${type}">${msg}</div>`
    setTimeout(() => { if (el) el.innerHTML = '' }, 3000)
  }
}

function _set(id, val) {
  const el = document.getElementById(id)
  if (el) el.value = val
}
function _get(id) {
  return (document.getElementById(id)?.value || '').trim()
}
