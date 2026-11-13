import { store } from './dom.js'

// Light or dark: the system's, unless chosen here (remembered per browser).
// The page sets it first thing, so it doesn't flash.
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? { matches: false, addEventListener() {} }
const listeners = new Set()

// What was chosen: 'system', 'light' or 'dark'.
export const themeChoice = () => document.documentElement.dataset.theme || 'system'
// What is on screen now.
export const themeNow = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')

export function setTheme(choice) {
  if (choice === 'light' || choice === 'dark') { document.documentElement.dataset.theme = choice; store.set('pishaTheme', choice) }
  else { delete document.documentElement.dataset.theme; store.del('pishaTheme') }
  for (const f of listeners) f()
}
export const toggleTheme = () => setTheme(themeNow() === 'dark' ? 'light' : 'dark')
export const onTheme = f => { listeners.add(f); return () => listeners.delete(f) }
darkQuery.addEventListener('change', () => { for (const f of listeners) f() })

// The colour of the phone's bar, installed as an app: the theme on screen,
// also when it was chosen here rather than by the system.
function themeBar() {
  const now = themeNow()
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (document.documentElement.dataset.theme) m.setAttribute('media', /dark/.test(m.dataset.was ??= m.getAttribute('media') ?? '') === (now === 'dark') ? 'all' : 'not all')
    else if (m.dataset.was != null) m.setAttribute('media', m.dataset.was)
  }
}
onTheme(themeBar)
themeBar()
