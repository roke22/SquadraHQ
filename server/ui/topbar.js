import { $, store } from './dom.js'
import { T } from './i18n.js'
import { sessions, state, linksOf, hosts, can } from './state.js'
import { esc, kfmt } from './format.js'
import { sortedSessions, status } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'
import { applyCols, buildMosaic } from './mosaic.js'
import { runAction, openMenu } from './dialogs.js'
import { terminalOf, hostLine, hostAction } from './machines.js'
import { reopenable, reopen, addWorkerTo, saveTemplateDialog, newSessionDialog } from './squads.js'
import { orgSquads, orgZoom, linksDialog } from './org.js'

// The terminal a session view shows (null: its chat).
// (An observer has no terminals: its chat instead.)
export const sessionTerm = r => (r.view === 'session' && !r.chat && state.role !== 'observer' ? terminalOf(r.name) : null)

// The Squadra session behind a machine's terminal: only one that machine
// opened (a machine could list any name; it can't make it its own).
export function sessionOn(hostId, term) {
  const s = sessions.get(term)
  return s && s.host_id === hostId ? s : null
}

export function roleTag(role) {
  return role ? `<span class="role-tag ${role}">${role === 'coordinator' ? T.roleCoordinator : role === 'solo' ? T.roleSolo : T.roleWorker}</span>` : ''
}

// A task's final report (done, blocked, failed, question), or information
// that needs none (fyi), on a message.
export function msgTag(it) {
  if (['done', 'blocked', 'failed', 'question'].includes(it.report)) return ` <span class="rep ${it.report}">${T.reportTag[it.report]}</span>`
  return it.fyi ? ` <span class="rep fyi">${T.fyiTag}</span>` : ''
}

// The persona (skill or agent) a session follows.
export function personaTag(p) {
  return p?.name ? `<span class="persona-tag" title="${esc(`${p.kind === 'agent' ? T.personaAgent : T.personaSkill} ${p.name}${p.description ? ` — ${p.description}` : ''}`)}">🎭 ${esc(p.name)}</span>` : ''
}

