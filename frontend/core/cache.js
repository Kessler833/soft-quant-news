// QuantCache — LocalStorage manager (mirrors QuantTERMINAL_OS pattern)
const CACHE_KEY = 'QuantOS_Cache'

const QuantCache = {
  load() {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch (e) {
      console.warn('[QuantCache] load error:', e)
      return {}
    }
  },

  save(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data))
    } catch (e) {
      console.warn('[QuantCache] save error:', e)
    }
  },

  saveApi(apiData) {
    const cached = this.load()
    cached.api = { ...(cached.api || {}), ...apiData }
    this.save(cached)
  },

  saveParams(params) {
    const cached = this.load()
    cached.params = { ...(cached.params || {}), ...params }
    this.save(cached)
  },

  saveLayout(layout) {
    const cached = this.load()
    cached.layout = { ...(cached.layout || {}), ...layout }
    this.save(cached)
  },

  resetPartial() {
    const cached = this.load()
    delete cached.params
    delete cached.layout
    this.save(cached)
  },

  resetFull() {
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch (e) {
      console.warn('[QuantCache] resetFull error:', e)
    }
  },

  // Watchlist helpers
  saveWatchlist(tickersArray) {
    const cached = this.load()
    cached.watchlist = tickersArray
    this.save(cached)
  },

  loadWatchlist() {
    return (this.load() || {}).watchlist || []
  },

  // API key helpers
  loadApiKeys() {
    return (this.load() || {}).api || {}
  },

  getApiKey(name) {
    return ((this.load() || {}).api || {})[name] || ''
  }
}

window.QuantCache = QuantCache
