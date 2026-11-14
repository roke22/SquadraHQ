import { store, $ } from './dom.js'
import { T } from './i18n.js'
import { state, sessions, hosts, linksOf, linkListeners, companyPref, can } from './state.js'
import { now, esc } from './format.js'
import { sortedSessions, byPresence, status, agentMark } from './content.js'
import { setHtml, soon } from './nav.js'
import { currentRoute } from './router.js'
import { roleTag, renderTop, personaTag } from './topbar.js'
import { alertBox } from './mosaic.js'
import { closeMenu, confirmDialog, post, runAction, dialog } from './dialogs.js'
import { terminalOf, postJson, hostAction } from './machines.js'
import {
  personaName, newSessionDialog, addWorkerTo, saveTemplateDialog, reopenable, reopen, personaOptions,
} from './squads.js'
import { icon } from './icons.js'

// org chart: each squad as a card (its coordinator and workers), the links
// between squads as lines, and what each one is for on hover. From here
// squads and agents are added, described, moved, linked, closed and
// deleted, through the same actions as everywhere else in the dashboard.

const ORG_GAP_X = 72, ORG_GAP_Y = 48, ORG_PAD = 32, ORG_FOLD = 6
// A team: a tray around its coordinator's card, and its workers' cards in
// rows below it (three a row), the first row joined to it by lines.
const CARD_W = 232, LEAD_W = 300, CARD_GAP = 14, PER_ROW = 3, CREW_PAD = 14, TRAY = 6, HEAD_H = 56
// (Each team's size as last drawn: where the next one goes, and the lines between teams.)
const orgSize = new Map()
export let orgZoom = (() => { const z = Number(store.get(companyPref('pishaOrgZoom'))); return z >= 0.4 && z <= 1.6 ? z : 1 })()
let orgDrag = null                       // a card or a new link being dragged
let orgPos = new Map()                   // coordinator -> {x, y, h}, as drawn
const orgOpen = new Set()                // squads showing all their workers
const orgSaved = new Set()               // squads placed automatically, already saved
let orgTipKey = null

const squadTitle = name => state.squadMeta.get(name)?.title || name

// What a session is for: what was written for it here, else what its persona says.
const purposeOf = s => s?.description || s?.persona?.description || ''
const personaOf = s => s?.persona?.name || personaName(s?.opened_persona) || ''
const recentOf = l => (l.recent ?? []).filter(t => now() - t < 3600_000).length
const orgNarrow = () => matchMedia('(max-width: 900px)').matches

// Squads as in the sidebar, plus the sessions opened here that haven't
// joined yet (Claude Code still starting, or waiting for its login): by the
// role and coordinator they were opened with.
const orgRole = s => s.role ?? s.opened_role ?? null
const orgCoordOf = s => s.coordinator ?? terminalOf(s.name)?.term.coordinator ?? null
export function orgSquads() {
  const list = sortedSessions()
  const coords = list.filter(s => orgRole(s) === 'coordinator')
  const names = new Set(coords.map(c => c.name))
  return {
    squads: coords.map(c => ({ coord: c, workers: list.filter(s => orgRole(s) === 'worker' && orgCoordOf(s) === c.name).sort(byPresence) })),
    orphans: list.filter(s => orgRole(s) !== 'coordinator' && orgRole(s) !== 'solo' && !(orgRole(s) === 'worker' && names.has(orgCoordOf(s)))),
    solos: list.filter(s => orgRole(s) === 'solo'),
  }
}

const shownOf = q => (orgOpen.has(q.coord.name) ? q.workers : q.workers.slice(0, ORG_FOLD))
// How wide its people are, inside the tray; the team's width and (until drawn) height.
const rowWidth = n => (n ? n * CARD_W + (n - 1) * CARD_GAP : 0)
const crewWidth = q => Math.max(LEAD_W, rowWidth(Math.min(PER_ROW, shownOf(q).length)))
function orgCardSize(q) {
  const seen = orgSize.get(q.coord.name)
  const n = shownOf(q).length
  return seen ?? { w: crewWidth(q) + 2 * (CREW_PAD + TRAY), h: HEAD_H + 2 * CREW_PAD + 150 + (n ? 34 + Math.ceil(n / PER_ROW) * (160 + CARD_GAP) : 0) + 60 }
}

// Where each card goes: where it was put, or, for a new squad, the lowest
// free spot in a column (all of them with "arrange").
function orgLayout(squads, { arrange = false } = {}) {
  const pos = new Map()
  const loose = []
  for (const q of squads) {
    const m = state.squadMeta.get(q.coord.name)
    if (!arrange && Number.isFinite(m?.x) && Number.isFinite(m?.y)) pos.set(q.coord.name, { x: m.x, y: m.y, ...orgCardSize(q) })
    else loose.push(q)
  }
  if (loose.length) {
    // (Side by side from the left, a row at a time, below the ones already placed.)
    const width = ($('org').clientWidth || 1200) / orgZoom
    let y = ORG_PAD
    for (const p of pos.values()) y = Math.max(y, p.y + p.h + ORG_GAP_Y)
    let x = ORG_PAD, shelf = 0
    for (const q of loose) {
      const size = orgCardSize(q)
      if (x > ORG_PAD && x + size.w > width - ORG_PAD) { x = ORG_PAD; y += shelf + ORG_GAP_Y; shelf = 0 }
      pos.set(q.coord.name, { x, y, ...size, auto: true })
      x += size.w + ORG_GAP_X
      shelf = Math.max(shelf, size.h)
    }
  }
  return pos
}

