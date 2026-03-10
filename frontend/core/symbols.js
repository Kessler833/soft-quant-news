// Symbol Browser Modal
// Opens on any element with class 'open-symbol-browser' + data-target="<inputId>"

const COMMON_TICKERS = [
  // Indices / ETFs
  'SPY','QQQ','IWM','DIA','VXX','TQQQ','SQQQ','SPXU','UPRO',
  // Mega-cap Tech
  'AAPL','MSFT','NVDA','META','GOOGL','GOOG','AMZN','TSLA','AMD','INTC','QCOM','AVGO',
  // Finance
  'JPM','GS','BAC','WFC','MS','C','BRK.B',
  // Energy
  'XOM','CVX','COP','SLB',
  // Health
  'JNJ','PFE','MRNA','UNH','LLY','ABBV',
  // Industrial
  'BA','CAT','GE','HON',
  // Consumer
  'WMT','TGT','COST','AMZN',
  // Real Estate / Utilities
  'SPG','AMT','PLD','NEE','DUK',
  // Materials
  'LIN','NEM',
  // Other popular
  'NFLX','UBER','COIN','PLTR','SOFI','RIVN','LCID','GME','AMC',
]

;(function () {
  // Build modal DOM once
  const modal = document.createElement('div')
  modal.id = 'symbol-browser-modal'
  modal.className = 'modal'
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Symbol Browser</h3>
        <button class="modal-close" id="symbol-modal-close">&#x2715;</button>
      </div>
      <div class="modal-body" style="padding:12px">
        <input
          id="symbol-search-input"
          type="text"
          placeholder="Search ticker..."
          style="
            width:100%; padding:8px 10px;
            background:var(--bg-tertiary); border:1px solid var(--bg-tertiary);
            border-radius:4px; color:var(--text-primary);
            font-family:'JetBrains Mono',monospace; font-size:13px;
            outline:none; margin-bottom:10px;
          "
        />
        <div id="symbol-grid" style="
          display:flex; flex-wrap:wrap; gap:6px; max-height:340px;
          overflow-y:auto;
        "></div>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  let _targetInputId = null

  function renderGrid(filter = '') {
    const grid = document.getElementById('symbol-grid')
    grid.innerHTML = ''
    const query = filter.trim().toUpperCase()
    const list = query
      ? COMMON_TICKERS.filter(t => t.includes(query))
      : COMMON_TICKERS
    list.forEach(ticker => {
      const chip = document.createElement('span')
      chip.className = 'ticker-chip'
      chip.textContent = ticker
      chip.addEventListener('click', () => selectSymbol(ticker))
      grid.appendChild(chip)
    })
  }

  function selectSymbol(ticker) {
    if (_targetInputId) {
      const input = document.getElementById(_targetInputId)
      if (input) {
        input.value = ticker
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    closeModal()
  }

  function openModal(targetInputId) {
    _targetInputId = targetInputId
    modal.classList.add('open')
    const searchEl = document.getElementById('symbol-search-input')
    searchEl.value = ''
    renderGrid()
    setTimeout(() => searchEl.focus(), 50)
  }

  function closeModal() {
    modal.classList.remove('open')
    _targetInputId = null
  }

  // Search filtering
  document.getElementById('symbol-search-input').addEventListener('input', e => {
    renderGrid(e.target.value)
  })

  document.getElementById('symbol-modal-close').addEventListener('click', closeModal)

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal()
  })

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeModal()
  })

  // Delegate: open on any .open-symbol-browser click
  document.addEventListener('click', e => {
    const btn = e.target.closest('.open-symbol-browser')
    if (btn) {
      const targetId = btn.dataset.target
      if (targetId) openModal(targetId)
    }
  })

  window.openSymbolBrowser = openModal
  window.closeSymbolBrowser = closeModal
})()
