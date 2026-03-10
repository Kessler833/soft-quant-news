let _analysisInitDone = false
let _analysisSentTimer = null
let _analysisWsbTimer  = null

async function initAnalysis() {
  if (_analysisInitDone) return
  _analysisInitDone = true

  // Inject panel HTML
  const left   = document.getElementById('analysis-left')
  const center = document.getElementById('analysis-center')
  const right  = document.getElementById('analysis-right')
  if (!left || !center || !right) return

  left.innerHTML = `
    <div class="panel-header">&#9673; Sentiment Intelligence</div>
    <div class="gauge-wrap" id="analysis-gauge-wrap">
      <svg class="gauge-svg" width="200" height="110" viewBox="0 0 200 110">
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stop-color="#ef5350"/>
            <stop offset="50%"  stop-color="#6c7086"/>
            <stop offset="100%" stop-color="#26a69a"/>
          </linearGradient>
        </defs>
        <!-- Background arc -->
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#2a2a3e" stroke-width="12" stroke-linecap="round"/>
        <!-- Gradient arc -->
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#gaugeGrad)" stroke-width="8" stroke-linecap="round" opacity="0.6"/>
        <!-- Needle -->
        <line id="gauge-needle" x1="100" y1="100" x2="100" y2="28" stroke="#cdd6f4" stroke-width="2.5" stroke-linecap="round"
          style="transform-origin:100px 100px; transition:transform 0.6s ease;"/>
        <circle cx="100" cy="100" r="5" fill="#cdd6f4"/>
        <!-- Score text -->
        <text id="gauge-score-text" x="100" y="82" class="gauge-score" fill="#cdd6f4">0</text>
        <text x="100" y="94" class="gauge-label">Sentiment</text>
        <!-- Labels -->
        <text x="16"  y="110" font-size="10" fill="#ef5350" font-family="JetBrains Mono,monospace">BEAR</text>
        <text x="160" y="110" font-size="10" fill="#26a69a" font-family="JetBrains Mono,monospace">BULL</text>
      </svg>
    </div>
    <div class="velocity-row" id="analysis-velocity">
      <span style="color:var(--text-muted);">Velocity:</span>
      <span id="analysis-velocity-val" style="color:var(--text-muted);">--</span>
    </div>
    <div style="padding:0 14px 10px;">
      <div class="panel-header" style="padding-left:0;border:none;margin-bottom:6px;">Per Ticker</div>
      <div id="analysis-ticker-bars"><div style="color:var(--text-muted);font-size:12px;">Add tickers to watchlist.</div></div>
    </div>
    <div style="padding:0 14px 10px;border-top:1px solid var(--bg-tertiary);">
      <div class="panel-header" style="padding-left:0;border:none;margin:8px 0 6px;">WSB Radar</div>
      <div id="analysis-wsb"><div class="spinner"></div></div>
    </div>
  `

  center.innerHTML = `
    <div class="panel-header">&#9635; Sector Heatmap</div>
    <div id="analysis-heatmap" class="heatmap-grid"></div>
    <div class="panel-header" style="margin-top:8px;">&#9670; Macro Narrative</div>
    <div id="analysis-narrative" class="narrative-body">
      <div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);"><div class="spinner"></div> Generating...</div>
    </div>
  `

  right.innerHTML = `
    <div class="panel-header">&#9654; Recent HIGH/MEDIUM Articles</div>
    <div id="analysis-articles" style="padding:8px 12px;"></div>
  `

  // Init Split
  try {
    Split(['#analysis-left','#analysis-center','#analysis-right'], {
      sizes: [28, 42, 30],
      gutterSize: 6,
      minSize: [200, 280, 200],
    })
  } catch (e) { console.warn('[analysis] Split error:', e) }

  await _analysisRefreshSentiment()
  await _analysisRefreshHeatmap()
  await _analysisRefreshNarrative()
  await _analysisRefreshWsb()
  _analysisLoadArticles()

  if (_analysisSentTimer) clearInterval(_analysisSentTimer)
  _analysisSentTimer = setInterval(_analysisRefreshSentiment, 60000)
  if (_analysisWsbTimer)  clearInterval(_analysisWsbTimer)
  _analysisWsbTimer  = setInterval(_analysisRefreshWsb, 900000)
}

async function _analysisRefreshSentiment() {
  try {
    const data = await apiAnalysisSentiment()
    _analysisUpdateGauge(data.overall || 0)
    _analysisUpdateVelocity(data.velocity || 0)
    _analysisUpdateTickerBars(data.per_ticker || {})
  } catch (e) { console.warn('[analysis] sentiment:', e) }
}

function _analysisUpdateGauge(score) {
  const needle = document.getElementById('gauge-needle')
  const text   = document.getElementById('gauge-score-text')
  if (!needle || !text) return
  // Map -100..+100 → -90deg..+90deg
  const deg = (score / 100) * 90
  needle.style.transform = `rotate(${deg}deg)`
  text.textContent = Math.round(score)
  const color = score > 10 ? '#26a69a' : score < -10 ? '#ef5350' : '#6c7086'
  text.setAttribute('fill', color)
}

function _analysisUpdateVelocity(vel) {
  const el = document.getElementById('analysis-velocity-val')
  if (!el) return
  const arrow = vel > 0 ? '&#8679;' : vel < 0 ? '&#8681;' : '&#8680;'
  const color = vel > 0 ? 'var(--accent-green)' : vel < 0 ? 'var(--accent-red)' : 'var(--text-muted)'
  el.innerHTML = `<span style="color:${color}">${arrow} ${vel > 0 ? '+' : ''}${vel.toFixed(1)}</span>`
}

