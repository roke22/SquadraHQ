import { LOCALE, LANG } from './i18n.js'
import { state, sessions } from './state.js'

// helpers
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const now = () => Date.now() + state.serverSkew
// "3 min ago", "now": in the reader's language, from the browser.
const RTF = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' })
export function ago(t) {
  const s = Math.round((t - now()) / 1000), a = Math.abs(s)
  return a < 45 ? RTF.format(0, 'second') : a < 3600 ? RTF.format(Math.round(s / 60), 'minute') : a < 86400 ? RTF.format(Math.round(s / 3600), 'hour') : RTF.format(Math.round(s / 86400), 'day')
}

// (One formatter for all: building one per call costs more than the rest of a redraw.)
const TIME_FMT = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })
export const hhmm = ms => TIME_FMT.format(new Date(ms))
export const dur = ms => {
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1).replace('.', LANG === 'es' ? ',' : '.')} s`
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
export const kfmt = v => { const n = Number(v) || 0; return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n) }
export const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
export const base = p => String(p ?? '').split('/').filter(Boolean).pop() ?? ''
const roleOf = name => sessions.get(name)?.role ?? ''
