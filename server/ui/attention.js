import { store } from './dom.js'
import { T } from './i18n.js'
import { state } from './state.js'

// Telling the user something reached their inbox while they look elsewhere:
// the count in the tab's title and on the installed app's icon, and, if they
// asked for it in Settings, a notice from the system (with a sound, if they
// like) while the dashboard is not in view. Only while it is open somewhere:
// with the browser closed, nothing (that would need push notifications).

const BASE_TITLE = document.title || 'Pisha'
let shownCount = -1

// What waits on the user, as the sidebar counts it.
const openItems = () => state.inbox.filter(i => !i.resolved_at)

export function showCount() {
  const n = openItems().length
  if (n === shownCount) return
  shownCount = n
  document.title = n ? `(${n > 99 ? '99+' : n}) ${BASE_TITLE}` : BASE_TITLE
  try {
    if (n) navigator.setAppBadge?.(n)?.catch?.(() => {})
    else navigator.clearAppBadge?.()?.catch?.(() => {})
  } catch { /* (not an installed app, or not this browser) */ }
}

// The user's choice, in this browser and for every company (it is about
// this device): off, on, or on with a sound.
export const NOTIFY = ['off', 'on', 'sound']
export const notifyChoice = () => (NOTIFY.includes(store.get('pishaNotify')) ? store.get('pishaNotify') : 'off')
export const notifySupported = () => typeof Notification === 'function'
export async function setNotify(choice) {
  if (!NOTIFY.includes(choice)) return notifyChoice()
  if (choice !== 'off' && notifySupported() && Notification.permission === 'default') await Notification.requestPermission().catch(() => {})
  store.set('pishaNotify', choice)
  return choice
}
export const notifyBlocked = () => notifySupported() && Notification.permission === 'denied'

// Which open entries the dashboard has already seen (null: none yet, the
// first list is what was there, not what arrived).
let known = null
export function inboxArrived() {
  const open = openItems()
  const fresh = known ? open.filter(i => !known.has(i.id)) : []
  known = new Set(open.map(i => i.id))
  showCount()
  if (!fresh.length || notifyChoice() === 'off' || !notifySupported() || Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  // (One notice for several at once: the newest, and how many.)
  const i = fresh[0]
  const title = i.kind === 'ask' ? T.notifyAsk(i.session) : T.notifyTell(i.session)
  const body = (i.text.replace(/\s+/g, ' ').slice(0, 160)) + (fresh.length > 1 ? `\n${T.notifyMore(fresh.length - 1)}` : '')
  try {
    const n = new Notification(title, { body, tag: `pisha-${state.company}-inbox`, icon: '/icons/icon-192.png' })
    n.onclick = () => { window.focus(); location.hash = `#/inbox/i${i.id}`; n.close() }
  } catch { /* (some phones only notify from a service worker) */ }
  if (notifyChoice() === 'sound') chime()
}

// Two short soft notes, made here: no sound file to fetch.
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const at = ctx.currentTime
    for (const [f, t] of [[880, 0], [1320, 0.12]]) {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, at + t)
      g.gain.exponentialRampToValueAtTime(0.12, at + t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + t + 0.35)
      o.connect(g).connect(ctx.destination)
      o.start(at + t); o.stop(at + t + 0.4)
    }
    setTimeout(() => ctx.close().catch(() => {}), 1000)
  } catch { /* (no sound here) */ }
}