function _analysisUpdateTickerBars(perTicker) {
  const el = document.getElementById('analysis-ticker-bars')
  if (!el) return
  const entries = Object.entries(perTicker)
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No watchlist data.</div>'
    return
  }
  el.innerHTML = entries.map(([ticker, score]) => {
    const pct  = Math.max(0, Math.min(100, (score + 100) / 2))
    const color = score > 10 ? 'var(--accent-green)' : score < -10 ? 'var(--accent-red)' : 'var(--text-muted)'
    // Bar anchored at center (50%)
    const barLeft  = score >= 0 ? '50%' : `${pct}%`
    const barWidth = score >= 0 ? `${pct - 50}%` : `${50 - pct}%`
    return `
      <div class="ticker-bar-row">
        <span class="ticker-bar-label">${ticker}</span>
        <div class="ticker-bar-bg">
          <div class="ticker-bar-fill" style="left:${barLeft};width:${barWidth};background:${color};"></div>
        </div>
        <span class="ticker-bar-score" style="color:${color};">${score > 0 ? '+' : ''}${score.toFixed(0)}</span>
      </div>`
  }).join('')
}

async function _analysisRefreshHeatmap() {
  const el = document.getElementById('analysis-heatmap')
  if (!el) return
  try {
    const data = await apiAnalysisHeatmap()
    const entries = Object.entries(data)
    if (!entries.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px;">No heatmap data yet.</div>'
      return
    }
    el.innerHTML = entries.map(([sector, score]) => {
      const color = score > 10 ? '#26a69a' : score < -10 ? '#ef5350' : '#6c7086'
      const bg    = score > 10 ? 'rgba(38,166,154,0.08)' : score < -10 ? 'rgba(239,83,80,0.08)' : 'transparent'
      return `
        <div class="heatmap-cell" style="background:${bg};border-color:${color}40;">
          <span class="heatmap-cell-name">${sector}</span>
          <span class="heatmap-cell-score" style="color:${color};">${score > 0 ? '+' : ''}${score.toFixed(0)}</span>
        </div>`
    }).join('')
  } catch (e) { el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:12px;">Heatmap unavailable.</div>` }
}

async function _analysisRefreshNarrative() {
  const el = document.getElementById('analysis-narrative')
  if (!el) return
  try {
    const data = await apiAiMacroNarrative()
    const regimeClass = {
      'RISK-ON': 'badge--risk-on', 'RISK-OFF': 'badge--risk-off',
      'EVENT-DRIVEN': 'badge--event-driven', 'CHOPPY': 'badge--choppy',
    }[data.regime] || 'badge--choppy'
    el.innerHTML = `
      <span class="badge ${regimeClass} narrative-regime">${data.regime || 'UNKNOWN'}</span>
      <p>${data.narrative || 'Generating narrative...'}</p>
      ${data.generated_at ? `<div style="color:var(--text-muted);font-size:11px;margin-top:8px;">${_analysisRelTime(data.generated_at)}</div>` : ''}
    `
  } catch (e) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Narrative unavailable.</div>' }
}

async function _analysisRefreshWsb() {
  const el = document.getElementById('analysis-wsb')
  if (!el) return
  try {
    const data = await apiAnalysisWsb()
    const list = Array.isArray(data) ? data.slice(0, 5) : []
    if (!list.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No WSB data.</div>'; return }
    el.innerHTML = list.map(item => {
      const ticker   = item.ticker   || item.symbol || item.Ticker || '?'
      const mentions = item.mentions || item.mention_count || item.count || 0
      const sent     = (item.sentiment || '').toLowerCase()
      const sentClass = sent.includes('bull') ? 'badge--bullish' : sent.includes('bear') ? 'badge--bearish' : 'badge--neutral'
      return `
        <div class="wsb-row">
          <span class="ticker-chip">${ticker}</span>
          <span style="color:var(--text-muted);font-size:11px;">${mentions} mentions</span>
          <span class="badge ${sentClass}" style="font-size:10px;padding:1px 6px;">${item.sentiment || 'Neutral'}</span>
        </div>`
    }).join('')
  } catch (e) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">WSB unavailable.</div>' }
}

async function _analysisLoadArticles() {
  const el = document.getElementById('analysis-articles')
  if (!el) return
  try {
    const articles = await apiFeedLatest({ limit: 30 })
    const filtered = (articles || []).filter(a => a.relevance === 'HIGH' || a.relevance === 'MEDIUM')
    if (!filtered.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No articles yet.</div>'; return }
    el.innerHTML = filtered.slice(0, 20).map(a => {
      const rel  = (a.relevance || '').toLowerCase()
      const sent = (a.sentiment || 'Neutral').toLowerCase()
      return `
        <div class="news-card news-card--${rel}" style="margin-bottom:6px;">
          <div class="news-card__header">
            <span class="badge badge--${rel}">${a.relevance}</span>
            <span class="badge badge--${sent}">${a.sentiment}</span>
          </div>
          <div class="news-card__title" style="font-size:12px;">${a.title || ''}</div>
          <div class="news-card__time" style="font-size:11px;color:var(--text-muted);margin-top:4px;">${_analysisRelTime(a.published_at)}</div>
        </div>`
    }).join('')
  } catch (e) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Articles unavailable.</div>' }
}

function _analysisRelTime(iso) {
  if (!iso) return ''
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s/60)}m ago`
    return `${Math.floor(s/3600)}h ago`
  } catch (_) { return '' }
}
