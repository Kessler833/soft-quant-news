let _wlInitDone = false
let _wlSelected = null

async function initWatchlist() {
  if (_wlInitDone) return
  _wlInitDone = true

  try {
    Split(['#wl-left','#wl-right'], { sizes:[35,65], gutterSize:6, minSize:[200,320] })
  } catch (e) { console.warn('[watchlist] Split error:', e) }

  await _wlRender()

  document.getElementById('wl-add-btn')?.addEventListener('click', _wlAdd)
  document.getElementById('wl-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _wlAdd()
  })
}

async function _wlRender() {
  const list = document.getElementById('wl-list')
  if (!list) return
  try {
    const tickers = await apiWatchlistGet()
    QuantCache.saveWatchlist(tickers)
    if (!tickers.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">No tickers in watchlist. Add some above.</div>'
      return
    }
    list.innerHTML = tickers.map(t => `
      <div class="wl-item${_wlSelected===t?' selected':''}" data-ticker="${t}">
        <span class="wl-item-ticker">${t}</span>
        <span class="wl-item-quote" id="wl-quote-${t}">--</span>
        <button class="wl-remove-btn" data-remove="${t}" title="Remove">&#x2715;</button>
      </div>`).join('')

    list.querySelectorAll('.wl-item').forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('.wl-remove-btn')) return
        _wlSelectTicker(item.dataset.ticker)
      })
    })
    list.querySelectorAll('.wl-remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        _wlRemove(btn.dataset.remove)
      })
    })

    // Fetch live quotes
    tickers.forEach(t => _wlFetchQuote(t))

    if (_wlSelected && tickers.includes(_wlSelected)) {
      _wlSelectTicker(_wlSelected)
    }
  } catch (e) {
    list.innerHTML = `<div class="notification notification--error">Error: ${e.message}</div>`
  }
}

async function _wlFetchQuote(ticker) {
  const el = document.getElementById(`wl-quote-${ticker}`)
  if (!el) return
  try {
    const q = await apiPriceQuote(ticker)
    if (q && q.price) el.textContent = `$${q.price.toFixed(2)}`
    else el.textContent = 'N/A'
  } catch (_) { if (el) el.textContent = 'N/A' }
}

async function _wlAdd() {
  const input = document.getElementById('wl-input')
  if (!input) return
  const ticker = input.value.trim().toUpperCase()
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    _wlShowMsg('Invalid ticker symbol.', 'error'); return
  }
  try {
    await apiWatchlistAdd(ticker)
    input.value = ''
    _wlShowMsg(`${ticker} added.`, 'success')
    _wlInitDone = false  // allow re-render
    await _wlRender()
    _wlInitDone = true
  } catch (e) { _wlShowMsg(`Error: ${e.message}`, 'error') }
}

async function _wlRemove(ticker) {
  try {
    await apiWatchlistRemove(ticker)
    if (_wlSelected === ticker) {
      _wlSelected = null
      const detail = document.getElementById('wl-detail')
      if (detail) detail.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Select a ticker to view details.</div>'
    }
    await _wlRender()
  } catch (e) { _wlShowMsg(`Error: ${e.message}`, 'error') }
}

