import { $, store } from './dom.js'
import { T, COLLATOR } from './i18n.js'
import { state, sessions, unread, can, companyPref } from './state.js'
import { dur, now, esc } from './format.js'
import { sortedSessions, squadOpen } from './content.js'
import { ChatView } from './chat.js'
import { setHtml, renderNav } from './nav.js'
import { personaTag, sessionTerm, renderTop } from './topbar.js'
import { buildMosaic, renderArchived } from './mosaic.js'
import { renderInbox } from './inbox.js'
import { renderTeams } from './teams.js'
import { renderBoards } from './boards.js'
import { renderTeam } from './team.js'
import { renderSessionAside } from './session.js'
import { renderNewTeam } from './newteam.js'
import { renderAddMachine } from './addmachine.js'
import { closeMenu } from './dialogs.js'
import { renderHosts } from './machines.js'
import { hideOrgTip, renderOrg } from './org.js'
import { TermView } from './terminal.js'
import { Timeline } from './timeline.js'
import { icon } from './icons.js'
import { parseRoute, dec } from './routes.js'
import { trackNavigation } from './back.js'

// views
export let mosaicPanes = new Map() // name -> {pane, view}

export { dec }

// Set once the user moves around the dashboard (not on the page it opened on).
export let navigatedInApp = false

// (A real click or key here, not a URL change made from outside.)
// (Inside the app itself: typing the token on the login page doesn't count.)
for (const ev of ['click', 'keydown']) document.addEventListener(ev, e => { if (e.isTrusted && !$('app').hidden && e.target.closest?.('#app')) navigatedInApp = true }, true)

export const currentRoute = () => parseRoute(location.hash)

export function clearMosaic() {
  for (const p of mosaicPanes.values()) p.view.destroy()
  mosaicPanes.clear()
  state.mosaicKey = null
  $('mosaic').innerHTML = ''
}

// A worker's state in a coordinator's team: what it is doing, and for how long.
function workerState(w) {
  const a = w.activity ?? {}
  if (!w.online) return { k: 'offline', dot: '', text: T.wOffline }
  if (a.state === 'waiting') return { k: 'waiting', dot: 'warn pulse', text: T.wWaiting }
  if (a.state === 'compacting') return { k: 'working', dot: 'info pulse', text: T.compacting }
  if (a.state === 'tool' || a.state === 'working') return { k: 'working', dot: 'ok pulse', text: T.wWorking(dur(now() - ((a.state === 'tool' ? a.tool?.since : a.since) ?? now()))), since: a.since }
  return { k: 'idle', dot: 'ok', text: T.wIdle(a.since ? dur(now() - a.since) : '—'), since: a.since ?? now() }
}

// A coordinator's team: who waits for a permission, who is idle (longest
// first: ready for more work), who works, who is gone.
export function teamStrip(c) {
  const ws = sortedSessions().filter(s => s.role !== 'coordinator' && s.coordinator === c.name).map(w => ({ w, st: workerState(w) }))
  const rank = { waiting: 0, idle: 1, working: 2, offline: 3 }
  ws.sort((a, b) => (rank[a.st.k] - rank[b.st.k]) || ((a.st.since ?? 0) - (b.st.since ?? 0)) || COLLATOR.compare(a.w.name, b.w.name))
  const n = k => ws.filter(x => x.st.k === k).length
  const chips = ws.map(({ w, st }) => `<span class="wchip ${st.k}"><button class="wname" data-go="#/s/${encodeURIComponent(w.name)}"><span class="dot ${st.dot}"></span>${esc(w.name)}</button>${personaTag(w.persona)}<span class="wst">${esc(st.text)}</span>${st.k === 'idle' ? `<button class="give" data-givework="${esc(c.name)}" title="${esc(T.giveWorkTitle(w.name, c.name))}">${T.giveWork}</button>` : ''}</span>`).join('')
  return `<div class="team-sum">${ws.length ? esc(T.teamSummary(ws.length, n('working'), n('idle'), n('waiting'))) : T.noWorkers}</div>
      <div class="team-list">${chips}${can('operator') ? `<button class="btn addw" data-addworker="${esc(c.name)}" title="${esc(T.addWorkerTo(c.name))}">${T.addWorker}</button>` : ''}</div>`
}
export function refreshLeads() {
  if (currentRoute().view !== 'leads') return
  for (const [name, p] of mosaicPanes) { const s = sessions.get(name); const el = p.pane.querySelector('.team'); if (s && el) setHtml(el, teamStrip(s)) }
}

// "Give work": straight to the coordinator's terminal, ready to type (nothing typed for you).
export function giveWork(coord) {
  const p = mosaicPanes.get(coord)
  if (p?.kind === 'term' && p.view.x) { p.pane.scrollIntoView?.({ block: 'nearest' }); p.view.x.focus() }
  else location.hash = `#/s/${encodeURIComponent(coord)}`
}

