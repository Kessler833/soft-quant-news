let _feedInitDone = false
let _feedWs = null
let _feedRetryCount = 0
let _feedRetryTimer = null
let _feedSoundOn = true
let _feedAudioCtx = null
let _feedStatusEs = null
let _feedRawEs = null
let _feedKwInterval = null

function _feedGetFilters() {
  return {
    relevance: document.getElementById('filter-relevance')?.value || '',
    sentiment: document.getElementById('filter-sentiment')?.value || '',
    catalyst:  document.getElementById('filter-catalyst')?.value || '',
    ticker:    (document.getElementById('filter-ticker')?.value || '').trim().toUpperCase(),
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

// ── Status Bar ─────────────────────────────────────────────────────────────

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
    ai:       '#a9b1d6',
    done:     'var(--accent-green)',
    idle:     'var(--text-muted)',
  }
  const color = phaseColors[phase] || 'var(--text-muted)'
  if (textEl) { textEl.textContent = detail || msg; textEl.style.color = color }
  if (badge)  { badge.textContent = phase.toUpperCase(); badge.style.borderColor = color; badge.style.color = color }
  if (spinner) spinner.style.display = (phase === 'done' || phase === 'idle') ? 'none' : 'inline-block'
}

function _feedConnectStatusStream() {
  if (_feedStatusEs) { try { _feedStatusEs.close() } catch(_){} }
  try {
    _feedStatusEs = new EventSource('http://localhost:8000/api/feed/ingest-status')
    _feedStatusEs.onmessage = (e) => {
      _feedShowStatus(e.data)
      if (e.data.startsWith('done:')) {
        // Re-fetch and MERGE new articles into the list (don't wipe it)
        setTimeout(_feedMergeLatest, 500)
        setTimeout(_feedLoadKeywordStatus, 1500)
      }
    }
    _feedStatusEs.onerror = () => {}
  } catch(e) { console.warn('[feed] Status SSE:', e) }
}

// ── Raw News Panel ───────────────────────────────────────────────────────────

function _feedConnectRawStream() {
  if (_feedRawEs) { try { _feedRawEs.close() } catch(_){} }
  try {
    _feedRawEs = new EventSource('http://localhost:8000/api/feed/raw-stream')
    _feedRawEs.onmessage = (e) => {
      if (e.data === 'ping') return
      try { _feedPrependRaw(JSON.parse(e.data)) } catch(_) {}
    }
    _feedRawEs.onerror = () => {}
  } catch(e) { console.warn('[feed] Raw SSE:', e) }
}

function _feedPrependRaw(article) {
  const list = document.getElementById('raw-list')
  if (!list) return
  // Dedupe by id in raw panel
  if (article.id && list.querySelector(`[data-id="${article.id}"]`)) return
  const rel    = (article.relevance || 'ignore').toLowerCase()
  const time   = article.published_at
    ? new Date(article.published_at).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})
    : '--:--'
  const source = (article.source || '').substring(0, 12)
  const title  = (article.title  || '').substring(0, 90)
  const row = document.createElement('div')
  row.className = `raw-row raw-row--${rel}`
  row.dataset.id = article.id || ''
  row.title = article.title || ''
  row.innerHTML = `<span class="raw-time">${time}</span><span class="raw-source">${_feedEsc(source)}</span><span class="raw-title">${_feedEsc(title)}</span>`
  list.prepend(row)
  while (list.children.length > 300) list.removeChild(list.lastChild)
}

// ── Keyword Status ───────────────────────────────────────────────────────────

function _feedSetKwLoading(on) {
  const el = document.getElementById('filter-loading')
  if (el) el.classList.toggle('visible', on)
}