async function _wlSelectTicker(ticker) {
  _wlSelected = ticker
  // Update selected state
  document.querySelectorAll('.wl-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.ticker === ticker)
  })
  const detail = document.getElementById('wl-detail')
  if (!detail) return
  detail.innerHTML = `
    <div class="wl-detail-ticker">${ticker}</div>
    <div class="wl-detail-price" id="wl-detail-price"><div class="spinner"></div></div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button class="wl-btn wl-btn--primary" id="wl-bullbear-btn">&#10022; Bull/Bear Analysis</button>
    </div>
    <div id="wl-bullbear-wrap"></div>
    <div class="panel-header" style="margin-bottom:8px;padding-left:0;border:none;">Recent News</div>
    <div id="wl-news-wrap"><div class="spinner"></div></div>
  `

  document.getElementById('wl-bullbear-btn')?.addEventListener('click', () => _wlLoadBullBear(ticker))

  // Load quote
  try {
    const q = await apiPriceQuote(ticker)
    const priceEl = document.getElementById('wl-detail-price')
    if (priceEl) {
      if (q && q.price) {
        priceEl.innerHTML = `$${q.price.toFixed(2)} <span style="font-size:13px;color:var(--text-muted);">bid ${q.bid} / ask ${q.ask}</span>`
      } else {
        priceEl.textContent = 'Price unavailable'
      }
    }
  } catch (_) {
    const priceEl = document.getElementById('wl-detail-price')
    if (priceEl) priceEl.textContent = 'Price unavailable'
  }

  // Load news
  try {
    const articles = await apiFeedTicker(ticker)
    const newsWrap = document.getElementById('wl-news-wrap')
    if (!newsWrap) return
    if (!articles || articles.length === 0) {
      newsWrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No recent news.</div>'
      return
    }
    newsWrap.innerHTML = articles.slice(0, 10).map(a => {
      const rel  = (a.relevance || 'medium').toLowerCase()
      const sent = (a.sentiment || 'neutral').toLowerCase()
      return `
        <div class="news-card news-card--${rel}" style="margin-bottom:6px;">
          <div class="news-card__header">
            <span class="badge badge--${rel}">${a.relevance}</span>
            <span class="badge badge--${sent}">${a.sentiment}</span>
          </div>
          <div class="news-card__title" style="font-size:12px;">${a.title || ''}</div>
          ${a.summary ? `<div class="news-card__summary">${a.summary}</div>` : ''}
          <div class="news-card__time" style="font-size:11px;color:var(--text-muted);margin-top:4px;">${_wlRelTime(a.published_at)}</div>
        </div>`
    }).join('')
  } catch (_) {
    const newsWrap = document.getElementById('wl-news-wrap')
    if (newsWrap) newsWrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">News unavailable.</div>'
  }
}

async function _wlLoadBullBear(ticker) {
  const wrap = document.getElementById('wl-bullbear-wrap')
  if (!wrap) return
  wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:12px;margin-bottom:12px;"><div class="spinner"></div> Generating analysis...</div>'
  try {
    const data = await apiAiBullBear(ticker)
    const leanClass = data.overall_lean === 'Bullish' ? 'badge--bullish' : data.overall_lean === 'Bearish' ? 'badge--bearish' : 'badge--neutral'
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span class="badge ${leanClass}">${data.overall_lean || 'Neutral'}</span>
        <span class="badge badge--neutral">Confidence: ${data.confidence || 'Low'}</span>
      </div>
      <div class="wl-bull-bear">
        <div class="wl-case-box" style="border-left:3px solid var(--accent-green);">
          <div class="wl-case-title" style="color:var(--accent-green);">&#8679; Bull Case</div>
          ${(data.bull_case || []).map(p => `<div class="wl-case-point">${p}</div>`).join('')}
        </div>
        <div class="wl-case-box" style="border-left:3px solid var(--accent-red);">
          <div class="wl-case-title" style="color:var(--accent-red);">&#8681; Bear Case</div>
          ${(data.bear_case || []).map(p => `<div class="wl-case-point">${p}</div>`).join('')}
        </div>
      </div>`
  } catch (e) {
    wrap.innerHTML = `<div class="notification notification--error">Analysis failed: ${e.message}</div>`
  }
}

function _wlShowMsg(msg, type = 'success') {
  const list = document.getElementById('wl-list')
  if (!list) return
  const n = document.createElement('div')
  n.className = `notification notification--${type}`
  n.textContent = msg
  list.prepend(n)
  setTimeout(() => n.remove(), 3000)
}

function _wlRelTime(iso) {
  if (!iso) return ''
  try {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60)   return `${s}s ago`
    if (s < 3600) return `${Math.floor(s/60)}m ago`
    return `${Math.floor(s/3600)}h ago`
  } catch (_) { return '' }
}
