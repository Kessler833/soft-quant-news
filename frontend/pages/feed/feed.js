let _feedInitDone    = false
let _feedWs          = null
let _feedRetryCount  = 0
let _feedRetryTimer  = null
let _feedSoundOn     = true
let _feedAudioCtx    = null
let _feedStatusEs    = null
let _feedRawEs       = null
let _feedFilterTimer = null   // BUG 6: debounce for dropdown filter changes

function _feedGetFilters() {
  return {
    relevance: document.getElementById('filter-relevance')?.value || '',
    sentiment: document.getElementById('filter-sentiment')?.value || '',
    catalyst:  document.getElementById('filter-catalyst')?.value  || '',
    ticker:    (document.getElementById('filter-ticker')?.value   || '').trim().toUpperCase(),
  }
}

function _feedPassesFilters(article) {
  const f = _feedGetFilters()
  if (f.relevance && article.relevance !== f.relevance) return false
  if (f.sentiment && article.sentiment !== f.sentiment) return false
  if (f.catalyst  && article.catalyst_type !== f.catalyst) return false
  if (f.ticker) {
    const tickers = Array.isArray(article.tickers) ? article.tickers : _feedParseTickers(article.tickers)
    if (!tickers.includes(f.ticker)) return false
  }
  return true
}

function _feedParseTickers(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw) } catch (_) { return [] }
}

function _feedShowBanner(msg) {
  const el = document.getElementById('feed-ws-banner')
  if (el) { el.textContent = msg; el.style.display = 'block' }
}
function _feedHideBanner() {
  const el = document.getElementById('feed-ws-banner')
  if (el) el.style.display = 'none'
}

// ── Status Bar ──────────────────────────────────────────────────────────────────────

function _feedShowStatus(msg) {
  const textEl  = document.getElementById('feed-status-text')
  const spinner = document.getElementById('feed-status-spinner')
  const badge   = document.getElementById('feed-status-badge')

  const [phase, ...rest] = msg.split(':')
  const detail = rest.join(':').trim()
  if (phase === 'ping') return

  const phaseColors = {
    fetching: 'var(--accent-blue)',
    scoring:  'var(--accent-orange)',
    done:     'var(--accent-green)',
    idle:     'var(--text-muted)',
  }
  const color = phaseColors[phase] || 'var(--text-muted)'
  if (textEl)  { textEl.textContent = detail || msg; textEl.style.color = color }
  if (badge)   { badge.textContent = phase.toUpperCase(); badge.style.borderColor = color; badge.style.color = color }
  if (spinner) spinner.style.display = (phase === 'done' || phase === 'idle') ? 'none' : 'inline-block'
}

// BUG 1 FIX: onerror now closes and reschedules reconnect after 5 s
function _feedConnectStatusStream() {
  if (_feedStatusEs) { try { _feedStatusEs.close() } catch (_) {} }
  try {
    _feedStatusEs = new EventSource('http://localhost:8000/api/feed/ingest-status')
    _feedStatusEs.onmessage = (e) => {
      _feedShowStatus(e.data)
      if (e.data.startsWith('done:')) setTimeout(_feedMergeLatest, 500)
    }
    _feedStatusEs.onerror = () => {
      _feedStatusEs.close()
      setTimeout(_feedConnectStatusStream, 5000)
    }
  } catch (e) { console.warn('[feed] Status SSE:', e) }
}

// ── Raw News Panel ────────────────────────────────────────────────────────────────

// BUG 1 FIX: same reconnect pattern for raw stream
function _feedConnectRawStream() {
  if (_feedRawEs) { try { _feedRawEs.close() } catch (_) {} }
  try {
    _feedRawEs = new EventSource('http://localhost:8000/api/feed/raw-stream')
    _feedRawEs.onmessage = (e) => {
      if (e.data === 'ping') return
      try { _feedPrependRaw(JSON.parse(e.data)) } catch (_) {}
    }
    _feedRawEs.onerror = () => {
      _feedRawEs.close()
      setTimeout(_feedConnectRawStream, 5000)
    }
  } catch (e) { console.warn('[feed] Raw SSE:', e) }
}

