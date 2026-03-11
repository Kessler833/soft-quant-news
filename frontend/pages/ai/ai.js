let _aiInitDone = false
let _aiChatHistory = []

async function initAi() {
  if (_aiInitDone) return
  _aiInitDone = true

  try {
    Split(['#ai-left','#ai-right'], { sizes:[55,45], gutterSize:6, minSize:[300,260] })
  } catch (e) { console.warn('[ai] Split error:', e) }

  _aiRenderWelcome()
  _aiLoadBrief()

  const sendBtn   = document.getElementById('ai-chat-send')
  const input     = document.getElementById('ai-chat-input')
  const briefBtn  = document.getElementById('ai-refresh-brief')

  sendBtn?.addEventListener('click', _aiSend)
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _aiSend() }
  })
  briefBtn?.addEventListener('click', () => _aiLoadBrief(true))
}

function _aiRenderWelcome() {
  const messages = document.getElementById('ai-chat-messages')
  if (!messages) return
  messages.innerHTML = ''
  _aiAppendMsg('ai', `Hi. I'm connected to your live news feed.\n\nYou can ask me:\n\u2022 "What's moving markets today?"\n\u2022 "Summarise the NVDA news"\n\u2022 "Is the macro backdrop bullish or bearish?"\n\u2022 "What sectors are getting hit?"\n\nContext window is adjustable above.`)
}

async function _aiSend() {
  const input   = document.getElementById('ai-chat-input')
  const sendBtn = document.getElementById('ai-chat-send')
  const ctxEl   = document.getElementById('ai-ctx-hours')
  if (!input || !sendBtn) return

  const question = input.value.trim()
  if (!question) return

  const ctxHours = parseInt(ctxEl?.value || '4', 10)
  input.value = ''
  sendBtn.disabled = true

  _aiAppendMsg('user', question)
  const thinkingId = _aiAppendThinking()

  try {
    const resp = await apiAiChat(question, ctxHours)
    _aiRemoveThinking(thinkingId)
    _aiAppendMsg('ai', resp.answer || 'No response.')
    _aiChatHistory.push({ role: 'user', text: question })
    _aiChatHistory.push({ role: 'ai',   text: resp.answer || '' })
  } catch (e) {
    _aiRemoveThinking(thinkingId)
    _aiAppendMsg('error', `Error: ${e.message}`)
  } finally {
    sendBtn.disabled = false
    input.focus()
  }
}

// Escape HTML entities first, then convert newlines to <br> so line breaks
// render correctly inside innerHTML without opening XSS vectors.
function _aiAppendMsg(role, text) {
  const messages = document.getElementById('ai-chat-messages')
  if (!messages) return
  const div = document.createElement('div')
  div.className = `ai-msg ai-msg--${role}`
  const now = new Date().toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })
  const escaped = _aiEsc(text).replace(/\n/g, '<br>')
  div.innerHTML = `
    <div class="ai-bubble">${escaped}</div>
    <div class="ai-meta">${now}</div>
  `
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
  return div
}

function _aiAppendThinking(id) {
  const messages = document.getElementById('ai-chat-messages')
  if (!messages) return null
  const uid = 'thinking-' + Date.now()
  const div = document.createElement('div')
  div.className = 'ai-msg ai-msg--ai'
  div.id = uid
  div.innerHTML = `
    <div class="ai-bubble" style="display:flex;align-items:center;gap:10px;color:var(--text-muted);">
      <div class="spinner"></div> Thinking...
    </div>`
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
  return uid
}

function _aiRemoveThinking(id) {
  if (!id) return
  document.getElementById(id)?.remove()
}

async function _aiLoadBrief(forceRegenerate = false) {
  const wrap = document.getElementById('ai-brief-wrap')
  if (!wrap) return

  if (forceRegenerate) {
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;color:var(--text-muted);font-size:12px;padding:8px 0;">
        <div class="spinner"></div> Generating with Ollama...
      </div>`
  } else {
    wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:12px;"><div class="spinner"></div> Loading brief...</div>'
  }

  try {
    const brief = forceRegenerate
      ? await _aiTriggerRegenerate()
      : await apiAiPremarketBrief()

    // Show error state if Ollama is offline or response is empty
    if (!brief || brief.error || !brief.market_bias) {
      const errText = (brief && brief.error) ? brief.error : 'Ollama offline \u2014 start Ollama and set model in Synchro.'
      wrap.innerHTML = `<div class="notification notification--error">&#9888; ${_aiEsc(errText)}</div>`
      return
    }

    const biasClass = brief.market_bias === 'Bullish' ? 'badge--bullish'
                    : brief.market_bias === 'Bearish' ? 'badge--bearish' : 'badge--neutral'

    const sections = [
      { label: 'Market Bias', val: `<span class="badge ${biasClass}">${brief.market_bias}</span>` },
      { label: 'Rationale',   val: _aiEsc(brief.bias_rationale || '--') },
      { label: 'Key Events',  val: _aiEsc((brief.key_events_today || []).join(', ') || 'None') },
      { label: 'Sectors',     val: _aiEsc((brief.sectors_to_watch || []).join(', ') || 'None') },
      {
        label: 'Top Catalysts',
        val: (brief.top_catalysts || []).slice(0,4)
          .map(c => `<span class="ticker-chip">${_aiEsc(c.ticker || '')}</span> ${_aiEsc(c.headline || '')} <span class="badge badge--${(c.impact||'').toLowerCase()}">${_aiEsc(c.impact||'')}</span>`)
          .join('<br>')
      },
      {
        label: 'Watch',
        val: (brief.tickers_to_watch || []).map(t =>
          `<span class="ticker-chip">${_aiEsc(t.ticker || t || '')}</span>`
        ).join(' ')
      },
      { label: 'Generated', val: brief.generated_at ? new Date(brief.generated_at).toLocaleTimeString('de-DE') : '--' },
    ]

    wrap.innerHTML = sections.map(s => `
      <div class="brief-kv">
        <span class="brief-kv-label">${s.label}</span>
        <span class="brief-kv-val">${s.val}</span>
      </div>`).join('')

  } catch (e) {
    wrap.innerHTML = `<div class="notification notification--error">&#9888; Brief error: ${_aiEsc(e.message)}</div>`
  }
}

async function _aiTriggerRegenerate() {
  // POST forces backend to bypass cache and regenerate
  try {
    const result = await fetch('http://localhost:8000/api/ai/premarket-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (result.ok) {
      return await result.json()
    }
  } catch (_) {}
  // Fallback: GET in case POST somehow failed
  return apiAiPremarketBrief()
}

function _aiEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
