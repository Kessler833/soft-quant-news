// App init — mirrors QuantTERMINAL_OS app.js. MUST be loaded last.

const _v = Date.now()

async function _injectPageHTML(containerId, path) {
  try {
    const r = await fetch(path + '?v=' + _v, { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const html = await r.text()
    const el = document.getElementById(containerId)
    if (el) el.innerHTML = html
  } catch (e) {
    console.warn('[App] inject failed:', path, e)
  }
}

async function init() {
  await _injectPageHTML('page-home',      './pages/home/home.html')
  await _injectPageHTML('page-feed',      './pages/feed/feed.html')
  await _injectPageHTML('page-analysis',  './pages/analysis/analysis.html')
  await _injectPageHTML('page-watchlist', './pages/watchlist/watchlist.html')
  await _injectPageHTML('page-calendar',  './pages/calendar/calendar.html')
  await _injectPageHTML('page-ai',        './pages/ai/ai.html')
  await _injectPageHTML('page-synchro',   './pages/synchro/synchro.html')

  // Initial page inits
  try { initHome()    } catch (e) { console.warn('[Init] home:', e) }
  try { initSynchro() } catch (e) { console.warn('[Init] synchro:', e) }

  // Nav click handlers
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page))
  })

  // Page-activated event router
  document.addEventListener('page-activated', (e) => {
    const p = e.detail.page
    if (p === 'home')      { try { initHome()      } catch (_) {} }
    if (p === 'feed')      { try { initFeed()      } catch (_) {} }
    if (p === 'analysis')  { try { initAnalysis()  } catch (_) {} }
    if (p === 'watchlist') { try { initWatchlist() } catch (_) {} }
    if (p === 'calendar')  { try { initCalendar()  } catch (_) {} }
    if (p === 'ai')        { try { initAi()        } catch (_) {} }
    if (p === 'synchro')   { try { initSynchro()   } catch (_) {} }
  })
}

init()