function _feedPrependRaw(article) {
  const list = document.getElementById('raw-list')
  if (!list) return
  if (article.id && list.querySelector(`[data-id="${article.id}"]`)) return
  const rel    = (article.relevance || 'ignore').toLowerCase()
  const time   = article.published_at
    ? new Date(article.published_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '--:--'
  const source = (article.source || '').substring(0, 12)
  const title  = (article.title  || '').substring(0, 90)
  const row = document.createElement('div')
  row.className  = `raw-row raw-row--${rel}`
  row.dataset.id = article.id || ''
  row.title      = article.title || ''
  row.innerHTML  = `<span class="raw-time">${time}</span><span class="raw-source">${_feedEsc(source)}</span><span class="raw-title">${_feedEsc(title)}</span>`
  list.prepend(row)
  while (list.children.length > 300) list.removeChild(list.lastChild)
}

// ── Sound ──────────────────────────────────────────────────────────────────────────────

// BUG 3 FIX: AudioContext is created and resumed via the sound toggle click,
// which is a direct user gesture. _feedPlaySound() reuses the existing ctx.
function _feedPlaySound(relevance) {
  if (!_feedSoundOn) return
  if (!_feedAudioCtx) return   // ctx only created after user gesture via sound btn
  try {
    const ctx  = _feedAudioCtx
    const osc  = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    if (relevance === 'HIGH') {
      osc.frequency.value = 880; gain.gain.value = 0.15
      osc.start(); osc.stop(ctx.currentTime + 0.25)
    } else {
      osc.frequency.value = 440; gain.gain.value = 0.08
      osc.start(); osc.stop(ctx.currentTime + 0.15)
    }
  } catch (_) {}
}

// ── Card builder ─────────────────────────────────────────────────────────────────

function _feedBuildCard(a, withChartBtn = true) {
  const rel     = (a.relevance || 'low').toLowerCase()
  const sent    = (a.sentiment || 'Neutral').toLowerCase()
  const tickers = _feedParseTickers(a.tickers)
  const impact  = Math.min(10, Math.max(1, a.impact_score || 2))
  const tickerChips = tickers.map(t => `<span class="ticker-chip" data-ticker="${_feedEsc(t)}" style="cursor:pointer;">${_feedEsc(t)}</span>`).join('')
  const chartBtns = withChartBtn
    ? tickers.slice(0, 2).map(t => `<button class="feed-card-chart-btn" data-ticker="${_feedEsc(t)}">&#9654; ${_feedEsc(t)}</button>`).join('')
    : ''
  const card = document.createElement('div')
  card.className = `news-card news-card--${rel} slide-in`
  card.dataset.id = a.id || ''
  card.innerHTML = `
    <div class="news-card__header">
      <span class="badge badge--${rel}">${a.relevance || 'LOW'}</span>
      <span class="badge badge--${sent}">${a.sentiment || 'Neutral'}</span>
      ${a.catalyst_type ? `<span class="badge badge--catalyst">${_feedEsc(a.catalyst_type)}</span>` : ''}
      <div class="impact-bar" title="Impact ${impact}/10">
        <div class="impact-bar__fill" style="width:${impact * 10}%"></div>
      </div>
      ${chartBtns}
    </div>
    <div class="news-card__title">${_feedEsc(a.title || '')}</div>
    ${a.summary ? `<div class="news-card__summary">${_feedEsc(a.summary)}</div>` : ''}
    <div class="news-card__footer">
      <div class="news-card__tickers">${tickerChips}</div>
      <span class="news-card__source">${_feedEsc(a.source || '')}</span>
      <span class="news-card__time">${_feedRelTime(a.published_at)}</span>
    </div>`

  // BUG 4 FIX: ticker chips click → set filter-ticker and re-render
  card.querySelectorAll('.ticker-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tickerInput = document.getElementById('filter-ticker')
      if (tickerInput) {
        tickerInput.value = chip.dataset.ticker
        _feedDebouncedLoad()
      }
    })
  })

  card.querySelectorAll('.feed-card-chart-btn').forEach(btn => {
    btn.addEventListener('click', () => _feedOpenChart(btn.dataset.ticker))
  })

  return card
}