async function _feedLoadKeywordStatus() {
  try {
    const s = await apiFeedKeywordStatus()
    const lastEl    = document.getElementById('filter-last-update')
    const nextEl    = document.getElementById('filter-next-update')
    const countEl   = document.getElementById('filter-kw-counts')
    const contextEl = document.getElementById('filter-context')

    if (!s.generated_at) {
      _feedSetKwLoading(true)
      if (lastEl)  lastEl.textContent  = 'Last update: generating...'
      if (nextEl)  nextEl.textContent  = 'Next: —'
      if (countEl) countEl.textContent = ''
      setTimeout(_feedLoadKeywordStatus, 5000)
      return
    }

    _feedSetKwLoading(false)
    if (lastEl) lastEl.textContent = `Last update: ${_feedRelTime(s.generated_at)}`
    if (nextEl) {
      const diff = new Date(s.next_at) - Date.now()
      nextEl.textContent = diff > 0 ? `Next: in ${Math.round(diff / 60000)}min` : 'Next: overdue'
    }
    if (countEl)   countEl.textContent   = s.high_count ? `H:${s.high_count} M:${s.medium_count} L:${s.low_count} keywords` : ''
    if (contextEl) contextEl.textContent = s.context_note || ''
  } catch(e) {
    setTimeout(_feedLoadKeywordStatus, 5000)
  }
}

// ── Sound ─────────────────────────────────────────────────────────────────────

function _feedPlaySound(relevance) {
  if (!_feedSoundOn) return
  try {
    if (!_feedAudioCtx) _feedAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _feedAudioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    if (relevance === 'HIGH') {
      osc.frequency.value = 880; gain.gain.value = 0.15
      osc.start(); osc.stop(ctx.currentTime + 0.25)
    } else {
      osc.frequency.value = 440; gain.gain.value = 0.08
      osc.start(); osc.stop(ctx.currentTime + 0.15)
    }
  } catch (_) {}
}

// ── Card builder ────────────────────────────────────────────────────────────────

