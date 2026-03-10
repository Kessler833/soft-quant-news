let _calInitDone = false
let _calCountdownTimer = null
let _calNextEvent = null

async function initCalendar() {
  if (_calInitDone) return
  _calInitDone = true

  try {
    Split(['#cal-left','#cal-right'], { sizes:[60,40], gutterSize:6, minSize:[280,220] })
  } catch (e) { console.warn('[calendar] Split error:', e) }

  await _calLoadEvents()
  await _calLoadPolyAlerts()

  // Live countdown tick
  if (_calCountdownTimer) clearInterval(_calCountdownTimer)
  _calCountdownTimer = setInterval(_calTickCountdown, 1000)
}

async function _calLoadEvents() {
  const list = document.getElementById('cal-list')
  if (!list) return
  list.innerHTML = '<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:12px;"><div class="spinner"></div> Loading...</div>'
  try {
    const events = await apiCalendarEvents()
    if (!events || events.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No upcoming events in next 7 days.</div>'
      return
    }

    // Find next upcoming event for countdown
    _calNextEvent = events.find(e => e.seconds_until > 0) || null

    list.innerHTML = events.map(ev => {
      const isPast  = ev.seconds_until < 0
      const isToday = !isPast && ev.seconds_until < 86400
      const cls = isPast ? 'cal-event--past' : isToday ? 'cal-event--today' : 'cal-event--soon'

      const countdownStr = isPast
        ? `Past`
        : ev.seconds_until < 3600
          ? `${Math.floor(ev.seconds_until/60)}m away`
          : ev.seconds_until < 86400
            ? `${Math.floor(ev.seconds_until/3600)}h ${Math.floor((ev.seconds_until%3600)/60)}m away`
            : `${Math.floor(ev.seconds_until/86400)}d away`

      return `
        <div class="cal-event ${cls}">
          <div class="cal-event-name">${_calEsc(ev.name)}</div>
          <div class="cal-event-meta">
            <span>&#9783; ${ev.datetime_cet || ev.datetime_utc || ''}</span>
            <span class="badge badge--${ev.importance === 'HIGH' ? 'high' : ev.importance === 'MEDIUM' ? 'medium' : 'low'}">
              ${ev.importance || 'LOW'}
            </span>
            <span class="cal-event-countdown">${_calEsc(countdownStr)}</span>
          </div>
        </div>`
    }).join('')

    _calRenderCountdown()
  } catch (e) {
    list.innerHTML = `<div class="notification notification--error">Error: ${e.message}</div>`
  }
}

async function _calLoadPolyAlerts() {
  const el = document.getElementById('cal-poly-alerts')
  if (!el) return
  try {
    const alerts = await apiPolymarketAlerts()
    if (!alerts || alerts.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No probability spikes detected (&gt;5%).</div>'
      return
    }
    el.innerHTML = alerts.map(m => {
      const delta = Math.round((m.probability - (m.prev_probability || m.probability)) * 100)
      const up = delta >= 0
      return `
        <div class="poly-alert-row">
          <div class="poly-alert-question">${_calEsc(m.question || '')}</div>
          <div class="poly-alert-delta poly-alert-delta--${up?'up':'down'}">
            ${up?'&#8679;':'&#8681;'} ${up?'+':''}${delta}% swing
            &mdash; now ${Math.round((m.probability||0)*100)}%
          </div>
        </div>`
    }).join('')
  } catch (e) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Polymarket alerts unavailable.</div>'
  }
}

function _calRenderCountdown() {
  const el = document.getElementById('cal-countdown')
  if (!el) return
  if (!_calNextEvent) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No upcoming events.</div>'
    return
  }
  const targetMs = new Date(_calNextEvent.datetime_utc).getTime()
  const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000))
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  el.innerHTML = `
    <div class="countdown-event-name">Next: <strong>${_calEsc(_calNextEvent.name)}</strong></div>
    <div class="countdown-box">
      <div class="countdown-unit"><span class="countdown-num" id="cd-h">${String(h).padStart(2,'0')}</span><span class="countdown-label">hrs</span></div>
      <div class="countdown-unit"><span class="countdown-num" id="cd-m">${String(m).padStart(2,'0')}</span><span class="countdown-label">min</span></div>
      <div class="countdown-unit"><span class="countdown-num" id="cd-s">${String(s).padStart(2,'0')}</span><span class="countdown-label">sec</span></div>
    </div>`
}

function _calTickCountdown() {
  if (!_calNextEvent) return
  const targetMs = new Date(_calNextEvent.datetime_utc).getTime()
  const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000))
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  const hEl = document.getElementById('cd-h')
  const mEl = document.getElementById('cd-m')
  const sEl = document.getElementById('cd-s')
  if (hEl) hEl.textContent = String(h).padStart(2,'0')
  if (mEl) mEl.textContent = String(m).padStart(2,'0')
  if (sEl) sEl.textContent = String(s).padStart(2,'0')
}

function _calEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