function _feedPrependCard(article) {
  if (!_feedPassesFilters(article)) return
  const list = document.getElementById('feed-list')
  if (!list) return
  if (article.id && list.querySelector(`[data-id="${article.id}"]`)) return
  const card = _feedBuildCard(article)
  list.prepend(card)
  _feedPlaySound(article.relevance)
  while (list.children.length > 200) list.removeChild(list.lastChild)
}

// ── WebSocket ───────────────────────────────────────────────────────────────────────

function _feedConnectWs() {
  if (_feedRetryTimer) { clearTimeout(_feedRetryTimer); _feedRetryTimer = null }
  try {
    _feedWs = new WebSocket('ws://localhost:8000/ws/feed')
    _feedWs.onopen = () => { _feedRetryCount = 0; _feedHideBanner() }
    _feedWs.onmessage = (e) => {
      try {
        const article = JSON.parse(e.data)
        if (article.type === 'ping') return
        _feedPrependCard(article)
      } catch (_) {}
    }
    _feedWs.onclose = _feedWs.onerror = () => {
      _feedRetryCount++
      if (_feedRetryCount <= 10) {
        _feedShowBanner(`WS lost — retry ${_feedRetryCount}/10...`)
        _feedRetryTimer = setTimeout(_feedConnectWs, 3000)
      } else {
        _feedShowBanner('Feed disconnected. Refresh to reconnect.')
      }
    }
  } catch (e) { console.warn('[feed] WS error:', e) }
}

// ── Load & render ─────────────────────────────────────────────────────────────────

// BUG 6 FIX: shared debounce helper used by both ticker input and dropdowns
function _feedDebouncedLoad() {
  clearTimeout(_feedFilterTimer)
  _feedFilterTimer = setTimeout(_feedLoadAndRender, 150)
}

async function _feedLoadAndRender() {
  const list = document.getElementById('feed-list')
  if (!list) return
  list.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:20px;color:var(--text-muted);"><div class="spinner"></div> Loading...</div>'
  try {
    const f = _feedGetFilters()
    const params = { limit: 50 }
    if (f.relevance) params.relevance = f.relevance
    if (f.sentiment) params.sentiment = f.sentiment
    if (f.catalyst)  params.catalyst  = f.catalyst
    if (f.ticker)    params.ticker    = f.ticker
    const articles = await apiFeedLatest(params)
    list.innerHTML = ''
    if (!articles || articles.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;">No articles yet — check the status bar above.</div>'
      return
    }
    articles.forEach(a => list.appendChild(_feedBuildCard(a)))
  } catch (e) {
    list.innerHTML = `<div class="notification notification--error">Error: ${e.message}</div>`
  }
}

// BUG 2 FIX: only treat the list as empty when it has no data-id children,
// not whenever any spinner exists anywhere in the list.
async function _feedMergeLatest() {
  const list = document.getElementById('feed-list')
  if (!list) return
  try {
    const f = _feedGetFilters()
    const params = { limit: 50 }
    if (f.relevance) params.relevance = f.relevance
    if (f.sentiment) params.sentiment = f.sentiment
    if (f.catalyst)  params.catalyst  = f.catalyst
    if (f.ticker)    params.ticker    = f.ticker
    const articles = await apiFeedLatest(params)
    if (!articles || articles.length === 0) return

    // isEmpty = no children at all, OR the sole child is a loading placeholder
    const isEmpty = list.children.length === 0 ||
      (list.children.length === 1 &&
       list.children[0].querySelector('.spinner') &&
       !list.children[0].dataset.id)

    if (isEmpty) {
      list.innerHTML = ''
      articles.forEach(a => list.appendChild(_feedBuildCard(a)))
      return
    }
    const existingIds = new Set([...list.querySelectorAll('[data-id]')].map(el => el.dataset.id))
    const newArticles = articles.filter(a => a.id && !existingIds.has(a.id))
    newArticles.reverse().forEach(a => {
      if (_feedPassesFilters(a)) list.prepend(_feedBuildCard(a))
    })
    while (list.children.length > 200) list.removeChild(list.lastChild)
  } catch (e) {
    console.warn('[feed] Merge failed:', e)
  }
}

// ── Chart modal ───────────────────────────────────────────────────────────────────