function _feedBuildCard(a, withChartBtn = true) {
  const rel     = (a.relevance || 'low').toLowerCase()
  const sent    = (a.sentiment || 'Neutral').toLowerCase()
  const tickers = _feedParseTickers(a.tickers)
  const impact  = Math.min(10, Math.max(1, a.impact_score || 2))
  const tickerChips = tickers.map(t => `<span class="ticker-chip" data-ticker="${t}">${t}</span>`).join('')
  const chartBtns = withChartBtn
    ? tickers.slice(0, 2).map(t => `<button class="feed-card-chart-btn" data-ticker="${t}">▶ ${t}</button>`).join('')
    : ''
  const card = document.createElement('div')
  card.className = `news-card news-card--${rel} slide-in`
  card.dataset.id = a.id || ''
  card.innerHTML = `
    <div class="news-card__header">
      <span class="badge badge--${rel}">${a.relevance || 'LOW'}</span>
      <span class="badge badge--${sent}">${a.sentiment || 'Neutral'}</span>
      ${a.catalyst_type ? `<span class="badge badge--catalyst">${a.catalyst_type}</span>` : ''}
      <div class="impact-bar" title="Impact ${impact}/10">
        <div class="impact-bar__fill" style="width:${impact*10}%"></div>
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
  card.querySelectorAll('.feed-card-chart-btn').forEach(btn => {
    btn.addEventListener('click', () => _feedOpenChart(btn.dataset.ticker))
  })
  return card
}

function _feedPrependCard(article) {
  if (!_feedPassesFilters(article)) return
  const list = document.getElementById('feed-list')
  if (!list) return
  // Dedupe: don't prepend if card with same id already exists
  if (article.id && list.querySelector(`[data-id="${article.id}"]`)) return
  const card = _feedBuildCard(article)
  list.prepend(card)
  _feedPlaySound(article.relevance)
  while (list.children.length > 200) list.removeChild(list.lastChild)
}

// ── WebSocket ───────────────────────────────────────────────────────────────────

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

// ── Load & render (initial full load, does NOT clear on refresh) ────────────────

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

// Merge new articles into the list without wiping existing cards
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
    // If list is showing the empty/loading placeholder, do a full render instead
    const isEmpty = list.children.length === 0 || list.querySelector('.spinner')
    if (isEmpty) {
      list.innerHTML = ''
      articles.forEach(a => list.appendChild(_feedBuildCard(a)))
      return
    }
    // Prepend only articles not already in the list
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
      const errMsg = bars?.error || 'No data returned'
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
      type: 'candlestick',
      x:    bars.map(b => b.t),
      open: bars.map(b => b.o),
      high: bars.map(b => b.h),
      low:  bars.map(b => b.l),
      close:bars.map(b => b.c),
      increasing: { line: { color: '#26a69a' } },
      decreasing: { line: { color: '#ef5350' } },
    }
    const layout = {
      paper_bgcolor: '#0a0a14',
      plot_bgcolor:  '#0a0a14',
      font:  { color: '#cdd6f4', family: 'JetBrains Mono, monospace', size: 11 },
      xaxis: { gridcolor: '#2a2a3e', zeroline: false, rangeslider: { visible: false } },
      yaxis: { gridcolor: '#2a2a3e', zeroline: false },
      margin: { t: 20, r: 20, b: 40, l: 60 },
      showlegend: false,
    }
    Plotly.newPlot(container, [trace], layout, { responsive: true, displayModeBar: false })
  } catch (e) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--accent-red);">Chart error: ${_feedEsc(e.message)}</div>`
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function _feedRelTime(iso) {
  if (!iso) return ''
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s/60)}m ago`
    return `${Math.floor(s/3600)}h ago`
  } catch (_) { return '' }
}
function _feedEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Init ─────────────────────────────────────────────────────────────────────────

async function initFeed() {
  if (_feedInitDone) return
  _feedInitDone = true

  try {
    Split(['#feed-main', '#feed-raw'], {
      sizes: [80, 20],
      gutterSize: 5,
      minSize: [400, 180],
      direction: 'horizontal',
      cursor: 'col-resize',
    })
  } catch(e) { console.warn('[feed] Split.js error:', e) }

  _feedConnectStatusStream()
  _feedConnectRawStream()
  _feedLoadKeywordStatus()
  _feedKwInterval = setInterval(_feedLoadKeywordStatus, 60000)

  await _feedLoadAndRender()
  _feedConnectWs()

  ;['filter-relevance','filter-sentiment','filter-catalyst'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _feedLoadAndRender)
  })
  let _tickerDebounce = null
  document.getElementById('filter-ticker')?.addEventListener('input', () => {
    clearTimeout(_tickerDebounce)
    _tickerDebounce = setTimeout(_feedLoadAndRender, 400)
  })

  const soundBtn = document.getElementById('sound-toggle')
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      _feedSoundOn = !_feedSoundOn
      soundBtn.textContent = _feedSoundOn ? '♪ Sound ON' : '♪ Sound OFF'
      soundBtn.classList.toggle('active', _feedSoundOn)
    })
  }

  const updateBtn = document.getElementById('filter-update-btn')
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true
      updateBtn.textContent = '↻ Updating...'
      _feedSetKwLoading(true)
      try { await apiFeedRefreshKeywords() } catch(_) {}
      // Poll until generated_at changes (compare to current value)
      const currentGenAt = document.getElementById('filter-last-update')?.textContent || ''
      const poll = setInterval(async () => {
        const s = await apiFeedKeywordStatus().catch(() => null)
        if (s && s.generated_at) {
          const newLabel = `Last update: ${_feedRelTime(s.generated_at)}`
          if (newLabel !== currentGenAt) {
            clearInterval(poll)
            await _feedLoadKeywordStatus()
            updateBtn.disabled = false
            updateBtn.textContent = '↻ Update Filter Now'
          }
        }
      }, 2000)
      // Safety timeout: re-enable after 30s regardless
      setTimeout(() => {
        clearInterval(poll)
        updateBtn.disabled = false
        updateBtn.textContent = '↻ Update Filter Now'
        _feedSetKwLoading(false)
      }, 30000)
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