// A link's line, between the two cards' sides (or top and bottom, when one
// is above the other), and the middle point for its label.
function orgLinkPath(p, q) {
  const pc = p.x + p.w / 2, qc = q.x + q.w / 2
  if (Math.abs(pc - qc) >= (p.w + q.w) / 2 + 20) {
    const right = qc > pc
    const x1 = right ? p.x + p.w : p.x, x2 = right ? q.x : q.x + q.w
    const y1 = p.y + HEAD_H / 2, y2 = q.y + HEAD_H / 2
    const d = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1)
    return { d: `M${x1} ${y1} C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
  }
  const down = q.y > p.y
  const y1 = down ? p.y + p.h : p.y, y2 = down ? q.y : q.y + q.h
  const d = Math.max(30, Math.abs(y2 - y1) / 2) * (down ? 1 : -1)
  return { d: `M${pc} ${y1} C${pc} ${y1 + d} ${qc} ${y2 - d} ${qc} ${y2}`, mx: (pc + qc) / 2, my: (y1 + y2) / 2 }
}
function orgLinesHtml() {
  let paths = '', labels = ''
  for (const l of state.links) {
    const p = orgPos.get(l.a), q = orgPos.get(l.b)
    if (!p || !q) continue
    const { d, mx, my } = orgLinkPath(p, q)
    const n = recentOf(l)
    // (Amber from three quarters of what two coordinators may send each other in an hour.)
    const cls = n >= 60 ? 'full' : n >= 45 ? 'warn' : ''
    paths += `<path class="l ${cls}" d="${d}"/><path class="hit" d="${d}" data-la="${esc(l.a)}" data-lb="${esc(l.b)}"/>`
    labels += `<button class="org-label ${cls}" style="left:${Math.round(mx)}px;top:${Math.round(my)}px" data-la="${esc(l.a)}" data-lb="${esc(l.b)}" title="${esc(T.orgLinkRecent(n))}">${n}</button>`
  }
  return { paths, labels }
}

// What an agent is on: its task in its coordinator's plan (since when), else
// the last thing its coordinator handed it, else, for a coordinator, its plan.
const handed = new Map() // worker -> { from, text, at }: the last message its coordinator sent it
const flashes = new Map() // worker -> when something was just handed to it (a light runs to it)
export function noteHandoff(m) {
  if (m.system || !m.from || !m.target || !m.text) return
  const w = sessions.get(m.target)
  if (!w || orgCoordOf(w) !== m.from) return
  handed.set(m.target, { from: m.from, text: m.text, at: m.created_at ?? now() })
  flashes.set(m.target, now())
  if (currentRoute().view !== 'org') return
  soon(renderOrg)
  setTimeout(() => { flashes.delete(m.target); if (currentRoute().view === 'org') soon(renderOrg) }, 2200)
}
function taskOf(s, kind) {
  const coord = kind === 'coord' ? s.name : orgCoordOf(s)
  const plan = coord ? state.plans.get(coord) : null
  const t = plan?.tasks.find(x => x.who === s.name && x.state === 'doing')
  if (t) return { title: t.title, ref: t.ref, since: t.since }
  const h = handed.get(s.name)
  if (h) return { title: h.text.replace(/\s+/g, ' '), from: h.from, since: h.at }
  if (kind === 'coord' && plan?.title) return { title: plan.title }
  return null
}
// Its state, as a pill: at work, waiting on you, idle, away.
function stateOf(s) {
  const a = s.activity ?? {}
  if (!s.online) return { cls: 'off', label: T.orgSt.off }
  if (status(s).waiting) return { cls: 'need', label: T.orgSt.need }
  if (['tool', 'working', 'compacting'].includes(a.state)) return { cls: 'work', label: T.orgSt.work }
  return { cls: '', label: T.orgSt.idle }
}
// "claude-opus-5-5" as "Claude Opus 5.5"; other models as they come.
const modelName = m => (/^claude-/.test(m ?? '') ? m.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `Claude ${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`) : m ?? '')
const kTokens = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const clockHtml = since => (since ? `<time class="oa-clock" data-since="${Number(since)}"></time>` : '')

function orgAgent(s, kind) {
  const a = s.activity ?? {}
  const st = stateOf(s)
  const pct = a.context_pct
  const window = a.context_window ?? (Number.isFinite(pct) && pct > 0 && a.context_tokens ? Math.round(a.context_tokens * 100 / pct) : null)
  const task = taskOf(s, kind)
  const model = [modelName(a.model), personaOf(s)].filter(Boolean).join(' · ')
  const flash = flashes.has(s.name) && now() - flashes.get(s.name) < 2200
  return `<div class="org-agent ${kind}${flash ? ' got' : ''}" data-orgtip="agent:${esc(s.name)}" data-orgopen="${esc(s.name)}" tabindex="0">
      <div class="oa-h"><span class="oa-av">${agentMark(s)}<span class="oa-rl"><span class="role ${kind === 'coord' ? 'coord' : 'worker'}" aria-hidden="true"></span></span></span>
        <span class="oa-who"><span class="oa-nm"><b>${esc(s.name)}</b><span class="oa-st ${st.cls}">${st.cls === 'work' ? '<span class="oa-spin" aria-hidden="true"></span>' : st.cls ? '<span class="oa-pd" aria-hidden="true"></span>' : ''}${esc(st.label)}</span></span>
          ${model ? `<span class="oa-model">${esc(model)}</span>` : ''}${kind === 'coord' ? `<span class="oa-lead">${esc(T.roleName.coordinator)}</span>` : ''}</span>
        <button class="org-more" data-orgmenu="agent" data-name="${esc(s.name)}" aria-label="${esc(T.orgAgentMenu(s.name))}" aria-haspopup="menu">${icon('more')}</button></div>
      <div class="oa-task${task ? '' : ' none'}" title="${esc(task?.title ?? '')}">${task?.from ? `<span class="oa-from">↳ ${esc(task.from)}</span>` : ''}${task?.ref ? `<span class="oa-ref">${esc(task.ref)}</span>` : ''}<span class="oa-tt">${esc(task?.title ?? T.orgNoTask)}</span>${clockHtml(task?.since)}</div>
      <div class="oa-now">${esc(status(s).text)}</div>
      ${Number.isFinite(pct) ? `<div class="oa-ctx" title="${esc(T.contextPct(Math.round(pct)))}"><span class="oa-bar"><i class="${pct >= 95 ? 'hot' : pct >= 80 ? 'warm' : ''}" style="width:${Math.max(2, Math.min(100, pct))}%"></i></span>${a.context_tokens && window ? `${kTokens(a.context_tokens)} / ${kTokens(window)}` : `${Math.round(pct)}%`}</div>` : ''}
    </div>`
}
// The lines from a coordinator down to its first row of workers (one lit while something is handed to it).
function orgWires(q) {
  const first = shownOf(q).slice(0, PER_ROW)
  if (!first.length) return ''
  const inner = crewWidth(q), mid = inner / 2, start = (inner - rowWidth(first.length)) / 2
  const paths = first.map((w, i) => {
    const x = start + i * (CARD_W + CARD_GAP) + CARD_W / 2
    const d = Math.abs(x - mid) < 1 ? `M${mid} 0 V34` : `M${mid} 0 V14 Q${mid} 18 ${mid + Math.sign(x - mid) * 4} 18 H${x - Math.sign(x - mid) * 4} Q${x} 18 ${x} 22 V34`
    return `<path d="${d}"/>${flashes.has(w.name) ? `<path class="run" d="${d}"/>` : ''}`
  }).join('')
  return `<svg class="oa-wires" width="${inner}" height="34" viewBox="0 0 ${inner} 34" aria-hidden="true">${paths}<circle cx="${mid}" cy="1.5" r="3"/></svg>`
}
function orgCard(q, p) {
  const c = q.coord, m = state.squadMeta.get(c.name) ?? {}
  const shown = shownOf(q)
  const all = [c, ...q.workers]
  const working = all.filter(x => stateOf(x).cls === 'work').length, waiting = all.filter(x => stateOf(x).cls === 'need').length
  const on = q.workers.filter(w => w.online).length
  return `<div class="org-card" data-squad="${esc(c.name)}" style="left:${p.x}px;top:${p.y}px">
      <div class="org-head" data-orgtip="squad:${esc(c.name)}" tabindex="0"><span class="org-tic">${icon('teams')}</span>
        <span class="org-tt"><span class="org-title">${esc(m.title || c.name)}</span>${m.goal ? `<span class="org-goal">${esc(m.goal)}</span>` : ''}</span>
        <span class="org-counts" title="${esc(T.squadCount(on, q.workers.length))}">${working ? `<span class="work">${esc(T.orgWorkingN(working))}</span>` : ''}${waiting ? `<span class="need">${esc(T.orgWaitingN(waiting))}</span>` : ''}<span>${esc(T.orgAgentsN(all.length))}</span></span>
        <button class="org-more" data-orgmenu="squad" data-name="${esc(c.name)}" aria-label="${esc(T.orgSquadMenu(c.name))}" aria-haspopup="menu">${icon('more')}</button></div>
      <div class="org-crew" style="--crew:${crewWidth(q)}px">
        ${orgAgent(c, 'coord')}
        ${orgWires(q)}
        ${shown.length ? `<div class="org-row">${shown.map(w => orgAgent(w, 'worker')).join('')}</div>` : ''}
        ${q.workers.length > ORG_FOLD ? `<button class="org-fold" data-orgfold="${esc(c.name)}">${orgOpen.has(c.name) ? T.orgLess : T.orgMore(q.workers.length - shown.length)}</button>` : ''}
        ${can('operator') ? `<button class="org-add" data-orgact="addagent" data-name="${esc(c.name)}">${icon('plus')} ${T.orgAddAgent}</button>` : ''}
      </div>
      ${can('manager') ? `<span class="org-handle" data-orghandle="${esc(c.name)}" title="${esc(T.orgLinkHandle)}"></span>` : ''}</div>`
}

// After a draw: each team's real size (for the next layout and the lines between them), and the clocks.
function measureOrg() {
  let changed = false
  for (const el of $('org').querySelectorAll('.org-card[data-squad]')) {
    const name = el.dataset.squad, size = { w: el.offsetWidth, h: el.offsetHeight }
    const was = orgSize.get(name)
    if (!was || was.w !== size.w || was.h !== size.h) { orgSize.set(name, size); changed = true }
    const p = orgPos.get(name)
    if (p) Object.assign(p, size)
  }
  if (changed && $('org').querySelector('.org-lines')) drawOrgLines()
  tickOrg()
  return changed
}
const orgClock = ms => { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60; return t >= 86400 ? `${Math.floor(t / 86400)} d` : h ? `${h}:${String(m).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${m}:${String(t % 60).padStart(2, '0')}` }
function tickOrg() { for (const el of $('org').querySelectorAll('[data-since]')) el.textContent = orgClock(now() - Number(el.dataset.since)) }
setInterval(() => { if (!$('org').hidden && currentRoute().view === 'org') tickOrg() }, 1000)

export function renderOrg(settling = false) {
  if (orgDrag) return // (drawn again when the drag ends)
  const { squads, orphans, solos } = orgSquads()
  orgPos = orgLayout(squads)
  const fresh = squads.filter(q => orgPos.get(q.coord.name).auto && !orgSaved.has(q.coord.name))
  let w = 0, h = 0
  for (const p of orgPos.values()) { w = Math.max(w, p.x + p.w); h = Math.max(h, p.y + p.h) }
  w += ORG_PAD + 240; h += ORG_PAD + 160 // (room to drag a card further)
  const { paths, labels } = orgLinesHtml()
  const extra = [[T.noCoordinator, orphans], [T.standalone, solos]].filter(([, l]) => l.length)
    .map(([label, l]) => `<div class="org-extra"><div class="org-extra-h">${esc(label)}</div>${l.map(s => orgAgent(s, 'loose')).join('')}</div>`).join('')
  setHtml($('org'), `${squads.length ? '' : `<div class="org-empty"><p>${T.orgEmpty}</p>${can('operator') ? `<button class="btn primary" data-orgact="newsquad">${T.orgNewSquad}</button>` : ''}</div>`}
      <div class="org-wrap" style="width:${Math.round(w * orgZoom)}px;height:${squads.length ? Math.round(h * orgZoom) : 0}px">
        <div class="org-stage" style="width:${w}px;height:${h}px;transform:scale(${orgZoom})">
          <svg class="org-lines" width="${w}" height="${h}">${paths}</svg>
          ${squads.map(q => orgCard(q, orgPos.get(q.coord.name))).join('')}
          <div class="org-labels">${labels}</div>
        </div>
      </div>${extra ? `<div class="org-extras">${extra}</div>` : ''}`)
  const resized = measureOrg()
  // New squads: placed again once their real size is known, then they stay where they were put.
  if (fresh.length && resized && settling !== true) return renderOrg(true)
  if (fresh.length) {
    for (const q of fresh) orgSaved.add(q.coord.name)
    if (can('manager')) postJson('/api/org/positions', { positions: fresh.map(q => ({ coordinator: q.coord.name, x: orgPos.get(q.coord.name).x, y: orgPos.get(q.coord.name).y })) }).catch(() => {})
  }
  if (orgTipKey) {
    const el = $('org').querySelector(`[data-orgtip="${CSS.escape(orgTipKey)}"]`)
    if (el) showOrgTip(el); else hideOrgTip()
  }
}

// During a drag: only the moved card and the lines.
function drawOrgLines() {
  const { paths, labels } = orgLinesHtml()
  const svg = $('org').querySelector('.org-lines')
  const tmp = svg.querySelector('.tmp')?.outerHTML ?? ''
  svg.innerHTML = paths + tmp
  $('org').querySelector('.org-labels').innerHTML = labels
}
const stagePoint = e => {
  const r = $('org').querySelector('.org-stage').getBoundingClientRect()
  return { x: (e.clientX - r.left) / orgZoom, y: (e.clientY - r.top) / orgZoom }
}
function endOrgDrag() {
  if (!orgDrag) return
  $('org').querySelectorAll('.drop').forEach(x => x.classList.remove('drop'))
  $('org').querySelector('.org-lines .tmp')?.remove()
  orgDrag = null
  $('org')._html = undefined // (the DOM was changed by hand: drawn again in full)
  renderOrg()
}

// Hover (or keyboard focus): what a squad or an agent is for.
function orgTipHtml(key) {
  const i = key.indexOf(':')
  const kind = key.slice(0, i), name = key.slice(i + 1)
  if (kind === 'agent') {
    const s = sessions.get(name)
    if (!s) return ''
    const where = terminalOf(name)
    const host = where?.host ?? hosts.get(s.host_id)
    const folder = where?.term.folder ?? s.activity?.cwd
    const purpose = purposeOf(s)
    const pct = s.activity?.context_pct
    return `<div class="org-tip-t">${esc(name)} ${roleTag(orgRole(s))}</div>
        <p>${purpose ? esc(purpose) : `<i>${T.orgNoPurpose}</i>`}</p>
        ${personaOf(s) ? `<div>${esc(personaOf(s))}${s.description && s.persona?.description ? ` — <span class="m">${esc(s.persona.description)}</span>` : ''}</div>` : ''}
        <div class="m"><span class="dot ${status(s).dot}"></span> ${esc(status(s).text)}</div>
        ${host || folder ? `<div class="m">${[host ? T.onHost(host.name) : '', folder].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${Number.isFinite(pct) ? `<div class="m">${esc(T.contextPct(Math.round(pct)))}</div>` : ''}`
  }
  const c = sessions.get(name)
  if (!c) return ''
  const m = state.squadMeta.get(name) ?? {}
  const workers = orgSquads().squads.find(q => q.coord.name === name)?.workers ?? []
  const linked = linksOf(name)
  return `<div class="org-tip-t">${esc(m.title || name)}${m.title ? ` <span class="m">· ${esc(name)}</span>` : ''}</div>
      <p>${m.goal ? esc(m.goal) : `<i>${T.orgNoGoal}</i>`}</p>
      ${personaOf(c) ? `<div>${esc(personaOf(c))}</div>` : ''}
      <div class="m">${esc(T.squadCount(workers.filter(w => w.online).length, workers.length))}</div>
      ${c.online && !workers.some(w => w.online) ? `<div class="m">${esc(T.orgSelfWorking)}</div>` : ''}
      ${linked.length ? `<div class="m">${linked.map(n => esc(squadTitle(n))).join(', ')}</div>` : ''}`
}
const orgTip = document.createElement('div')
orgTip.className = 'org-tip'
orgTip.hidden = true
orgTip.setAttribute('role', 'tooltip')
document.body.appendChild(orgTip)
function showOrgTip(el) {
  const html = orgTipHtml(el.dataset.orgtip)
  if (!html) return hideOrgTip()
  orgTipKey = el.dataset.orgtip
  setHtml(orgTip, html)
  orgTip.hidden = false
  const r = el.getBoundingClientRect()
  const w = orgTip.offsetWidth, h = orgTip.offsetHeight
  const left = r.right + 10 + w <= innerWidth ? r.right + 10 : Math.max(8, r.left - 10 - w)
  orgTip.style.left = `${left}px`
  orgTip.style.top = `${Math.max(8, Math.min(r.top, innerHeight - h - 8))}px`
}
export function hideOrgTip() { orgTip.hidden = true; orgTipKey = null }
$('org').addEventListener('pointerover', e => { const el = e.target.closest('[data-orgtip]'); if (el && !orgDrag && !state.menuEl && el.dataset.orgtip !== orgTipKey) showOrgTip(el) })
$('org').addEventListener('pointerout', e => { const el = e.target.closest('[data-orgtip]'); if (el && !el.contains(e.relatedTarget)) hideOrgTip() })
$('org').addEventListener('focusin', e => { const el = e.target.closest('[data-orgtip]'); if (el) showOrgTip(el) })
$('org').addEventListener('focusout', hideOrgTip)
$('org').addEventListener('scroll', hideOrgTip)

// Dragging a card by its header moves it; dragging its handle onto another
// card links the two squads.
$('org').addEventListener('pointerdown', e => {
  if (e.button !== 0 || orgNarrow()) return
  const handle = e.target.closest('[data-orghandle]')
  const head = !handle && !e.target.closest('button') && e.target.closest('.org-head')
  if (!handle && !head) return
  e.preventDefault()
  hideOrgTip()
  if (handle) {
    const from = handle.dataset.orghandle
    orgDrag = { kind: 'link', from }
    $('org').querySelector('.org-lines').insertAdjacentHTML('beforeend', '<path class="l tmp" d=""/>')
  } else {
    const card = head.closest('.org-card')
    if (!can('manager')) return
    orgDrag = { kind: 'card', name: card.dataset.squad, card, px: e.clientX, py: e.clientY, x: parseFloat(card.style.left), y: parseFloat(card.style.top), moved: false }
  }
})
addEventListener('pointermove', e => {
  if (!orgDrag) return
  if (orgDrag.kind === 'card') {
    const dx = (e.clientX - orgDrag.px) / orgZoom, dy = (e.clientY - orgDrag.py) / orgZoom
    if (!orgDrag.moved && Math.hypot(dx, dy) < 4) return
    orgDrag.moved = true
    const x = Math.max(0, Math.round(orgDrag.x + dx)), y = Math.max(0, Math.round(orgDrag.y + dy))
    orgDrag.card.style.left = `${x}px`
    orgDrag.card.style.top = `${y}px`
    Object.assign(orgPos.get(orgDrag.name), { x, y })
    drawOrgLines()
    return
  }
  const p = orgPos.get(orgDrag.from)
  if (!p) return
  const to = stagePoint(e)
  const x1 = p.x + p.w, y1 = p.y + HEAD_H / 2
  $('org').querySelector('.org-lines .tmp')?.setAttribute('d', `M${x1} ${y1} C${x1 + 60} ${y1} ${to.x - 60} ${to.y} ${to.x} ${to.y}`)
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.org-card')
  $('org').querySelectorAll('.org-card.drop').forEach(x => { if (x !== over) x.classList.remove('drop') })
  if (over && over.dataset.squad !== orgDrag.from) over.classList.add('drop')
})
addEventListener('pointerup', async e => {
  const d = orgDrag
  if (!d) return
  if (d.kind === 'card') {
    if (d.moved) {
      const p = orgPos.get(d.name)
      state.squadMeta.set(d.name, { ...(state.squadMeta.get(d.name) ?? { coordinator: d.name }), x: p.x, y: p.y })
      postJson('/api/org/positions', { positions: [{ coordinator: d.name, x: p.x, y: p.y }] }).catch(err => alertBox(err.message))
    }
    endOrgDrag()
    // (Its header pressed without moving it: the team, as its name in the list.)
    if (!d.moved) openSquad(d.name)
    return
  }
  const to = document.elementFromPoint(e.clientX, e.clientY)?.closest('.org-card')?.dataset.squad
  endOrgDrag()
  if (!to || to === d.from) return
  try {
    const r = await postJson('/api/links/add', { a: d.from, b: to })
    if (r?.warnings?.length) alertBox(r.warnings.join(' · '))
  } catch (err) { alertBox(err.message) }
})
addEventListener('keydown', e => { if (e.key === 'Escape' && orgDrag) endOrgDrag() })
addEventListener('resize', () => { if (currentRoute().view === 'org') soon(renderOrg) })

$('org').addEventListener('click', e => {
  const menu = e.target.closest('[data-orgmenu]')
  if (menu) return menu.dataset.orgmenu === 'squad' ? squadMenu(menu, menu.dataset.name) : agentMenu(menu, menu.dataset.name)
  const fold = e.target.closest('[data-orgfold]')
  if (fold) { const n = fold.dataset.orgfold; if (orgOpen.has(n)) orgOpen.delete(n); else orgOpen.add(n); return renderOrg() }
  const link = e.target.closest('[data-la]')
  if (link) return linkMenu(link, link.dataset.la, link.dataset.lb)
  // (A header pressed where it can't be dragged: on a phone, or without the right to move it.)
  const head = e.target.closest('.org-head')
  if (head && !e.target.closest('button') && (orgNarrow() || !can('manager'))) openSquad(head.closest('.org-card').dataset.squad)
})
$('org').addEventListener('keydown', e => {
  const head = e.target.closest?.('.org-head')
  if (head && e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSquad(head.closest('.org-card').dataset.squad) }
  const agent = e.target.closest?.('[data-orgopen]')
  if (agent && e.target === agent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openAgent(agent.dataset.orgopen) }
})
// A team's page: what its header leads to, here as in the list.
const openSquad = name => { location.hash = `#/q/${encodeURIComponent(name)}` }
// An agent pressed: its terminal, where it runs (else its session).
function openAgent(name) {
  const where = terminalOf(name)
  location.hash = where?.host?.online && can('operator') ? `#/t/${encodeURIComponent(where.host.id)}/${encodeURIComponent(name)}` : `#/s/${encodeURIComponent(name)}`
}
$('org').addEventListener('click', e => {
  const a = e.target.closest('[data-orgopen]')
  if (a && !e.target.closest('button')) openAgent(a.dataset.orgopen)
})

// (The top bar's buttons too.)
document.addEventListener('click', e => {
  const act = e.target.closest('[data-orgact]')
  if (act) {
    if (act.dataset.orgact === 'newsquad') location.hash = '#/new'
    if (act.dataset.orgact === 'addagent') addWorkerTo(act.dataset.name)
    if (act.dataset.orgact === 'arrange') arrangeOrg()
  }
  const z = e.target.closest('[data-orgzoom]')
  if (z) {
    const v = z.dataset.orgzoom
    orgZoom = v === '1' ? 1 : Math.min(1.6, Math.max(0.4, Math.round((orgZoom + (v === '+' ? 0.1 : -0.1)) * 10) / 10))
    store.set(companyPref('pishaOrgZoom'), String(orgZoom))
    renderOrg()
    renderTop()
  }
})

function arrangeOrg() {
  const { squads } = orgSquads()
  if (!squads.length) return
  const pos = orgLayout(squads, { arrange: true })
  for (const [name, p] of pos) state.squadMeta.set(name, { ...(state.squadMeta.get(name) ?? { coordinator: name }), x: p.x, y: p.y })
  renderOrg()
  postJson('/api/org/positions', { positions: [...pos].map(([coordinator, p]) => ({ coordinator, x: p.x, y: p.y })) }).catch(err => alertBox(err.message))
}

// A small menu next to what was clicked: [{label, run, danger, disabled}].
function orgMenuAt(anchor, items, head = '') {
  closeMenu()
  hideOrgTip()
  state.menuEl = document.createElement('div')
  state.menuEl.className = 'menu'
  state.menuEl.innerHTML = (head ? `<div class="hint">${head}</div>` : '') +
    items.filter(Boolean).map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('')
  document.body.appendChild(state.menuEl)
  const r = anchor.getBoundingClientRect()
  const w = state.menuEl.offsetWidth
  state.menuEl.style.top = `${Math.min(r.bottom + 4, innerHeight - state.menuEl.offsetHeight - 8)}px`
  state.menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  const list = items.filter(Boolean)
  state.menuEl.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b || b.disabled) return
    closeMenu()
    list[Number(b.dataset.i)].run()
  })
}