// Teams can be seen three ways: every session, the coordinators with their
// teams, or the org chart.
const teamsSeg = view => `<nav class="seg" aria-label="${esc(T.teams)}">${[['teams', '#/teams', T.viewList], ['org', '#/org', T.org], ['mosaic', '#/mosaic', T.viewMosaic]]
  .map(([v, href, label]) => `<a href="${href}"${v === view ? ' class="on" aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>`

export function renderTop() {
  const r = currentRoute()
  // (Only the teams views have a selector; a squad's own view is one team.)
  if (!['org', 'teams'].includes(r.view) && !(r.view === 'mosaic' && !r.squad)) setHtml($('topTabs'), '')
  if (r.view === 'inbox') {
    // (Its subtitle, how many wait on you, is the inbox's own: see renderInbox.)
    setHtml($('topTitle'), esc(T.inbox))
    setHtml($('topRight'), '')
    return
  }
  if (r.view === 'teams') {
    // (Its subtitle, how many teams and sessions, is the list's own: see renderTeams.)
    setHtml($('topTitle'), esc(T.teams)); setHtml($('topTabs'), teamsSeg('teams'))
    setHtml($('topRight'), can('operator') ? `<button class="btn primary" data-newteam>${esc(T.newTeam)}</button>` : '')
    return
  }
  if (r.view === 'team') {
    const name = r.squad
    const meta = state.squadMeta.get(name)
    // (Its subtitle, who is connected, is the page's own: see renderTeam.)
    setHtml($('topTitle'), esc(meta?.title || name))
    setHtml($('topRight'), `<a class="btn" href="#/q/${encodeURIComponent(name)}/live">${esc(T.tqLive)}</a>${can('operator') ? `<button class="btn" data-addworker="${esc(name)}">${esc(T.tqAddWorker)}</button>` : ''}<a class="btn primary" href="#/s/${encodeURIComponent(name)}">${esc(T.tqGiveOrder)}</a>`)
    return
  }
  if (r.view === 'org') {
    const { squads } = orgSquads()
    setHtml($('topTitle'), esc(T.teams)); setHtml($('topTabs'), teamsSeg('org'))
    $('topSub').textContent = T.orgSub(squads.length, squads.reduce((t, q) => t + 1 + q.workers.length, 0), state.links.length)
    setHtml($('topRight'), `<span class="seg"><button data-orgzoom="-" aria-label="${esc(T.orgZoomOut)}">−</button><button data-orgzoom="1" title="${esc(T.orgZoomReset)}">${Math.round(orgZoom * 100)}%</button><button data-orgzoom="+" aria-label="${esc(T.orgZoomIn)}">+</button></span>${can('manager') ? `<button class="btn" data-orgact="arrange" title="${esc(T.orgArrangeTitle)}">${T.orgArrange}</button>` : ''}${can('operator') ? `<button class="btn primary" data-orgact="newsquad">${T.orgNewSquad}</button>` : ''}`)
    return
  }
  if (r.view === 'leads') {
    const cs = sortedSessions().filter(s => s.role === 'coordinator')
    const ws = sortedSessions().filter(s => s.role !== 'coordinator' && cs.some(c => c.name === s.coordinator))
    setHtml($('topTitle'), esc(T.leads))
    $('topSub').textContent = T.leadsSub(cs.length, ws.length)
    setHtml($('topRight'), `<span>${T.columns}</span><span class="seg" id="colsSeg">${['auto', '1', '2', '3', '4'].map(n => `<button data-c="${n}" class="${n === state.cols ? 'on' : ''}">${n === 'auto' ? T.auto : n}</button>`).join('')}</span>`)
    return
  }
  if (r.view === 'mosaic') {
    // (Who has no terminals has nothing to choose.)
    const modeSeg = !can('operator') ? '' : `<span class="seg" id="modeSeg">${['terms', 'chats'].map(m => `<button data-mode="${m}" class="${m === state.mosaicMode ? 'on' : ''}">${m === 'terms' ? T.modeTerms : T.modeChats}</button>`).join('')}</span>`
    const colsSeg = `${modeSeg}<span>${T.columns}</span><span class="seg" id="colsSeg">${['auto', '2', '3', '4', '5', '6'].map(n => `<button data-c="${n}" class="${n === state.cols ? 'on' : ''}">${n === 'auto' ? T.auto : n}</button>`).join('')}</span>`
    if (r.squad) {
      const c = sessions.get(r.squad)
      const ws = sortedSessions().filter(s => s.role !== 'coordinator' && s.coordinator === r.squad)
      setHtml($('topTitle'), `<span class="dot ${c ? status(c).dot : ''}"></span>👥 ${esc(T.squadOf(r.squad))}`)
      const linked = linksOf(r.squad)
      $('topSub').textContent = [T.squadCount(ws.filter(w => w.online).length, ws.length), linked.length ? T.linkedWith(linked.join(', ')) : ''].filter(Boolean).join(' · ')
      setHtml($('topRight'), `${colsSeg}${can('operator') ? `<button class="btn" data-addworker="${esc(r.squad)}" title="${esc(T.addWorkerTo(r.squad))}">${T.addWorker}</button>` : ''}${can('manager') ? `<button class="btn" data-links="${esc(r.squad)}" title="${esc(T.linksTitle(r.squad))}">${T.links(linked.length)}</button><button class="btn" data-savetpl="${esc(r.squad)}" title="${esc(T.saveTemplateTitle(r.squad))}">${T.saveTemplate}</button>` : ''}<a class="btn" href="#/q/${encodeURIComponent(r.squad)}">${esc(T.tqBackToTeam)}</a>`)
      return
    }
    setHtml($('topTitle'), esc(T.teams)); setHtml($('topTabs'), teamsSeg('mosaic'))
    $('topSub').textContent = ''
    setHtml($('topRight'), colsSeg)
  } else if (r.view === 'hosts') {
    const h = r.host && hosts.get(r.host)
    setHtml($('topTitle'), h ? `<span class="dot ${h.online ? 'ok' : ''}"></span>${esc(h.name)}` : T.allMachines)
    $('topSub').textContent = h ? hostLine(h) : T.machinesSub
    setHtml($('topRight'), `${can('manager') ? `<button class="btn" data-hact="add">${T.addMachine}</button>` : ''}${can('operator') ? `<button class="btn" data-hact="templates">${T.templates}</button><button class="btn primary" data-hact="new"${h ? ` data-h="${esc(h.id)}"` : ''}>${T.newSession}</button>` : ''}`)
  } else if (r.view === 'terminal') {
    const h = hosts.get(r.host)
    const t = h?.info?.terminals?.find(x => x.id === r.term)
    const s = sessionOn(r.host, r.term)
    setHtml($('topTitle'), `<span class="dot ${s ? status(s).dot : ''}"></span>⌨ ${esc(r.term)} ${roleTag(s?.role ?? t?.role)} ${personaTag(s?.persona ?? t?.persona)}`)
    $('topSub').textContent = [h ? T.onHost(h.name) : '', t?.folder ?? '', h?.info && !t ? T.notListed : ''].filter(Boolean).join(' · ')
    const acts = []
    if (s) acts.push(`<button class="btn" data-go="#/s/${encodeURIComponent(r.term)}/chat">${T.chat}</button>`)
    acts.push(`<button class="btn" data-tact="redraw">${T.redraw}</button>`)
    if (t && h?.online) acts.push(`<button class="btn danger" data-tact="kill">${T.closeSession}</button>`)
    acts.push(`<button class="btn" data-go="#/h/${encodeURIComponent(r.host)}">${T.back}</button>`)
    setHtml($('topRight'), acts.join(''))
  } else if (r.view === 'archived') {
    setHtml($('topTitle'), T.archivedTitle)
    $('topSub').textContent = T.archivedSub
    setHtml($('topRight'), `<button class="btn" data-go="#/teams">${T.backAll}</button>`)
  } else {
    const s = sessions.get(r.name)
    const st = status(s)
    const role = s?.role === 'coordinator' ? 'coord' : s?.role === 'solo' ? 'solo' : 'worker'
    const team = s?.role === 'coordinator' ? s.name : s?.coordinator
    const teamName = team ? state.squadMeta.get(team)?.title || team : ''
    setHtml($('topTitle'), `<span class="role ${role}" aria-hidden="true"></span><span class="sv-name">${esc(r.name)}</span>${s?.archived_at ? ` <span class="tag">${esc(T.archivedTag)}</span>` : ''}`)
    $('topSub').textContent = [s ? T.roleName[s.role] ?? T.roleName.worker : '', teamName, st.text].filter(Boolean).join(' · ')
    // Its conversation, or its live terminal when it has one.
    const where = terminalOf(r.name)
    const termOn = !!(where && !r.chat && can('operator'))
    if (where && can('operator')) setHtml($('topTabs'), `<nav class="seg" aria-label="${esc(r.name)}"><a href="#/s/${encodeURIComponent(r.name)}/chat"${termOn ? '' : ' class="on" aria-current="page"'}>${esc(T.svChat)}</a><a href="#/s/${encodeURIComponent(r.name)}"${termOn ? ' class="on" aria-current="page"' : ''}>${esc(T.terminal)}</a></nav>`)
    else setHtml($('topTabs'), '')
    const acts = []
    if (reopenable(s) && can('operator')) acts.push(`<button class="btn primary" data-reopen="${esc(r.name)}">${T.reopen}</button>`)
    if (s?.approval_pending && can('manager')) acts.push(`<button class="btn primary" data-act="approve" data-s="${esc(s.name)}">${T.approve}</button>`)
    if (termOn) acts.push(`<button class="btn quiet" data-tact="redraw">${esc(T.redraw)}</button><button class="btn quiet danger" data-tact="kill">${esc(T.closeSession)}</button>`)
    if (s && !termOn && !s.online && can('operator')) acts.push(s.archived_at
      ? `<button class="btn" data-act="unarchive" data-s="${esc(s.name)}">${T.unarchive}</button>`
      : `<button class="btn" data-act="archive" data-s="${esc(s.name)}">${T.archive}</button>`)
    if (s) acts.push(`<button class="btn quiet" data-menu="${esc(s.name)}" aria-haspopup="menu" aria-label="${esc(T.svMore(s.name))}">${esc(T.svMoreShort)}</button>`)
    setHtml($('topRight'), acts.join(''))
  }
}

$('topRight').addEventListener('click', e => {
  const c = e.target.closest('[data-c]')
  if (c) { state.cols = c.dataset.c; store.set('squadraCols', state.cols); applyCols(); renderTop() }
  const ro = e.target.closest('[data-reopen]')
  if (ro) return reopen(ro.dataset.reopen)
  const md = e.target.closest('[data-mode]')
  if (md) { state.mosaicMode = md.dataset.mode === 'chats' ? 'chats' : 'terms'; store.set('squadraMosaicMode', state.mosaicMode); buildMosaic(); renderTop() }
  const go = e.target.closest('[data-go]')
  if (go) location.hash = go.dataset.go
  const act = e.target.closest('[data-act]')
  if (act) runAction(act.dataset.act, act.dataset.s)
  const hact = e.target.closest('[data-hact]')
  if (hact) hostAction(hact.dataset.hact, hact.dataset.h)
  if (e.target.closest('[data-newteam]')) return newSessionDialog(undefined, { role: 'coordinator' })
  const aw = e.target.closest('[data-addworker]')
  if (aw) addWorkerTo(aw.dataset.addworker)
  const stp = e.target.closest('[data-savetpl]')
  if (stp) saveTemplateDialog(stp.dataset.savetpl)
  const lk = e.target.closest('[data-links]')
  if (lk) linksDialog(lk.dataset.links)
  const menu = e.target.closest('[data-menu]')
  if (menu) return openMenu(menu, menu.dataset.menu)
  const tact = e.target.closest('[data-tact]')
  if (tact) {
    const r = currentRoute()
    const st = sessionTerm(r)
    if (tact.dataset.tact === 'redraw') state.termView?.refresh()
    if (tact.dataset.tact === 'kill') hostAction('kill', r.host ?? st?.host.id, r.term ?? r.name)
  }
})
