let _feedInitDone = false
let _feedWs = null
let _feedRetryCount = 0
let _feedRetryTimer = null
let _feedSoundOn = true
let _feedAudioCtx = null

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
    const tickers = _feedParseTickers(article.tickers)
    if (!tickers.includes(f.ticker)) return false
  }
  return true
}

function _feedParseTickers(raw) {
  if (!raw) return []
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

function _feedPlaySound(relevance) {
  if (!_feedSoundOn) return
  try {
    if (!_feedAudioCtx) _feedAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _feedAudioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    if (relevance === 'HIGH') {
      osc.frequency.value = 880
      gain.gain.value = 0.15
      osc.start()
      osc.stop(ctx.currentTime + 0.25)
    } else {
      osc.frequency.value = 440
      gain.gain.value = 0.08
      osc.start()
      osc.stop(ctx.currentTime + 0.15)
    }
  } catch (_) {}
}

function _feedBuildCard(a, withChartBtn = true) {
  const rel  = (a.relevance || 'MEDIUM').toLowerCase()
  const sent = (a.sentiment || 'Neutral').toLowerCase()
  const tickers = _feedParseTickers(a.tickers)
  const impact  = Math.min(10, Math.max(1, a.impact_score || 5))

  const tickerChips = tickers.map(t =>
    `<span class="ticker-chip" data-ticker="${t}">${t}</span>`
  ).join('')

  const chartBtns = withChartBtn
    ? tickers.slice(0, 2).map(t =>
        `<button class="feed-card-chart-btn" data-ticker="${t}">&#9654; ${t}</button>`
      ).join('')
    : ''

  const card = document.createElement('div')
  card.className = `news-card news-card--${rel} slide-in`
  card.dataset.id = a.id || ''
  card.innerHTML = `
    <div class="news-card__header">
      <span class="badge badge--${rel}">${a.relevance || 'MED'}</span>
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
    </div>
  `

  // Chart button handlers
  card.querySelectorAll('.feed-card-chart-btn').forEach(btn => {
    btn.addEventListener('click', () => _feedOpenChart(btn.dataset.ticker))
  })

  return card
}

function _feedPrependCard(article) {
  if (!_feedPassesFilters(article)) return
  const list = document.getElementById('feed-list')
  if (!list) return
  const card = _feedBuildCard(article)
  list.prepend(card)
  _feedPlaySound(article.relevance)
  // Cap at 200 cards
  while (list.children.length > 200) {
    list.removeChild(list.lastChild)
  }
}

function _feedConnectWs() {
  if (_feedRetryTimer) { clearTimeout(_feedRetryTimer); _feedRetryTimer = null }
  try {
    _feedWs = new WebSocket('ws://localhost:8000/ws/feed')
    _feedWs.onopen = () => {
      _feedRetryCount = 0
      _feedHideBanner()
    }
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
  } catch (e) {
    console.warn('[feed] WS connect error:', e)
  }
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
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;">No articles match filters.</div>'
      return
    }
    articles.forEach(a => {
      list.appendChild(_feedBuildCard(a))
    })
  } catch (e) {
    list.innerHTML = `<div class="notification notification--error">Error: ${e.message}</div>`
  }
}

async function _feedOpenChart(ticker) {
  const modal = document.getElementById('feed-chart-modal')
  const title = document.getElementById('feed-chart-title')
  const container = document.getElementById('feed-chart-container')
  if (!modal || !container) return

  title.textContent = `${ticker} — 5Min Candlestick`
  modal.classList.add('open')
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--text-muted);"><div class="spinner"></div> Loading chart...</div>'

  try {
    const bars = await apiPriceBars(ticker, '5Min', 100)
    if (!bars || bars.error || bars.length === 0) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No price data available.</div>'
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
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--accent-red);">Chart error: ${e.message}</div>`
  }
}

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

async function initFeed() {
  if (_feedInitDone) return
  _feedInitDone = true

  await _feedLoadAndRender()
  _feedConnectWs()

  // Filter change handlers
  ['filter-relevance','filter-sentiment','filter-catalyst'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _feedLoadAndRender)
  })
  let _tickerDebounce = null
  document.getElementById('filter-ticker')?.addEventListener('input', () => {
    clearTimeout(_tickerDebounce)
    _tickerDebounce = setTimeout(_feedLoadAndRender, 400)
  })

  // Sound toggle
  const soundBtn = document.getElementById('sound-toggle')
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      _feedSoundOn = !_feedSoundOn
      soundBtn.textContent = _feedSoundOn ? '\u266a Sound ON' : '\u266a Sound OFF'
      soundBtn.classList.toggle('active', _feedSoundOn)
    })
  }

  // Chart modal close
  document.getElementById('feed-chart-close')?.addEventListener('click', () => {
    document.getElementById('feed-chart-modal')?.classList.remove('open')
  })
  document.getElementById('feed-chart-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('feed-chart-modal'))
      document.getElementById('feed-chart-modal').classList.remove('open')
  })
}