function squadMenu(anchor, name) {
  const workers = orgSquads().squads.find(q => q.coord.name === name)?.workers ?? []
  const members = [...workers.map(w => w.name), name]
  const running = members.filter(n => terminalOf(n))
  const anyOn = members.some(n => sessions.get(n)?.online)
  orgMenuAt(anchor, [
    can('manager') ? { label: T.orgEditSquad, run: () => squadDialog(name) } : null,
    can('operator') ? { label: T.addWorkerTo(name), run: () => addWorkerTo(name) } : null,
    can('manager') ? { label: T.links(linksOf(name).length), run: () => linksDialog(name) } : null,
    { label: T.viewSquad, run: () => { location.hash = `#/q/${encodeURIComponent(name)}` } },
    can('manager') ? { label: T.saveTemplateTitle(name), run: () => saveTemplateDialog(name) } : null,
    !can('operator') ? null : { label: T.orgCloseSquad, danger: true, disabled: !running.length, run: () => confirmDialog({
      title: T.orgCloseSquadTitle(squadTitle(name)), text: T.orgCloseSquadText(running.map(n => `<b>${esc(n)}</b>`).join(', ')), confirm: T.orgCloseSquad, danger: true,
      run: async () => { for (const n of running) { const w = terminalOf(n); if (w) await postJson('/api/terminals/kill', { host: w.host.id, term: n }) } },
    }) },
    !can('manager') ? null : { label: T.orgDeleteSquad, danger: true, disabled: anyOn || running.length > 0, run: () => confirmDialog({
      title: T.orgDeleteSquadTitle(squadTitle(name)), text: T.orgDeleteSquadText(members.map(n => `<b>${esc(n)}</b>`).join(', ')), confirm: T.orgDeleteSquad, danger: true,
      run: async () => { for (const n of members) if (sessions.has(n)) await post('delete', n) },
    }) },
  ])
}

