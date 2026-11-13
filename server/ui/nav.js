import { $, store } from './dom.js'
import { T } from './i18n.js'
import { hosts, state, unread, companyPref, can } from './state.js'
import { esc } from './format.js'
import { sortedSessions, status, squadsOf, squadOpen, agentMark } from './content.js'
import { currentRoute } from './router.js'
import { addMachineDialog } from './machines.js'
import { icon } from './icons.js'

// What a burst of stream changes redraws, once per frame (hundreds of
// sessions changing at once would otherwise redraw the sidebar hundreds of
// times).
const pending = new Set()
export function soon(fn) {
  if (!pending.size) requestAnimationFrame(() => { const fns = [...pending]; pending.clear(); for (const f of fns) f() })
  pending.add(fn)
}

// Rewritten only when what it shows changed: a rewrite every second would
// drop keyboard focus, open menus and clicks in progress.
// When only texts and attributes changed (a duration ticking, a dot's
// colour) they are patched in place, so focus and hover stay put too.
export function setHtml(el, html) {
  if (!el || el._html === html) return
  const t = document.createElement('template')
  t.innerHTML = html
  if (el._html === undefined || !patch(el, t.content)) el.innerHTML = html
  el._html = html
}
function patch(a, b) {
  const x = a.childNodes, y = b.childNodes
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) {
    const m = x[i], n = y[i]
    if (m.nodeType !== n.nodeType || m.nodeName !== n.nodeName) return false
    if (m.nodeType === 3) { if (m.data !== n.data) m.data = n.data; continue }
    if (m.nodeType !== 1) continue
    for (const at of [...m.attributes]) if (!n.hasAttribute(at.name)) m.removeAttribute(at.name)
    for (const at of n.attributes) if (m.getAttribute(at.name) !== at.value) m.setAttribute(at.name, at.value)
    if (!patch(m, n)) return false
  }
  return true
}

// --- the sidebar ---------------------------------------------------------------
// The three places (inbox, teams, machines), then every team with its
// coordinator and workers. What needs you is on the right of each row: a
// permission waiting (warn) or messages not read yet (accent).

const isTeams = r => r.view === 'teams' || r.view === 'team' || r.view === 'newteam' || r.view === 'mosaic' || r.view === 'leads' || r.view === 'org'
const isBoards = r => r.view === 'boards' || r.view === 'board'
const isMachines = r => r.view === 'hosts' || r.view === 'terminal' || r.view === 'addmachine'
const here = on => (on ? ' class="rail-item on" aria-current="page"' : ' class="rail-item"')

// Tasks given to agents whose teams haven't been told yet, on every board.
const boardsPending = () => state.boards.filter(b => !b.archived_at).reduce((n, b) => n + (b.pending ?? 0), 0)

// What a session's row says on its right, and what it reads aloud.
function attention(s) {
  if (status(s).waiting) return { html: '', say: T.waitingOnYou }
  const n = unread.get(s.name) ?? 0
  return n ? { html: `<span class="badge" aria-hidden="true">${n > 99 ? '99+' : n}</span>`, say: T.unreadN(n) } : { html: '', say: '' }
}

function sessionRow(s, r) {
  const st = status(s)
  const role = s.role === 'coordinator' ? 'coord' : s.role === 'solo' ? 'solo' : 'worker'
  const a = attention(s)
  const on = r.view === 'session' && r.name === s.name
  const say = [T.roleName[s.role] ?? T.roleName.worker, s.name, st.text, a.say].filter(Boolean).join(' · ')
  return `<a href="#/s/${encodeURIComponent(s.name)}" class="rail-item rail-sess ${role}${on ? ' on' : ''}${s.online ? '' : ' offline'}"${on ? ' aria-current="page"' : ''} title="${esc(st.title ? `${st.text}\n${st.title}` : st.text)}" aria-label="${esc(say)}">`
    + `<span class="role ${role}" aria-hidden="true"></span>${agentMark(s)}<span class="name">${esc(s.name)}</span>${a.html}<span class="dot ${st.dot || 'off'}" aria-hidden="true"></span></a>`
}

function teamBlock({ coord, workers }, r) {
  // Unfolded unless folded here (remembered per browser and company).
  const open = squadOpen[coord.name] !== false
  const name = state.squadMeta.get(coord.name)?.title || coord.name
  // Folded, its name carries what needs attention inside.
  const inside = [coord, ...workers]
  const waiting = inside.some(s => status(s).waiting)
  const unseen = inside.reduce((t, s) => t + (unread.get(s.name) ?? 0), 0)
  const alert = open ? '' : waiting ? '<span class="badge attn" aria-hidden="true">!</span>' : unseen ? `<span class="badge" aria-hidden="true">${unseen > 99 ? '99+' : unseen}</span>` : ''
  const squadOn = (r.view === 'team' || r.view === 'mosaic') && r.squad === coord.name
  return `<div class="rail-team${open ? ' open' : ''}">
      <div class="rail-team-h"><button type="button" class="rail-fold" data-squad="${esc(coord.name)}" aria-expanded="${open}" aria-label="${esc(T.foldTeam(name, open))}">${icon('chevron')}</button><a href="#/q/${encodeURIComponent(coord.name)}" class="rail-team-name${squadOn ? ' on' : ''}"${squadOn ? ' aria-current="page"' : ''}>${esc(name)}</a>${alert}</div>
      <div class="rail-team-body">${sessionRow(coord, r)}${workers.length ? `<div class="rail-workers">${workers.map(w => sessionRow(w, r)).join('')}</div>` : ''}</div>
    </div>`
}

