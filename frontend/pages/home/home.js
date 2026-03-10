let _homeInitDone = false
let _homeRefreshTimer = null

async function initHome() {
  if (_homeInitDone) return
  _homeInitDone = true

  // Split.js
  try {
    Split(['#home-left', '#home-right'], {
      sizes: [60, 40],
      gutterSize: 6,
      minSize: [280, 240],
    })
  } catch (e) {
    console.warn('[home] Split.js error:', e)
  }

  await _homeLoadNews()
  _homeLoadBrief()
  _homeLoadPoly()

  // Refresh news every 30s
  if (_homeRefreshTimer) clearInterval(_homeRefreshTimer)
  _homeRefreshTimer = setInterval(_homeLoadNews, 30000)
}

async function _homeLoadNews() {
  const list = document.getElementById('home-news-list')
  if (!list) return
  try {
    const articles = await apiFeedLatest({ limit: 20 })
    if (!articles || articles.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px 0;">No articles yet. Configure API keys in Synchro.</div>'
      return
    }
    list.innerHTML = articles.map(a => _buildNewsCard(a)).join('')

    // Ticker chip click → navigate to watchlist
    list.querySelectorAll('.ticker-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        navigateTo('watchlist')
      })
    })
  } catch (e) {
    list.innerHTML = `<div class="notification notification--error">Failed to load news: ${e.message}</div>`
  }
}

async function _homeLoadBrief() {
  const body = document.getElementById('home-brief-body')
  if (!body) return
  try {
    const brief = await apiAiPremarketBrief()
    if (!brief || !brief.market_bias) {
      body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Brief not available yet. Will generate at 07:00 UTC or on demand.</div>'
      return
    }

    const biasClass = brief.market_bias === 'Bullish' ? 'badge--bullish'
                    : brief.market_bias === 'Bearish' ? 'badge--bearish' : 'badge--neutral'

    let html = `
      <div class="brief-bias">
        <span class="badge ${biasClass}">${brief.market_bias}</span>
        <span style="color:var(--text-primary);font-size:12px;font-weight:500;">Market Bias</span>
      </div>
      <div class="brief-rationale">${brief.bias_rationale || ''}</div>
    `

    if (brief.top_catalysts && brief.top_catalysts.length) {
      html += '<div class="brief-section-title">Top Catalysts</div>'
      brief.top_catalysts.slice(0, 4).forEach(c => {
        html += `
          <div class="brief-catalyst-row">
            <span class="ticker-chip">${c.ticker || '?'}</span>
            <span style="flex:1;color:var(--text-primary);">${c.headline || ''}</span>
          </div>`
      })
    }

    if (brief.tickers_to_watch && brief.tickers_to_watch.length) {
      html += '<div class="brief-section-title">Tickers to Watch</div>'
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;">'
      brief.tickers_to_watch.forEach(t => {
        html += `<span class="ticker-chip">${t.ticker}</span>`
      })
      html += '</div>'
    }

    if (brief.generated_at) {
      html += `<div style="color:var(--text-muted);font-size:11px;margin-top:10px;">Generated: ${_relTime(brief.generated_at)}</div>`
    }
    body.innerHTML = html
  } catch (e) {
    body.innerHTML = `<div class="notification notification--warning">Brief unavailable: ${e.message}</div>`
  }
}

async function _homeLoadPoly() {
  const body = document.getElementById('home-poly-body')
  if (!body) return
  try {
    const markets = await apiPolymarkets()
    const top3 = (markets || []).slice(0, 3)
    if (!top3.length) {
      body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No Polymarket data yet.</div>'
      return
    }
    body.innerHTML = top3.map(m => {
      const pct = Math.round((m.probability || 0) * 100)
      const prev = m.prev_probability || m.probability
      const delta = Math.round((m.probability - prev) * 100)
      const deltaHtml = delta !== 0
        ? `<span class="${delta > 0 ? 'poly-delta-pos' : 'poly-delta-neg'}">${delta > 0 ? '+' : ''}${delta}%</span>`
        : ''
      return `
        <div class="poly-row">
          <div class="poly-question">${m.question || 'Unknown'}</div>
          <div class="poly-bar-wrap">
            <div class="poly-bar-bg"><div class="poly-bar-fill" style="width:${pct}%"></div></div>
            <span class="poly-pct">${pct}%</span>
            ${deltaHtml}
          </div>
        </div>`
    }).join('')
  } catch (e) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Polymarket unavailable.</div>'
  }
}

function _buildNewsCard(a) {
  const rel   = (a.relevance || 'MEDIUM').toLowerCase()
  const sent  = (a.sentiment || 'Neutral').toLowerCase()
  const tickers = _parseTickers(a.tickers)
  const impact  = Math.min(10, Math.max(1, a.impact_score || 5))
  const impactPct = (impact / 10) * 100

  const tickerChips = tickers.map(t =>
    `<span class="ticker-chip">${t}</span>`
  ).join('')

  return `
    <div class="news-card news-card--${rel}">
      <div class="news-card__header">
        <span class="badge badge--${rel}">${a.relevance || 'MED'}</span>
        <span class="badge badge--${sent}">${a.sentiment || 'Neutral'}</span>
        ${a.catalyst_type ? `<span class="badge badge--catalyst">${a.catalyst_type}</span>` : ''}
        <div class="impact-bar" title="Impact ${impact}/10">
          <div class="impact-bar__fill" style="width:${impactPct}%"></div>
        </div>
      </div>
      <div class="news-card__title">${_esc(a.title || '')}</div>
      ${a.summary ? `<div class="news-card__summary">${_esc(a.summary)}</div>` : ''}
      <div class="news-card__footer">
        <div class="news-card__tickers">${tickerChips}</div>
        <span class="news-card__source">${_esc(a.source || '')}</span>
        <span class="news-card__time">${_relTime(a.published_at)}</span>
      </div>
    </div>`
}

function _parseTickers(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch (_) { return [] }
}

function _relTime(iso) {
  if (!iso) return ''
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const s = Math.floor(diff / 1000)
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s/60)}m ago`
    if (s < 86400)return `${Math.floor(s/3600)}h ago`
    return `${Math.floor(s/86400)}d ago`
  } catch (_) { return '' }
}

function _esc(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
}