function agentMenu(anchor, name) {
  const s = sessions.get(name)
  if (!s) return
  const where = terminalOf(name)
  const role = s.opened_role ?? s.role
  orgMenuAt(anchor, [
    can('manager') ? { label: T.orgDescribe, run: () => describeDialog(name) } : null,
    can('operator') && s.host_id && (role === 'worker' || role === 'coordinator') ? { label: T.orgReshape, disabled: !hosts.get(s.host_id)?.online, run: () => reshapeDialog(name) } : null,
    where && can('operator') ? { label: T.terminal, run: () => { location.hash = `#/t/${encodeURIComponent(where.host.id)}/${encodeURIComponent(name)}` } } : null,
    { label: T.openChat, run: () => { location.hash = `#/s/${encodeURIComponent(name)}/chat` } },
    reopenable(s) && can('operator') ? { label: T.reopen, run: () => reopen(name) } : null,
    where && can('operator') ? { label: T.closeSession, danger: true, run: () => hostAction('kill', where.host.id, name) } : null,
    can('manager') ? { label: T.deleteSession, danger: true, disabled: s.online, run: () => runAction('delete', name) } : null,
  ])
}

function linkMenu(anchor, a, b) {
  const l = state.links.find(x => x.a === a && x.b === b)
  if (!l || !can('manager')) return
  orgMenuAt(anchor, [
    { label: T.unlink, danger: true, run: () => postJson('/api/links/delete', { a, b }).then(r => { if (r?.warnings?.length) alertBox(r.warnings.join(' · ')) }).catch(err => alertBox(err.message)) },
  ], `${esc(squadTitle(a))} ↔ ${esc(squadTitle(b))}<br>${esc(T.orgLinkRecent(recentOf(l)))}`)
}