export function renderNav() {
  const r = currentRoute()
  const list = sortedSessions()
  const inboxN = state.inbox.filter(i => !i.resolved_at).length
  const machineList = [...hosts.values()]
  const machinesOn = machineList.filter(h => h.online).length
  let html = `<div class="rail-group" role="group" aria-label="${esc(T.mainNav)}">
      <a href="#/"${here(r.view === 'inbox')}>${icon('inbox')}<span class="name">${esc(T.inbox)}</span>${inboxN ? `<span class="badge">${inboxN}</span>` : ''}</a>
      <a href="#/teams"${here(isTeams(r) && !r.squad)}>${icon('teams')}<span class="name">${esc(T.teams)}</span></a>
      <a href="#/boards"${here(isBoards(r))}>${icon('board')}<span class="name">${esc(T.boards)}</span>${boardsPending() ? `<span class="rail-count" title="${esc(T.pendingTitle)}">${boardsPending()}</span>` : ''}</a>
      <div class="rail-row"><a href="#/hosts"${here(isMachines(r))}>${icon('machines')}<span class="name">${esc(T.machines)}</span>${machineList.length ? `<span class="rail-count">${esc(T.ofTotal(machinesOn, machineList.length))}</span>` : ''}</a>${can('manager') ? `<button type="button" class="icon-btn" id="addHostBtn" title="${esc(T.addTitle)}" aria-label="${esc(T.addTitle)}">${icon('plus')}</button>` : ''}</div>
    </div>`

  // Names waiting for the user: their ⋯ menu has the button.
  const pendingApproval = list.filter(x => x.approval_pending)
  if (pendingApproval.length) html += `<div class="rail-group"><div class="rail-label"><span>${esc(T.approveNote)}</span></div>${pendingApproval.map(s => sessionRow(s, r)).join('')}</div>`

  const { squads, orphans, solos } = squadsOf(list)
  html += `<div class="rail-group"><div class="rail-label"><span>${esc(T.yourTeams)}</span>${can('operator') ? `<button type="button" class="icon-btn" data-newteam title="${esc(T.newTeam)}" aria-label="${esc(T.newTeam)}">${icon('plus')}</button>` : ''}</div>`
    + (squads.length ? squads.map(q => teamBlock(q, r)).join('') : `<div class="rail-empty">${esc(T.noTeams)}</div>`) + '</div>'
  if (orphans.length) html += `<div class="rail-group"><div class="rail-label"><span>${esc(squads.length ? T.noCoordinator : T.workers)}</span></div>${orphans.map(s => sessionRow(s, r)).join('')}</div>`
  if (solos.length) html += `<div class="rail-group"><div class="rail-label"><span>${esc(T.standalone)}</span></div>${solos.map(s => sessionRow(s, r)).join('')}</div>`

  const archivedCount = sortedSessions({ archived: true }).length
  if (archivedCount || r.view === 'archived') html += `<div class="rail-group"><a href="#/archived"${here(r.view === 'archived')}>${icon('archive')}<span class="name">${esc(T.archived)}</span><span class="rail-count">${archivedCount}</span></a></div>`
  setHtml($('nav'), html)
  // On a phone, the three places, Ctrl+K and the settings at the bottom, within
  // the thumb's reach. (There is no sidebar there: all it has is reached from these.)
  setHtml($('tabbar'), `<a href="#/"${here(r.view === 'inbox')}>${icon('inbox')}<span>${esc(T.inbox)}</span>${inboxN ? `<span class="badge">${inboxN}</span>` : ''}</a>
    <a href="#/teams"${here(isTeams(r) || r.view === 'session')}>${icon('teams')}<span>${esc(T.teams)}</span></a>
    <a href="#/boards"${here(isBoards(r))}>${icon('board')}<span>${esc(T.boards)}</span></a>
    <a href="#/hosts"${here(isMachines(r))}>${icon('machines')}<span>${esc(T.machines)}</span></a>
    <button type="button" class="rail-item" data-palette>${icon('search')}<span>${esc(T.goToShort)}</span></button>
    <button type="button" class="rail-item" data-settings aria-haspopup="dialog">${icon('settings')}<span>${esc(T.settings)}</span></button>`)
}
$('tabbar').addEventListener('click', async e => {
  if (e.target.closest('[data-palette]')) (await import('./palette.js')).openPalette()
  if (e.target.closest('[data-settings]')) (await import('./people.js')).openSettings()
})

$('nav').addEventListener('click', e => {
  const fold = e.target.closest('[data-squad]')
  if (fold) {
    const name = fold.dataset.squad
    squadOpen[name] = !fold.closest('.rail-team').classList.contains('open')
    store.set(companyPref('pishaSquads'), JSON.stringify(squadOpen))
    return renderNav()
  }
  if (e.target.closest('#addHostBtn')) return addMachineDialog()
  if (e.target.closest('[data-newteam]')) location.hash = '#/new'
})
