// SPA Router — mirrors QuantTERMINAL_OS router.js
function navigateTo(pageName) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(el => {
    el.classList.remove('active')
  })

  // Show target page
  const target = document.getElementById('page-' + pageName)
  if (target) {
    target.classList.add('active')
  } else {
    console.warn('[Router] Page not found:', pageName)
    return
  }

  // Update nav active states
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName)
  })

  // Dispatch page-activated event
  document.dispatchEvent(
    new CustomEvent('page-activated', { detail: { page: pageName } })
  )
}

window.navigateTo = navigateTo