export function squadDialog(name) {
  const m = state.squadMeta.get(name) ?? {}
  const d = dialog(`<h3>${esc(T.orgEditSquadTitle(name))}</h3>
      <label class="field"><span>${T.orgSquadTitle}</span><input type="text" name="title" maxlength="40" value="${esc(m.title ?? '')}" placeholder="${esc(name)}" autocomplete="off"></label>
      <label class="field"><span>${T.orgGoal}</span><textarea name="goal" maxlength="300" rows="3">${esc(m.goal ?? '')}</textarea><span class="hint">${T.orgGoalHint}</span></label>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`)
  const f = n => d.el.querySelector(`[name=${n}]`)
  f('title').focus()
  d.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try { await postJson('/api/org/squad', { coordinator: name, title: f('title').value, goal: f('goal').value }); d.close() } catch (err) { d.el.querySelector('.err').textContent = err.message }
  })
}

function describeDialog(name) {
  const s = sessions.get(name)
  if (!s) return
  const d = dialog(`<h3>${esc(T.orgDescribeTitle(name))}</h3>
      <label class="field"><span>${T.orgPurpose}</span><textarea name="desc" maxlength="300" rows="3" placeholder="${esc(s.persona?.description ?? '')}">${esc(s.description ?? '')}</textarea><span class="hint">${T.orgDescribeHint}</span></label>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`)
  const ta = d.el.querySelector('textarea')
  ta.focus()
  d.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try { await postJson('/api/org/describe', { name, description: ta.value }); d.close() } catch (err) { d.el.querySelector('.err').textContent = err.message }
  })
}