// A session's terminal, as it is, and beside it what it is doing and what
// mattered (folded unless chosen otherwise on a phone, where it would cover it).
function mountSessionTerm(host, name) {
  if (state.termView?.host === host && state.termView.term === name && state.timeline) return
  state.termView?.destroy()
  state.timeline?.destroy()
  const kept = store.get(companyPref('squadraTlFolded'))
  const folded = kept ? kept === '1' : matchMedia('(max-width: 900px)').matches
  $('terminal').innerHTML = `<div class="tv${folded ? ' folded' : ''}"><div class="tv-term"></div><aside class="tv-aside" aria-label="${esc(T.tlAside(name))}"><button type="button" class="icon-btn tv-fold" data-tvfold aria-expanded="${!folded}" aria-label="${esc(folded ? T.tlShow : T.tlHide)}" title="${esc(folded ? T.tlShow : T.tlHide)}">${icon('chevron', folded ? 'flip' : '')}</button><div class="tv-body"></div></aside></div>`
  state.termView = new TermView(host, name, $('terminal').querySelector('.tv-term'))
  state.timeline = new Timeline(name, $('terminal').querySelector('.tv-body'))
}

export function route() {
  const r = currentRoute()
  closeMenu()
  // Going to a worker unfolds its squad in the sidebar, so it shows where you are.
  const c = r.view === 'session' && sessions.get(r.name)?.role === 'worker' ? sessions.get(r.name).coordinator : null
  if (c && squadOpen[c] === false) { squadOpen[c] = true; store.set(companyPref('squadraSquads'), JSON.stringify(squadOpen)) }
  $('archived').hidden = r.view !== 'archived'
  $('inbox').hidden = r.view !== 'inbox'
  $('teams').hidden = r.view !== 'teams'
  $('boards').hidden = r.view !== 'boards' && r.view !== 'board'
  $('team').hidden = r.view !== 'team'
  $('newteam').hidden = r.view !== 'newteam'
  $('addmachine').hidden = r.view !== 'addmachine'
  $('org').hidden = r.view !== 'org'
  hideOrgTip()
  $('hosts').hidden = r.view !== 'hosts'
  const st = sessionTerm(r)
  // (The timeline beside a conversation goes with it.)
  if (state.chatTimeline && !(r.view === 'session' && !st && state.chatTimeline.name === r.name)) { state.chatTimeline.destroy(); state.chatTimeline = null }
  const termMode = r.view === 'terminal' || !!st
  $('terminal').hidden = !termMode
  if (!termMode && state.termView) { state.termView.destroy(); state.termView = null; $('terminal').innerHTML = '' }
  // (A terminal of a session opened there has its panel too; any other, none.)
  const ofSession = r.view === 'terminal' && sessions.get(r.term)?.host_id === r.host
  if ((!termMode || (r.view === 'terminal' && !ofSession)) && state.timeline) { state.timeline.destroy(); state.timeline = null }
  if (r.view === 'hosts' || r.view === 'terminal') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('session').hidden = true
    $('mosaic').hidden = true
    if (r.view === 'hosts') renderHosts(r.host)
    else if (ofSession) mountSessionTerm(r.host, r.term)
    else if (!state.termView || state.termView.host !== r.host || state.termView.term !== r.term || state.termView.root !== $('terminal')) {
      state.termView?.destroy()
      state.termView = new TermView(r.host, r.term, $('terminal'))
    }
  } else if (r.view === 'mosaic' || r.view === 'leads') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    $('session').hidden = true
    $('mosaic').hidden = false
    buildMosaic()
  } else if (r.view === 'archived' || r.view === 'org' || r.view === 'inbox' || r.view === 'teams' || r.view === 'boards' || r.view === 'board' || r.view === 'team' || r.view === 'newteam' || r.view === 'addmachine') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('session').hidden = true
    $('mosaic').hidden = true
    if (r.view === 'org') renderOrg(); else if (r.view === 'inbox') renderInbox(); else if (r.view === 'teams') renderTeams(); else if (r.view === 'boards' || r.view === 'board') renderBoards(); else if (r.view === 'team') renderTeam(); else if (r.view === 'newteam') renderNewTeam(); else if (r.view === 'addmachine') renderAddMachine(); else renderArchived()
  } else if (st) {
    // The session's live terminal, as in Machines: watch it and type to it.
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('mosaic').hidden = true
    $('session').hidden = true
    mountSessionTerm(st.host.id, r.name)
    unread.delete(r.name)
  } else {
    clearMosaic()
    $('mosaic').hidden = true
    $('session').hidden = false
    if (!state.sessionView || state.sessionView.name !== r.name) {
      state.sessionView?.destroy()
      state.sessionView = new ChatView(r.name, { full: true })
      // The conversation, and beside it the team and where it runs.
      $('session').innerHTML = '<div class="sv"><div class="sv-thread"></div><aside class="sv-aside"><div class="sv-info"></div><div class="sv-tl"></div></aside></div>'
      $('session').querySelector('.sv-thread').appendChild(state.sessionView.el)
      $('session').querySelector('.sv-aside').setAttribute('aria-label', r.name)
      state.chatTimeline?.destroy()
      state.chatTimeline = new Timeline(r.name, $('session').querySelector('.sv-tl'), { now: false })
    }
    renderSessionAside()
    unread.delete(r.name)
  }
  renderTop()
  renderNav()
}

// (Only while signed in: a link opened on the login page doesn't load views, or ask the server with no token.)
// (Every step counts for the back button, before the view is drawn.)
window.addEventListener('hashchange', () => { trackNavigation(); if (state.me && !$('app').hidden) route() })
