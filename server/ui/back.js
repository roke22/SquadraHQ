import { $ } from './dom.js'
import { T } from './i18n.js'
import { state, sessions, hosts } from './state.js'
import { esc } from './format.js'
import { icon } from './icons.js'
import { parseRoute } from './routes.js'

// The back button in the header. It walks the browser's own history, so it
// and the phone's back gesture always agree; what it remembers of each step
// is only the address, kept for this tab, to say where back goes.
// Moving inside one place (a session's chat or terminal, one inbox entry to
// the next, the list or the org chart of the teams) replaces the step
// instead of adding one: back leaves the place, not the tab.
// With nowhere it came from (opened from a link or a notification), back goes
// one level up: a session to its team, a terminal to its machine.

const KEY = 'pishaBack'
let stack = [location.hash] // the address of each step of this tab, by its index
let at = 0

const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) } catch { return null } }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ stack, at })) } catch { /* (private window: in memory only) */ } }
const mark = () => history.replaceState({ ...(history.state ?? {}), sq: at }, '')
const stepOf = () => (Number.isInteger(history.state?.sq) && history.state.sq >= 0 ? history.state.sq : null)

// (A reload keeps both: the steps, and the index on each.)
{
  const kept = load(), sq = stepOf()
  if (sq !== null && Array.isArray(kept?.stack) && sq < kept.stack.length && kept.stack.every(h => typeof h === 'string')) { stack = kept.stack; at = sq; stack[at] = location.hash }
  else mark()
  save()
}

// A place: what back leaves, and what it skips.
export function placeKey(r) {
  switch (r.view) {
    case 'inbox': return r.item ? 'inbox:item' : 'inbox'
    case 'teams': case 'org': return 'teams'
    case 'mosaic': return r.squad ? `live:${r.squad}` : 'teams'
    case 'team': return `team:${r.squad}`
    case 'session': return `s:${r.name}`
    case 'terminal': return `t:${r.host}/${r.term}`
    case 'hosts': return r.host ? `h:${r.host}` : 'hosts'
    // (One board, whichever task is open in it.)
    case 'board': return `b:${r.board}`
    default: return r.view
  }
}
const keyOf = hash => placeKey(parseRoute(hash))

// One level up. Null: one of the main places, which the sidebar and the bar
// at the bottom already reach, and which have no back.
export function parentOf(r) {
  const enc = encodeURIComponent
  switch (r.view) {
    case 'inbox': return r.item ? (r.tab === 'done' ? '#/inbox/done' : '#/inbox') : null
    case 'teams': case 'org': return null
    case 'mosaic': return r.squad ? `#/q/${enc(r.squad)}` : null
    case 'hosts': return r.host ? '#/hosts' : null
    case 'addmachine': return '#/hosts'
    case 'boards': return null
    case 'usage': return null
    case 'board': return r.task ? `#/b/${r.board}` : '#/boards'
    case 'terminal': return `#/h/${enc(r.host)}`
    case 'session': {
      const s = sessions.get(r.name)
      if (s?.archived_at) return '#/archived'
      // (One opened here that hasn't connected yet: what its machine says.)
      const t = s ? null : [...hosts.values()].flatMap(h => h.info?.terminals ?? []).find(x => x.id === r.name)
      const { role, coordinator } = s ?? t ?? {}
      const team = role === 'coordinator' ? r.name : role === 'worker' ? coordinator : null
      return team ? `#/q/${enc(team)}` : '#/teams'
    }
    default: return '#/teams' // a team, a new team, the archived ones
  }
}

// What a place is called, on the button.
export function placeName(hash) {
  const r = parseRoute(hash)
  const team = name => state.squadMeta.get(name)?.title || name
  switch (r.view) {
    case 'inbox': return T.inbox
    case 'teams': case 'org': return T.teams
    case 'mosaic': return r.squad ? T.tqLiveTitle(team(r.squad)) : T.teams
    case 'team': return team(r.squad)
    case 'session': return r.name
    case 'terminal': return r.term
    case 'hosts': return (r.host && hosts.get(r.host)?.name) || T.machines
    case 'archived': return T.archived
    case 'newteam': return T.newTeam
    case 'addmachine': return T.addTitle
    case 'boards': return T.boards
    case 'usage': return T.usage
    case 'board': return state.boards.find(b => b.id === r.board)?.name ?? T.boards
    default: return T.leads
  }
}

// Where back goes from here: some steps back in the history, or (none of
// another place) one level up in place of this one. Null: no back here.
export function backTarget() {
  const r = parseRoute(location.hash)
  const up = parentOf(r)
  if (!up) return null
  const key = placeKey(r)
  for (let j = at - 1; j >= 0; j--) if (keyOf(stack[j]) !== key) return { steps: at - j, hash: stack[j] }
  return { hash: up }
}

// On every change of address (router.js, before it draws the view).
export function trackNavigation() {
  const sq = stepOf()
  if (sq !== null && sq < stack.length) at = sq // back or forward to a step it knows
  else { at += 1; stack = stack.slice(0, at); mark() }
  stack[at] = location.hash
  save()
}

// Another address for the step it is on: no new step.
export function replaceHash(hash) {
  if (location.hash === hash) return
  history.replaceState(history.state, '', hash)
  stack[at] = location.hash
  save()
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function goBack() {
  const t = backTarget()
  if (!t) return
  if (t.steps) history.go(-t.steps)
  else replaceHash(t.hash)
}

// Closing something to where it came from (the inbox entry to its list):
// the step before when it was there, else that place in place of this one.
export function closeTo(hash) {
  if (at > 0 && keyOf(stack[at - 1]) === keyOf(hash)) history.back()
  else replaceHash(hash)
}

// A link to the same place, clicked: the step is replaced, not added. One
// that cancels (data-back) goes back where the user was; its address is
// where it goes when there is none.
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = e.target.closest?.('a[href^="#/"]')
  if (!a || a.target || !a.closest('#app')) return
  const to = a.getAttribute('href')
  if (a.hasAttribute('data-back')) { e.preventDefault(); return backTarget() ? goBack() : replaceHash(to) }
  if (to !== location.hash && keyOf(to) === keyOf(location.hash)) { e.preventDefault(); replaceHash(to) }
})

export function renderBack() {
  const b = $('backBtn')
  const t = backTarget()
  b.hidden = !t
  if (!t) return
  const name = placeName(t.hash)
  const html = `${icon('chevron', 'flip')}<span class="head-back-to">${esc(name)}</span>`
  if (b._html !== html) { b.innerHTML = html; b._html = html }
  b.setAttribute('aria-label', T.backTo(name))
  b.title = T.backTo(name)
  // (The inbox shows its list beside the entry, but on a phone.)
  b.classList.toggle('narrow-only', parseRoute(location.hash).view === 'inbox')
}
$('backBtn').addEventListener('click', goBack)