// Another persona, or (a worker) another squad: both are fixed when a
// session starts (its system prompt, its coordinator), so the session is
// closed and opened again with them, in the same folder.
function reshapeDialog(name) {
  const s = sessions.get(name)
  const h = hosts.get(s?.host_id)
  if (!s || !h?.online) return alertBox(T.orgNeedsMachine)
  const where = terminalOf(name)
  const folder = where?.term.folder ?? s.activity?.cwd
  if (!folder) return alertBox(T.orgNoFolder(name))
  const role = s.opened_role ?? s.role
  const coords = orgSquads().squads.map(q => q.coord).filter(x => x.name !== name)
  const resume = h.info?.allow_resume === true
  const was = where?.term.persona?.id ?? s.opened_persona ?? ''
  const d = dialog(`<h3>${esc(T.orgReshapeTitle(name))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.orgReshapeHint(esc(folder))}</p>
      <label class="field"><span>${T.persona}</span><select name="persona"><option value="">${T.personaNone}</option></select></label>
      <div class="persona-hint"></div>
      ${role === 'worker' ? `<label class="field"><span>${T.orgSquad}</span><select name="coord">${coords.map(c => `<option value="${esc(c.name)}" ${c.name === s.coordinator ? 'selected' : ''}>${esc(squadTitle(c.name))}${squadTitle(c.name) !== c.name ? ` (${esc(c.name)})` : ''}</option>`).join('')}</select></label>` : ''}
      ${resume ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0 10px"><input type="checkbox" name="resume" checked> ${T.orgResume}</label>` : `<p class="hint" style="font-size:12px;color:var(--muted)">${T.orgNoResume}</p>`}
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.orgReopenBtn}</button></div>`, { wide: true })
  const f = n => d.el.querySelector(`[name=${n}]`)
  const hint = d.el.querySelector('.persona-hint')
  let list = []
  const note = () => { const p = list.find(x => x.id === f('persona').value); hint.textContent = p?.description ?? '' }
  f('persona').addEventListener('change', note)
  postJson('/api/hosts/personas', { host: h.id, folder }).then(r => {
    list = r.personas ?? []
    f('persona').innerHTML = `<option value="">${T.personaNone}</option>${personaOptions(list, was, false)}`
    note()
  }).catch(err => { hint.textContent = `${T.personaLoadFailed}: ${err.message}` })
  const ok = d.el.querySelector('[data-ok]')
  ok.addEventListener('click', async () => {
    const spec = { name, role, folder }
    if (role === 'worker') spec.coordinator = f('coord')?.value || orgCoordOf(s)
    if (f('persona').value) spec.persona = f('persona').value
    if (where?.term.compact_window) spec.compact_window = where.term.compact_window
    if (f('resume')?.checked) spec.resume = true
    ok.disabled = true
    ok.textContent = T.orgReopening
    try {
      if (where) await postJson('/api/terminals/kill', { host: h.id, term: name })
      // (Until its terminal is gone and it is no longer connected: the name is free again.)
      const t0 = Date.now()
      while (terminalOf(name) || sessions.get(name)?.online) {
        if (Date.now() - t0 > 20_000) throw new Error(T.orgStillOn(name))
        await new Promise(r => setTimeout(r, 300))
      }
      await postJson('/api/terminals/open', { host: h.id, spec })
      d.close()
      location.hash = `#/t/${encodeURIComponent(h.id)}/${encodeURIComponent(name)}`
    } catch (err) {
      d.el.querySelector('.err').textContent = err.message
      ok.disabled = false
      ok.textContent = T.orgReopenBtn
    }
  })
}