async function _feedOpenChart(ticker) {
  const modal     = document.getElementById('feed-chart-modal')
  const title     = document.getElementById('feed-chart-title')
  const container = document.getElementById('feed-chart-container')
  if (!modal || !container) return
  title.textContent = `${ticker} — 5Min Candlestick`
  modal.classList.add('open')
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--text-muted);"><div class="spinner"></div> Loading chart...</div>'
  try {
    const bars = await apiPriceBars(ticker, '5Min', 100)
    if (!bars || bars.error) {
      const errMsg    = bars?.error || 'No data returned'
      const isKeyIssue = errMsg.toLowerCase().includes('not configured') || errMsg.toLowerCase().includes('key')
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;">
          <div style="color:var(--accent-red);font-size:13px;">&#9888; ${_feedEsc(errMsg)}</div>
          ${isKeyIssue ? '<div style="font-size:11px;color:var(--text-muted);">Add your Alpaca API key in Synchro to enable price charts.</div>' : ''}
        </div>`
      return
    }
    if (bars.length === 0) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No 5-min bars available. Market may be closed or symbol not on IEX feed.</div>'
      return
    }
    const trace = {
      type:  'candlestick',
      x:      bars.map(b => b.t),
      open:   bars.map(b => b.o),
      high:   bars.map(b => b.h),
      low:    bars.map(b => b.l),
      close:  bars.map(b => b.c),
      increasing: { line: { color: '#26a69a' } },
      decreasing: { line: { color: '#ef5350' } },
    }
    const layout = {
      paper_bgcolor: '#0a0a14',
      plot_bgcolor:  '#0a0a14',
      font:   { color: '#cdd6f4', family: 'JetBrains Mono, monospace', size: 11 },
      xaxis:  { gridcolor: '#2a2a3e', zeroline: false, rangeslider: { visible: false } },
      yaxis:  { gridcolor: '#2a2a3e', zeroline: false },
      margin: { t: 20, r: 20, b: 40, l: 60 },
      showlegend: false,
    }
    Plotly.newPlot(container, [trace], layout, { responsive: true, displayModeBar: false })
  } catch (e) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--accent-red);">Chart error: ${_feedEsc(e.message)}</div>`
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────

// BUG 5 FIX: return 'Unknown' instead of '' for missing/invalid dates
function _feedRelTime(iso) {
  if (!iso) return 'Unknown'
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (isNaN(s)) return 'Unknown'
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  } catch (_) { return 'Unknown' }
}

function _feedEsc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Init ───────────────────────────────────────────────────────────────────────────────────

async function initFeed() {
  if (_feedInitDone) return
  _feedInitDone = true

  try {
    Split(['#feed-main', '#feed-raw'], {
      sizes:     [80, 20],
      gutterSize: 5,
      minSize:   [400, 180],
      direction:  'horizontal',
      cursor:     'col-resize',
    })
  } catch (e) { console.warn('[feed] Split.js error:', e) }

  _feedConnectStatusStream()
  _feedConnectRawStream()

  await _feedLoadAndRender()
  _feedConnectWs()

  // BUG 6 FIX: all three dropdowns share 150ms debounce, same as ticker
  ;['filter-relevance', 'filter-sentiment', 'filter-catalyst'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _feedDebouncedLoad)
  })
  document.getElementById('filter-ticker')?.addEventListener('input', _feedDebouncedLoad)

  // BUG 3 FIX: AudioContext created and resumed on the sound toggle click
  // (direct user gesture) so browsers allow it immediately.
  const soundBtn = document.getElementById('sound-toggle')
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      _feedSoundOn = !_feedSoundOn
      // Create context on first click; resume on every subsequent click
      if (!_feedAudioCtx) {
        _feedAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
      }
      _feedAudioCtx.resume()
      soundBtn.textContent = _feedSoundOn ? '\u266a Sound ON' : '\u266a Sound OFF'
      soundBtn.classList.toggle('active', _feedSoundOn)
    })
  }

  document.getElementById('feed-chart-close')?.addEventListener('click', () => {
    document.getElementById('feed-chart-modal')?.classList.remove('open')
  })
  document.getElementById('feed-chart-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('feed-chart-modal'))
      document.getElementById('feed-chart-modal').classList.remove('open')
  })
}