// links between squads: two coordinators that may message each other. Set
// here; the machine of each one is told while it runs.
export function linksDialog(coord) {
  const body = () => {
    const mine = linksOf(coord)
    const others = sortedSessions().filter(s => s.role === 'coordinator' && s.name !== coord && !mine.includes(s.name))
    return `${mine.length
      ? `<div class="tpl-list">${mine.map(n => { const o = sessions.get(n); return `<div class="tpl-row"><span class="dot ${o ? status(o).dot : ''}"></span><span class="n">${esc(n)}</span><span class="m">${personaTag(o?.persona)}</span><button class="btn danger" data-unlink="${esc(n)}">${T.unlink}</button></div>` }).join('')}</div>`
      : `<p class="hint">${T.noLinks}</p>`}
      ${others.length
      ? `<label class="field"><span>${T.linkWith}</span><span style="display:flex;gap:8px"><select name="peer" style="flex:1">${others.map(o => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('')}</select><button class="btn primary" data-link>${T.linkAdd}</button></span></label>`
      : `<p class="hint">${T.noOtherCoordinators}</p>`}`
  }
  const d = dialog(`<h3>${esc(T.linksTitle(coord))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.linksHint}</p>
      <div data-body>${body()}</div>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.done}</button></div>`, { wide: true })
  const err = d.el.querySelector('.err')
  const refresh = () => setHtml(d.el.querySelector('[data-body]'), body())
  linkListeners.add(refresh)
  const closed = d.el.onclose
  d.el.onclose = () => { linkListeners.delete(refresh); closed?.() }
  const change = async (path, other) => {
    err.textContent = ''
    try {
      const r = await postJson(path, { a: coord, b: other })
      // (The link is set; a machine that couldn't apply it now says why.)
      if (r?.warnings?.length) err.textContent = r.warnings.join(' · ')
    } catch (e) { err.textContent = e.message }
  }
  d.el.addEventListener('click', e => {
    if (e.target.closest('[data-link]')) return change('/api/links/add', d.el.querySelector('[name=peer]').value)
    const u = e.target.closest('[data-unlink]')
    if (u) change('/api/links/delete', u.dataset.unlink)
  })
}
