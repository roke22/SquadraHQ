import { $, store } from './dom.js'
import { T, LOCALE, COLLATOR } from './i18n.js'
import { state, sessions, can, companyPref } from './state.js'
import { esc, ago } from './format.js'
import { api } from './api.js'
import { postJson } from './machines.js'
import { setHtml, soon, renderNav } from './nav.js'
import { currentRoute } from './router.js'
import { dialog, confirmDialog } from './dialogs.js'
import { alertBox } from './mosaic.js'
import { icon } from './icons.js'
import { renderTop } from './topbar.js'

// Task boards: the company's, each seen by the teams it is given. People and
// agents work on the same tasks. Giving a task to an agent tells nobody by
// itself: the person says when ("Notify" now, or "Notify the teams" once they
// are done handing out), and a mistake never sets anyone to work.
// A column can be a step of the board's flow: who handles it, what to do
// there, where a task goes once done. A task moved there is that one's (asked
// before telling, as any other, when a person moved it).
// A task can have subtasks (as GitHub's sub-issues): tasks of their own, each
// with its card; the parent shows them and how many are finished.

const CATEGORIES = ['backlog', 'unstarted', 'started', 'review', 'done', 'closed']
const COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink']
const ACTIVE = new Set(['unstarted', 'started', 'review'])

const tasksOf = new Map()    // board id -> Map(seq -> task), loaded when the board is opened
const loading = new Map()    // board id -> its request
let people = { members: [], sessions: {} } // who a board's tasks can be given to
let peopleAt = 0
const filters = new Map()    // board id -> { text, who, label, type, pending }
let detail = null            // the open task, whole: { seq, task, dirty }
let shownKey = null          // what the board's frame was drawn for
let startAt = false          // (to scroll to where work waits, once it is drawn)

const mode = () => (store.get(companyPref('squadraBoardMode')) === 'list' ? 'list' : 'cols')
const boardOf = id => state.boards.find(b => b.id === Number(id)) ?? null
const statusOf = (b, id) => b?.statuses.find(s => s.id === id) ?? null
const categoryOf = (b, t) => statusOf(b, t.status)?.category ?? 'unstarted'
const prefixed = seq => `${state.boardPrefix}-${seq}`
// The coordinator of a session's team: who hears of a task given to it.
const teamOf = (boardId, name) => people.sessions[boardId]?.find(s => s.name === name)?.team ?? (sessions.get(name)?.role === 'coordinator' ? name : sessions.get(name)?.coordinator ?? null)

async function loadPeople(force = false) {
  if (!force && Date.now() - peopleAt < 30_000) return
  peopleAt = Date.now()
  try {
    const r = await api('/api/boards')
    people = { members: r.members ?? [], sessions: r.sessions ?? {} }
    state.boardPrefix = r.prefix ?? state.boardPrefix
    state.boards = r.boards ?? state.boards
  } catch {}
}

async function loadTasks(id) {
  if (loading.has(id)) return loading.get(id)
  const p = api(`/api/boards/tasks?board=${id}`).then(list => {
    tasksOf.set(id, new Map(list.map(t => [t.seq, compact(t)])))
  }).finally(() => loading.delete(id))
  loading.set(id, p)
  return p
}

// --- GitHub, while the board is in use ----------------------------------------
// The server asks GitHub only while someone looks: when a board connected to
// it is opened (or a task of it), and every few minutes while it stays open
// and the browser tab is in sight. What changes comes back by the stream.
const WATCH_EVERY = 180_000
let watching = null // { board, task, timer }
function stopWatching() { if (watching) clearInterval(watching.timer); watching = null }
function stillShown() {
  const r = currentRoute()
  return !!watching && r.view === 'board' && Number(r.board) === watching.board && !$('boards').hidden && !!boardOf(watching.board)?.github
}
function watchPing(extra = {}) {
  if (!stillShown()) { stopWatching(); return }
  if (document.visibilityState !== 'visible') return
  void postJson('/api/boards/github-watch', { board: watching.board, ...(watching.task ? { task: watching.task } : {}), ...extra }).catch(() => {})
}
function watchGithub(b, task) {
  if (!b?.github) { stopWatching(); return }
  if (watching?.board === b.id && watching.task === task) return
  const opened = watching?.board !== b.id
  const taskOpened = !!task && (opened || watching.task !== task)
  stopWatching()
  watching = { board: b.id, task, timer: setInterval(() => watchPing(), WATCH_EVERY) }
  watchPing({ ...(opened ? { opened: true } : {}), ...(taskOpened ? { taskOpened: true } : {}) })
}
document.addEventListener('visibilitychange', () => { if (watching && document.visibilityState === 'visible') watchPing() })

// --- from the stream ------------------------------------------------------------
export function boardsArrived(list) {
  state.boards = Array.isArray(list) ? list : []
  const r = currentRoute()
  if (r.view === 'boards' || r.view === 'board') { soon(renderBoards); soon(renderTop) }
  soon(renderNav)
}
export function taskArrived(t) {
  const map = tasksOf.get(t.board)
  if (map) { if (t.deleted) map.delete(t.seq); else map.set(t.seq, compact(t)) }
  const r = currentRoute()
  if (r.view === 'board' && Number(r.board) === t.board) {
    soon(renderBoard)
    if (detail?.seq === t.seq) {
      if (t.deleted) { detail = null; soon(renderBoard) } else void openTask(t.seq, { quiet: true })
    }
  }
}
export function boardDeleted({ id }) {
  tasksOf.delete(id)
  if (currentRoute().view === 'board' && Number(currentRoute().board) === id) location.hash = '#/boards'
}

// --- what a task looks like ---------------------------------------------------
const colorVar = c => (COLORS.includes(c) ? c : 'gray')
const chip = (name, color, cls = 'lbl') => `<span class="${cls}" data-color="${colorVar(color)}">${esc(name)}</span>`
function labelChips(b, t) {
  return t.labels.map(id => b.labels.find(l => l.id === id)).filter(Boolean).map(l => chip(l.name, l.color)).join('')
}
function typeChip(b, t) {
  const ty = t.type && b.types.find(x => x.id === t.type)
  return ty ? chip(ty.name, ty.color, 'lbl type') : ''
}
const prioTag = p => (p > 0 ? `<span class="bd-prio" data-p="${p}" title="${esc(T.taskPriority)}: ${esc(T.priorities[p])}">${esc(T.priorities[p])}</span>` : '')
const DUE_FMT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' })
function dueTag(b, t) {
  if (!t.due) return ''
  const late = new Date(`${t.due}T23:59:59Z`).getTime() < Date.now() && !['done', 'closed'].includes(categoryOf(b, t))
  return `<span class="bd-due${late ? ' late' : ''}" title="${esc(T.taskDue)}">${esc(DUE_FMT.format(new Date(`${t.due}T00:00:00Z`)))}</span>`
}
function whoTag(a) {
  if (!a) return ''
  if (a.kind === 'user') return `<span class="bd-who">${icon('teams')}${esc(a.name)}</span>`
  const role = sessions.get(a.id)?.role === 'coordinator' ? 'coord' : 'worker'
  return `<span class="bd-who bd-agent"><span class="role ${role}" aria-hidden="true"></span>${esc(a.id)}</span>`
}
// The people of a task: their initials (three at most, then how many more), their names on hover.
function peopleTag(list) {
  if (!list?.length) return ''
  const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('')
  return `<span class="bd-ppl-tag" title="${esc(list.map(p => p.name).join(', '))}">${list.slice(0, 3).map(p => `<span class="bd-av">${esc(initials(p.name))}</span>`).join('')}${list.length > 3 ? `<span class="bd-av more">+${list.length - 3}</span>` : ''}</span>`
}
// (Backlog never tells anyone: there it isn't waiting to be told.)
const untold = (b, t) => t.notify === 'pending' && t.assignee?.kind === 'session' && ACTIVE.has(statusOf(b, t.status)?.category)
const pendingTag = (b, t) => (untold(b, t) ? `<span class="bd-pending" title="${esc(T.pendingTitle)}">${esc(T.pendingTag)}</span>` : '')

// Subtasks: the one it belongs to, and how many of its own are finished.
function parentTag(b, t) {
  if (!t.parent) return ''
  const p = tasksOf.get(b.id)?.get(t.parent)
  return `<span class="bd-parent" title="${esc(T.bSubOf(prefixed(t.parent), p?.title ?? ''))}">↑ ${esc(prefixed(t.parent))}</span>`
}
// Its pull requests: on the card, how many and how the latest stands; open, the list.
const prLine = p => `#${p.number} «${p.title}»: ${T.prState[p.state] ?? p.state}${p.review ? `, ${T.prReview[p.review] ?? p.review}` : ''}`
const prTag = t => (t.prs?.length ? `<span class="bd-pr-tag" data-pr="${esc(t.prs[0].state)}" title="${esc(`${T.bPrsTag(t.prs.length)}\n${t.prs.map(prLine).join('\n')}`)}">${icon('pr')}${t.prs.length}</span>` : '')
function prList(t) {
  if (!t.prs?.length) return ''
  return `<section class="bd-prsec"><h3>${esc(T.bPrs)}</h3><ul class="bd-prs">${t.prs.map(p => `<li data-pr="${esc(p.state)}"><span class="bd-pr-ic" aria-hidden="true">${icon('pr')}</span>
      <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><span class="bd-id">#${p.number}</span> ${esc(p.title)}</a><span class="grow"></span>
      ${p.review ? `<span class="bd-pr-rv" data-rv="${esc(p.review)}">${esc(T.prReview[p.review] ?? p.review)}</span>` : ''}<span class="bd-pr-st">${esc(T.prState[p.state] ?? p.state)}</span></li>`).join('')}</ul></section>`
}
const progressTag = t => (t.subtasks ? `<span class="bd-subs-n${t.subtasks.done === t.subtasks.total ? ' all' : ''}" title="${esc(T.bSubProgress(t.subtasks.done, t.subtasks.total))}">☑ ${t.subtasks.done}/${t.subtasks.total}</span>` : '')

function card(b, t) {
  return `<article class="bd-card${detail?.seq === t.seq ? ' on' : ''}" data-task="${t.seq}"${can('operator') ? ' draggable="true"' : ''}>
      <div class="bd-card-top"><span class="bd-id">${esc(prefixed(t.seq))}</span>${parentTag(b, t)}${typeChip(b, t)}${prioTag(t.priority)}${pendingTag(b, t)}</div>
      <a class="bd-title" href="#/b/${b.id}/${esc(prefixed(t.seq))}">${esc(t.title)}</a>
      ${t.labels.length || t.due || t.assignee || t.people?.length || t.comments || t.subtasks || t.prs?.length ? `<div class="bd-card-foot">${labelChips(b, t)}${dueTag(b, t)}${progressTag(t)}${prTag(t)}${t.comments ? `<span class="bd-ncom" title="${esc(T.bComments)}">💬 ${t.comments}</span>` : ''}${whoTag(t.assignee)}${peopleTag(t.people)}</div>` : ''}
    </article>`
}

// How the board stands with GitHub, in a few words.
// The board's state with GitHub, in its header: when it was last synced (the
// exact time on hover), what is on its way, whether it failed (and why, on a
// click), and a button to sync now. It follows the server as it changes.
const TIME_FMT_GH = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })
function lastSync(t) {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? T.ghStLastToday(TIME_FMT_GH.format(d)) : T.ghStLastOn(WHEN_FMT.format(d))
}
function ghStatus(b) {
  const g = b.github
  if (!g) return ''
  const busy = g.syncing
  let text
  if (g.error) text = `<button type="button" class="bd-gherr" data-gherr>${esc(T.ghStFailed)}</button>${g.pending ? ` · ${esc(T.ghStUnsent(g.pending))}` : ''}`
  else if (busy) text = esc(T.ghStSyncing)
  else if (g.pending) text = esc(T.ghStSending(g.pending))
  else text = esc(g.synced_at ? T.ghStSynced(ago(g.synced_at)) : T.ghStNever)
  const title = g.synced_at ? lastSync(g.synced_at) : ''
  const now = can('operator') ? `<button type="button" class="icon-btn bd-ghnow" data-ghnow title="${esc(T.ghStNow)}" aria-label="${esc(T.ghStNow)}"${busy ? ' disabled' : ''}>${icon('refresh')}</button>` : ''
  return `<span class="bd-ghstat${g.error ? ' err' : ''}${busy ? ' busy' : ''}" data-ghstat title="${esc(title)}"><span class="long">GitHub · </span><span class="bd-ghtext" aria-live="polite">${text}</span>${now}</span>`
}
// («5 minutes ago» stays true while the board is shown.)
setInterval(() => { const r = currentRoute(); if (r.view === 'board' && boardOf(r.board)?.github) renderTop() }, 30_000)

// --- the list of boards -------------------------------------------------------
function boardCard(b) {
  const open = b.statuses.filter(s => !['done', 'closed'].includes(s.category)).reduce((n, s) => n + s.tasks, 0)
  const all = b.statuses.reduce((n, s) => n + s.tasks, 0)
  const teams = b.teams.map(c => state.squadMeta.get(c)?.title || c)
  return `<a class="card bl-card${b.archived_at ? ' archived' : ''}" href="#/b/${b.id}" aria-label="${esc(T.bOpenBoard(b.name))}">
      <div class="bl-h"><b>${esc(b.name)}</b>${b.archived_at ? `<span class="tag">${esc(T.archivedTag)}</span>` : ''}${b.pending ? `<span class="bd-pending">${esc(T.pendingTag)} · ${b.pending}</span>` : ''}</div>
      ${b.description ? `<p class="bl-desc">${esc(b.description)}</p>` : ''}
      <div class="bl-meta"><span>${esc(T.ofTotal(open, all))} · ${esc(T.bTasks(all))}</span><span>${esc(teams.join(', ') || '—')}</span></div>
      <div class="bl-bar" aria-hidden="true">${b.statuses.filter(s => s.tasks).map(s => `<span data-cat="${s.category}" style="flex:${s.tasks}"></span>`).join('')}</div>
    </a>`
}

function renderList() {
  shownKey = null
  const live = state.boards.filter(b => !b.archived_at)
  const archived = state.boards.filter(b => b.archived_at)
  setHtml($('boards'), `<div class="bl">${state.boards.length
    ? `<div class="bl-grid">${live.map(boardCard).join('')}</div>${archived.length ? `<h2 class="bl-sec">${esc(T.archivedTag)}</h2><div class="bl-grid">${archived.map(boardCard).join('')}</div>` : ''}`
    : `<div class="empty">${icon('board', 'empty-ic')}<b>${esc(T.noBoards)}</b><span>${esc(T.noBoardsHint)}</span>${can('manager') ? `<button type="button" class="btn primary" data-newboard>${esc(T.newBoard)}</button>` : ''}</div>`}</div>`)
  $('topSub').textContent = state.boards.length ? T.boardsCount(live.length) : ''
}

// --- one board ----------------------------------------------------------------
const filterOf = id => filters.get(id) ?? (filters.set(id, { text: '', who: '', label: '', type: '', pending: false }), filters.get(id))
function matches(b, t, f) {
  if (f.text && !`${prefixed(t.seq)} ${t.title}`.toLowerCase().includes(f.text.toLowerCase())) return false
  if (f.who === '-' && (t.assignee || t.people?.length)) return false
  if (f.who && f.who !== '-' && assigneeValue(t.assignee) !== f.who && !(t.people ?? []).some(p => `u:${p.id}` === f.who)) return false
  if (f.label && !t.labels.includes(Number(f.label))) return false
  if (f.type && t.type !== Number(f.type)) return false
  if (f.pending && !untold(b, t)) return false
  return true
}
const byRank = (a, b) => a.rank - b.rank || a.seq - b.seq
// A task as the board keeps it: its comments counted, not listed.
const compact = t => ({ ...t, comments: Array.isArray(t.comments) ? t.comments.length : t.comments ?? 0 })

// Who a task can be given to: people, then each team, its coordinator first.
function assigneeOptions(b, value) {
  const opt = (v, label) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`
  const teams = new Map()
  for (const s of people.sessions[b.id] ?? []) { if (!teams.has(s.team)) teams.set(s.team, []); teams.get(s.team).push(s.name) }
  const groups = [...teams].map(([team, names]) => `<optgroup label="${esc(T.bTeamOf(state.squadMeta.get(team)?.title || team))}">${names.sort((x, y) => (x === team ? -1 : y === team ? 1 : COLLATOR.compare(x, y))).map(n => opt(`s:${n}`, n === team ? `${n} (${T.roleCoordinator})` : n)).join('')}</optgroup>`)
  return `${opt('', T.nobody)}${groups.join('')}`
}
// What a task can be a subtask of: any other task of the board but its own subtasks.
function parentOptions(b, t) {
  const map = tasksOf.get(b.id) ?? new Map()
  const under = seq => { for (let x = map.get(seq), n = 0; x?.parent && n < 20; x = map.get(x.parent), n++) if (x.parent === t.seq) return true; return false }
  const list = [...map.values()].filter(x => x.seq !== t.seq && !(t.seq && under(x.seq))).sort((x, y) => x.seq - y.seq)
  const opt = (v, label) => `<option value="${v}"${String(v) === String(t.parent ?? '') ? ' selected' : ''}>${esc(label)}</option>`
  return opt('', T.noParent) + list.map(x => opt(x.seq, `${prefixed(x.seq)} · ${x.title}`)).join('')
}
const assigneeValue = a => (a ? `${a.kind === 'user' ? 'u' : 's'}:${a.id}` : '')
const assigneeFrom = v => (!v ? null : { kind: v.startsWith('u:') ? 'user' : 'session', id: v.slice(2) })

function filterBar(b) {
  const f = filterOf(b.id)
  const who = new Map()
  for (const t of tasksOf.get(b.id)?.values() ?? []) {
    if (t.assignee) who.set(assigneeValue(t.assignee), t.assignee.kind === 'user' ? t.assignee.name : t.assignee.id)
    for (const p of t.people ?? []) who.set(`u:${p.id}`, p.name)
  }
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`
  return `<div class="bd-filters" role="search">
      <input type="search" class="input" data-bf="text" placeholder="${esc(T.bFilter)}" aria-label="${esc(T.bFilter)}" value="${esc(f.text)}">
      <select class="input" data-bf="who" aria-label="${esc(T.taskAssignee)}">${opt('', T.bAnyone, f.who)}${opt('-', T.nobody, f.who)}${[...who].sort((x, y) => COLLATOR.compare(x[1], y[1])).map(([v, n]) => opt(v, n, f.who)).join('')}</select>
      ${b.labels.length ? `<select class="input" data-bf="label" aria-label="${esc(T.taskLabels)}">${opt('', T.bAnyLabel, f.label)}${b.labels.map(l => opt(String(l.id), l.name, f.label)).join('')}</select>` : ''}
      ${b.types.length ? `<select class="input" data-bf="type" aria-label="${esc(T.taskType)}">${opt('', T.bAnyType, f.type)}${b.types.map(x => opt(String(x.id), x.name, f.type)).join('')}</select>` : ''}
      <label class="check bd-onlypending"><input type="checkbox" data-bf="pending"${f.pending ? ' checked' : ''}> <span>${esc(T.bOnlyPending)}</span></label>
    </div>`
}

// A column's step, in a line: who handles it and where a task goes next.
const handlerName = h => (h.kind === 'user' ? h.name : h.id)
function stepLine(b, s) {
  const parts = [s.handler ? T.stepBy(handlerName(s.handler)) : '', s.next ? T.stepThen(statusOf(b, s.next)?.name ?? '?') : ''].filter(Boolean)
  if (!parts.length && !s.instructions) return ''
  return `<div class="bd-step"${s.instructions ? ` title="${esc(s.instructions)}"` : ''}>${esc(parts.join(' · ') || T.stepInstructionsOnly)}</div>`
}
function columns(b, list) {
  return `<div class="bd-cols">${b.statuses.map(s => {
    const here = list.filter(t => t.status === s.id).sort(byRank)
    return `<section class="bd-col" data-status="${s.id}" data-cat="${s.category}" aria-label="${esc(s.name)}">
        <header class="bd-col-h"><span class="bd-dot" data-cat="${s.category}" aria-hidden="true"></span><h2>${esc(s.name)}</h2><span class="bd-count">${here.length}</span>
          ${can('manager') && !b.archived_at ? `<button type="button" class="icon-btn" data-colflow="${s.id}" title="${esc(T.stepTitle(s.name))}" aria-label="${esc(T.stepTitle(s.name))}">${icon('more')}</button>` : ''}
          ${can('operator') && !b.archived_at ? `<button type="button" class="icon-btn" data-newtask="${s.id}" title="${esc(T.bAddTo(s.name))}" aria-label="${esc(T.bAddTo(s.name))}">${icon('plus')}</button>` : ''}</header>
        ${stepLine(b, s)}
        <div class="bd-col-body">${here.map(t => card(b, t)).join('')}</div>
      </section>`
  }).join('')}</div>`
}

function table(b, list) {
  const order = new Map(b.statuses.map((s, i) => [s.id, i]))
  const rows = [...list].sort((x, y) => (order.get(x.status) - order.get(y.status)) || byRank(x, y))
  return `<div class="bd-tablewrap"><table class="bd-table">
      <thead><tr><th>${esc('ID')}</th><th>${esc(T.taskTitle)}</th><th>${esc(T.taskStatus)}</th><th>${esc(T.taskType)}</th><th>${esc(T.taskLabels)}</th><th>${esc(T.taskAssignee)}</th><th>${esc(T.taskPriority)}</th><th>${esc(T.taskDue)}</th></tr></thead>
      <tbody>${rows.map(t => `<tr data-task="${t.seq}"${detail?.seq === t.seq ? ' class="on"' : ''}>
        <td class="bd-id">${esc(prefixed(t.seq))}</td>
        <td>${parentTag(b, t)} <a class="bd-title" href="#/b/${b.id}/${esc(prefixed(t.seq))}">${esc(t.title)}</a> ${progressTag(t)} ${pendingTag(b, t)}</td>
        <td><span class="bd-dot" data-cat="${categoryOf(b, t)}" aria-hidden="true"></span>${esc(statusOf(b, t.status)?.name ?? '')}</td>
        <td>${typeChip(b, t)}</td><td>${labelChips(b, t)}</td><td>${whoTag(t.assignee)}</td><td>${prioTag(t.priority)}</td><td>${dueTag(b, t)}</td>
      </tr>`).join('')}</tbody></table></div>`
}

export function renderBoard() {
  const r = currentRoute()
  const b = boardOf(r.board)
  if (!b) { shownKey = null; stopWatching(); setHtml($('boards'), `<div class="empty"><b>${esc(T.boardGone)}</b></div>`); return }
  if (!tasksOf.has(b.id)) {
    void loadTasks(b.id).then(() => soon(renderBoard), err => alertBox(err.message))
    void loadPeople().then(() => soon(renderBoard))
  }
  const key = String(b.id) // (the view switch redraws the tasks, not the task open beside them)
  if (shownKey !== key) {
    shownKey = key
    $('boards')._html = undefined // (not what setHtml drew last any more)
    $('boards').innerHTML = '<div class="bd"><div class="bd-main"><div class="bd-fbar"></div><div class="bd-view"></div></div><aside class="bd-panel" hidden></aside></div>'
    startAt = true
  }
  const all = [...(tasksOf.get(b.id)?.values() ?? [])]
  const f = filterOf(b.id)
  const list = all.filter(t => matches(b, t, f))
  setHtml($('boards').querySelector('.bd-fbar'), filterBar(b))
  const empty = tasksOf.has(b.id) && !list.length ? `<div class="bd-empty">${esc(all.length ? T.bNoMatch : T.bNoTasks)}</div>` : ''
  setHtml($('boards').querySelector('.bd-view'), (mode() === 'list' ? table(b, list) : columns(b, list)) + empty)
  // (On a phone, one column shows: the first where work waits, not the backlog.)
  if (startAt && tasksOf.has(b.id)) {
    startAt = false
    const first = $('boards').querySelector('.bd-col[data-cat=unstarted], .bd-col[data-cat=started]')
    if (first && matchMedia('(max-width: 900px)').matches) $('boards').querySelector('.bd-view').scrollLeft = first.offsetLeft - 12
  }
  $('topSub').textContent = tasksOf.has(b.id) ? T.bTasks(all.length) : ''
  // The task open beside it.
  const want = r.task ?? null
  const wantSeq = want && want !== 'new' ? Number(/(\d+)$/.exec(want)?.[1]) || null : null
  watchGithub(b, wantSeq)
  const panel = $('boards').querySelector('.bd-panel')
  if (!want) { if (detail) { detail = null } panel.hidden = true; $('boards').querySelector('.bd').classList.remove('with-panel'); return }
  $('boards').querySelector('.bd').classList.add('with-panel')
  panel.hidden = false
  if (want === 'new') { if (detail?.seq !== 'new') drawNew(b) } else {
    const seq = Number(/(\d+)$/.exec(want)?.[1])
    if (detail?.seq !== seq) void openTask(seq)
  }
}

export function renderBoards() {
  const r = currentRoute()
  if (r.view === 'boards') { detail = null; stopWatching(); renderList(); void loadPeople() } else renderBoard()
}
export const refreshBoards = () => { const r = currentRoute(); if ((r.view === 'boards' || r.view === 'board') && !$('boards').hidden) renderBoards() }

// What the header shows for the boards: title, view switch and actions.
export function boardsHead(r) {
  if (r.view === 'boards') {
    return { title: esc(T.boards), tabs: '', right: can('manager') ? `<button class="btn primary" data-newboard>${esc(T.newBoard)}</button>` : '' }
  }
  const b = boardOf(r.board)
  if (!b) return { title: esc(T.boards), tabs: '', right: '' }
  const m = mode()
  const tabs = `<nav class="seg" aria-label="${esc(b.name)}"><button type="button" data-bmode="cols"${m === 'cols' ? ' aria-pressed="true"' : ''}>${esc(T.bColumns)}</button><button type="button" data-bmode="list"${m === 'list' ? ' aria-pressed="true"' : ''}>${esc(T.bList)}</button></nav>`
  const right = [
    ghStatus(b),
    can('operator') && b.pending ? `<button class="btn ok" data-bnotify>${esc(T.notifyTeams(b.pending))}</button>` : '',
    can('operator') && !b.archived_at ? `<a class="btn primary" href="#/b/${b.id}/new">${esc(T.newTask)}</a>` : '',
    can('manager') && b.trash ? `<button class="icon-btn" data-btrash title="${esc(T.bTrash(b.trash))}" aria-label="${esc(T.bTrash(b.trash))}">${icon('trash')}</button>` : '',
    can('manager') ? `<button class="icon-btn" data-bsettings title="${esc(T.boardSettings)}" aria-label="${esc(T.boardSettings)}">${icon('settings')}</button>` : '',
  ].join('')
  return { title: `${esc(b.name)}${b.archived_at ? ` <span class="tag">${esc(T.archivedTag)}</span>` : ''}`, tabs, right }
}

// --- the task beside the board ------------------------------------------------
function form(b, t) {
  const ro = !can('operator') || !!b.archived_at
  const dis = ro ? ' disabled' : ''
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(label)}</option>`
  const coordinator = t.assignee?.kind === 'session' ? teamOf(b.id, t.assignee.id) : null
  return `<form class="bd-form" data-bform novalidate>
      <label class="field"><span>${esc(T.taskTitle)}</span><input type="text" name="title" maxlength="200" required value="${esc(t.title ?? '')}"${dis}></label>
      <div class="bd-grid2">
        <label class="field"><span>${esc(T.taskStatus)}</span><select name="status"${dis}>${b.statuses.map(s => opt(s.id, s.name, t.status)).join('')}</select>${stepLine(b, statusOf(b, t.status) ?? {})}</label>
        <label class="field"><span>${esc(T.taskType)}</span><select name="type"${dis}>${opt('', T.noType, t.type ?? '')}${b.types.map(x => opt(x.id, x.name, t.type)).join('')}</select></label>
        <label class="field"><span>${esc(T.taskPriority)}</span><select name="priority"${dis}>${T.priorities.map((p, i) => opt(i, p, t.priority ?? 0)).join('')}</select></label>
        <label class="field"><span>${esc(T.taskDue)}</span><input type="date" name="due" value="${esc(t.due ?? '')}"${dis}></label>
      </div>
      <label class="field"><span>${esc(T.taskAgent)}</span><select name="assignee"${dis}>${assigneeOptions(b, assigneeValue(t.assignee))}</select>
        ${!(people.sessions[b.id] ?? []).length ? `<span class="hint">${esc(T.noAssignable)}</span>` : ''}
        ${untold(b, t) && coordinator ? `<span class="hint bd-pending-hint">${esc(T.pendingTitle)}</span>` : ''}</label>
      ${people.members.length ? `<fieldset class="bd-labels bd-ppl"><legend>${esc(T.taskPeople)}</legend>${people.members.map(m => `<label class="bd-lpick"${b.github && !m.github ? ` title="${esc(T.bNoGithubUser)}"` : ''}><input type="checkbox" name="person" value="${esc(m.id)}"${(t.people ?? []).some(x => x.id === m.id) ? ' checked' : ''}${dis}><span>${esc(m.name)}${b.github && !m.github ? ' <span class="dim-note">*</span>' : ''}</span></label>`).join('')}</fieldset>` : ''}
      <label class="field"><span>${esc(T.taskParent)}</span><select name="parent"${dis}>${parentOptions(b, t)}</select></label>
      ${b.labels.length ? `<fieldset class="bd-labels"><legend>${esc(T.taskLabels)}</legend>${b.labels.map(l => `<label class="bd-lpick"><input type="checkbox" name="label" value="${l.id}"${(t.labels ?? []).includes(l.id) ? ' checked' : ''}${dis}>${chip(l.name, l.color)}</label>`).join('')}</fieldset>` : ''}
      <label class="field"><span>${esc(T.taskDescription)}</span><textarea name="description" rows="7" maxlength="20000"${dis}>${esc(t.description ?? '')}</textarea></label>
      <div class="err" role="alert"></div>
      ${ro ? '' : `<div class="actions">${t.seq && can('manager') ? `<button type="button" class="btn danger" data-bdelete>${esc(T.deleteTask)}</button>` : ''}<button type="submit" class="btn primary">${esc(t.seq ? T.save : T.createTask)}</button></div>`}
    </form>`
}

const WHEN_FMT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const whoName = w => (w ? (w.kind === 'session' ? w.id : w.name) : '?')
function comments(b, t) {
  const coordinator = t.assignee?.kind === 'session' ? teamOf(b.id, t.assignee.id) : null
  const list = t.comments.map(c => `<li class="bd-com"><div class="bd-com-h"><b>${esc(whoName(c.author))}</b><span>${esc(WHEN_FMT.format(new Date(c.created_at)))}</span>${c.notified ? `<span class="tag">${esc(T.bToldTo(c.notified))}</span>` : ''}</div><p>${esc(c.text)}</p></li>`).join('')
  return `<h3>${esc(T.bComments)}${t.comments.length ? ` <span class="badge soft">${t.comments.length}</span>` : ''}</h3>
    <ul class="bd-coms">${list}</ul>
    ${can('operator') ? `<form class="bd-cform" data-bcomment>
      <textarea class="input" name="text" rows="3" maxlength="8000" placeholder="${esc(T.bCommentPh)}" aria-label="${esc(T.bComment)}"></textarea>
      ${coordinator ? `<label class="check"><input type="checkbox" name="notify"> <span>${esc(T.bNotifyCoord(coordinator))}</span></label>` : ''}
      <div class="err" role="alert"></div>
      <div class="actions"><button type="submit" class="btn">${esc(T.bComment)}</button></div></form>` : ''}`
}
function subtasks(b, t) {
  const rows = t.children.map(c => `<li data-task="${c.seq}"><span class="bd-dot" data-cat="${statusOf(b, c.status)?.category ?? 'unstarted'}" title="${esc(statusOf(b, c.status)?.name ?? '')}" aria-hidden="true"></span><span class="bd-id">${esc(prefixed(c.seq))}</span>
      <a class="bd-title" href="#/b/${b.id}/${esc(prefixed(c.seq))}">${esc(c.title)}</a>${progressTag(c)}<span class="grow"></span>${whoTag(c.assignee)}${peopleTag(c.people)}</li>`).join('')
  return `<h3>${esc(T.bSubtasks)}${t.subtasks ? ` <span class="badge soft">${t.subtasks.done}/${t.subtasks.total}</span>` : ''}</h3>
    ${rows ? `<ul class="bd-subs">${rows}</ul>` : ''}
    ${can('operator') && !b.archived_at ? `<button type="button" class="btn quiet" data-addsub>${icon('plus')} ${esc(T.bAddSubtask)}</button>` : ''}`
}
function history(t) {
  const what = e => (e.what === 'created' ? T.bCreatedIt : e.what === 'notified' ? T.bToldIt(e.data?.to ?? '?') : e.what === 'deleted' ? T.bDeletedIt : e.what === 'restored' ? T.bRestoredIt : e.what === 'pr' ? T.bPrIt(e.data ?? {}) : T.bChangedIt)
  return `<details class="bd-hist"><summary>${esc(T.bHistory)}</summary><ul>${t.events.map(e => `<li><b>${esc(whoName(e.who))}</b> ${esc(what(e))} <span>${esc(WHEN_FMT.format(new Date(e.at)))}</span></li>`).join('')}</ul></details>`
}

function panelHtml(b, t) {
  const gh = t.github?.url ? `<a class="bd-gh" href="${esc(t.github.url)}" target="_blank" rel="noopener noreferrer">${esc(T.ghIssue(t.github.number))}</a>` : t.github?.draft ? `<span class="bd-gh">${esc(T.ghDraft)}</span>` : ''
  return `<header class="bd-panel-h"><span class="bd-id">${esc(t.seq ? prefixed(t.seq) : T.newTask)}</span>${t.seq ? pendingTag(b, t) : ''}${gh}<span class="grow"></span>
      <a class="icon-btn" href="#/b/${b.id}" title="${esc(T.bClosePanel)}" aria-label="${esc(T.bClosePanel)}">${icon('close')}</a></header>
    <div class="bd-panel-body">${t.parent ? `<a class="bd-up" href="#/b/${b.id}/${esc(prefixed(t.parent))}">↑ ${esc(T.bSubOf(prefixed(t.parent), t.parent_title ?? ''))}</a>` : ''}${t.seq ? prList(t) : ''}${form(b, t)}${t.seq ? `<section class="bd-subsec">${subtasks(b, t)}</section><section class="bd-comsec">${comments(b, t)}</section>${history(t)}` : ''}</div>`
}

let newStatus = null
let newParent = null // (a subtask being added: the task it is of)
function drawNew(b) {
  const panel = $('boards').querySelector('.bd-panel')
  const status = newStatus ?? (b.statuses.find(s => s.category === 'unstarted') ?? b.statuses[0])?.id
  // (In a column someone handles: theirs, as the server will make it.)
  detail = { seq: 'new', task: { title: '', status, labels: [], priority: 0, assignee: statusOf(b, status)?.handler ?? null, parent: newParent }, dirty: false }
  panel.innerHTML = panelHtml(b, detail.task)
  panel.querySelector('[name=title]')?.focus()
  void loadPeople().then(() => { if (detail?.seq === 'new' && !detail.dirty) { panel.innerHTML = panelHtml(b, detail.task); panel.querySelector('[name=title]')?.focus() } })
}

async function openTask(seq, { quiet = false } = {}) {
  const b = boardOf(currentRoute().board)
  const panel = $('boards').querySelector('.bd-panel')
  if (!b || !panel) return
  if (!quiet) { detail = { seq, task: null, dirty: false }; panel.innerHTML = `<div class="bd-panel-body"><div class="dim-note">…</div></div>` }
  let t
  try { t = await api(`/api/boards/task?id=${seq}`) } catch {
    if (detail?.seq === seq) panel.innerHTML = `<header class="bd-panel-h"><span></span><a class="icon-btn" href="#/b/${b.id}" aria-label="${esc(T.bClosePanel)}">${icon('close')}</a></header><div class="empty"><b>${esc(T.bTaskGone)}</b></div>`
    return
  }
  if (detail?.seq !== seq) return
  // What is being typed stays: only the comments and the history follow.
  if (quiet && detail.dirty) {
    detail.task = { ...detail.task, comments: t.comments, events: t.events }
    const sec = panel.querySelector('.bd-comsec h3')
    if (sec) { const s = panel.querySelector('.bd-comsec'); const typed = s.querySelector('textarea')?.value ?? ''; s.innerHTML = comments(b, t); s.querySelector('textarea').value = typed }
    return
  }
  const typed = panel.querySelector('[data-bcomment] textarea')?.value ?? ''
  detail = { seq, task: t, dirty: false }
  panel.innerHTML = panelHtml(b, t)
  const ta = panel.querySelector('[data-bcomment] textarea')
  if (ta) ta.value = typed
}

// What the form says, as the server takes it.
function fromForm(f) {
  const v = n => f.elements[n]?.value
  return {
    title: v('title').trim(), status: Number(v('status')), type: v('type') ? Number(v('type')) : null, priority: Number(v('priority')),
    due: v('due') || null, assignee: assigneeFrom(v('assignee')), description: v('description'),
    people: [...f.querySelectorAll('[name=person]:checked')].map(x => x.value),
    labels: [...f.querySelectorAll('[name=label]:checked')].map(x => Number(x.value)),
    parent: v('parent') ? Number(v('parent')) : null,
  }
}

// Given to an agent where work waits: tell its coordinator now, or not yet.
function askNotify(b, coordinator, id) {
  return new Promise(resolve => {
    const d = dialog(`<h3>${esc(T.askNotifyTitle(coordinator))}</h3><p>${esc(T.askNotifyText(coordinator, id))}</p>
      <div class="actions"><button type="button" class="btn primary" data-cancel data-notyet>${esc(T.notYet)}</button><button type="button" class="btn ok" data-notifynow>${esc(T.notifyNow)}</button></div>`)
    let answered = false
    d.el.onclose = () => { if (!answered) resolve(false) }
    d.el.querySelector('[data-notifynow]').addEventListener('click', () => { answered = true; resolve(true); d.close() })
    d.el.querySelector('[data-notyet]').focus() // (a slip of Enter never sets anyone to work)
  })
}
// Whether this change gives a task to an agent where work waits, untold.
function wouldNotify(b, before, after) {
  const a = after.assignee
  if (a?.kind !== 'session' || !ACTIVE.has(statusOf(b, after.status)?.category)) return null
  const newAssignee = assigneeValue(a) !== assigneeValue(before?.assignee)
  const leftBacklog = before && statusOf(b, before.status)?.category === 'backlog'
  const notTold = !before || newAssignee || before.notify === 'pending'
  return (newAssignee || leftBacklog || (!before && notTold)) && notTold ? teamOf(b.id, a.id) : null
}

async function save(f) {
  const b = boardOf(currentRoute().board)
  if (!b || !detail) return
  const err = f.querySelector('.err')
  err.textContent = ''
  const body = fromForm(f)
  if (!body.title) { err.textContent = `${T.taskTitle}?`; f.elements.title.focus(); return }
  const before = detail.seq === 'new' ? null : detail.task
  const button = f.querySelector('[type=submit]')
  button.disabled = true
  const shown = t => {
    tasksOf.get(b.id)?.set(t.seq, compact(t))
    detail = { seq: t.seq, task: t, dirty: false }
    $('boards').querySelector('.bd-panel').innerHTML = panelHtml(b, t)
    soon(renderBoard)
  }
  try {
    const t = before
      ? await postJson('/api/tasks/update', { id: before.seq, version: before.version, ...body })
      : await postJson('/api/tasks/create', { board: b.id, ...body })
    if (!before) { newStatus = null; newParent = null; location.hash = `#/b/${b.id}/${prefixed(t.seq)}` }
    shown(t)
    // (Asked once the server says who has it: a column's step may have given it on.)
    const coordinator = wouldNotify(b, before, t)
    if (coordinator && await askNotify(b, coordinator, `${prefixed(t.seq)} «${t.title}»`)) shown(await postJson('/api/tasks/update', { id: t.seq, notify: true }))
  } catch (e) {
    button.disabled = false
    if (e.reason === 'changed') {
      detail.dirty = false
      await openTask(before.seq)
      const again = $('boards').querySelector('.bd-form .err')
      if (again) again.textContent = T.changedMeanwhile
      return
    }
    err.textContent = e.message
  }
}

// --- moving a card --------------------------------------------------------------
async function move(b, seq, statusId, rank) {
  const t = tasksOf.get(b.id)?.get(seq)
  if (!t) return
  // (Shown moved at once; the server's answer puts it right.)
  tasksOf.get(b.id).set(seq, { ...t, status: statusId, rank })
  soon(renderBoard)
  try {
    const moved = await postJson('/api/tasks/update', { id: seq, version: t.version, status: statusId, rank })
    tasksOf.get(b.id).set(seq, compact(moved))
    soon(renderBoard)
    const coordinator = statusId !== t.status ? wouldNotify(b, t, moved) : null
    if (coordinator && await askNotify(b, coordinator, `${prefixed(seq)} «${t.title}»`)) tasksOf.get(b.id).set(seq, compact(await postJson('/api/tasks/update', { id: seq, notify: true })))
  } catch (e) {
    tasksOf.get(b.id).set(seq, t)
    soon(renderBoard)
    alertBox(e.reason === 'changed' ? T.changedMeanwhile : e.message)
    if (e.reason === 'changed') void loadTasks(b.id).then(() => soon(renderBoard))
  }
}

// Where in a column a card dropped at that height goes: between its neighbours.
function rankAt(b, col, y, seq) {
  const cards = [...col.querySelectorAll('.bd-card')].filter(c => Number(c.dataset.task) !== seq)
  const map = tasksOf.get(b.id)
  const next = cards.findIndex(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2 })
  const rankOf = c => map.get(Number(c.dataset.task))?.rank ?? 0
  if (!cards.length) return 1
  if (next === 0) return rankOf(cards[0]) - 1
  if (next === -1) return rankOf(cards.at(-1)) + 1
  return (rankOf(cards[next - 1]) + rankOf(cards[next])) / 2
}

let dragging = null
$('boards').addEventListener('dragstart', e => {
  const c = e.target.closest?.('.bd-card[draggable]')
  if (!c) return
  dragging = Number(c.dataset.task)
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', c.querySelector('.bd-id')?.textContent ?? '')
  c.classList.add('dragging')
})
$('boards').addEventListener('dragend', e => { e.target.closest?.('.bd-card')?.classList.remove('dragging'); dragging = null; for (const c of $('boards').querySelectorAll('.bd-col.over')) c.classList.remove('over') })
$('boards').addEventListener('dragover', e => {
  const col = dragging != null && e.target.closest('.bd-col')
  if (!col) return
  e.preventDefault()
  for (const c of $('boards').querySelectorAll('.bd-col.over')) if (c !== col) c.classList.remove('over')
  col.classList.add('over')
})
$('boards').addEventListener('drop', e => {
  const col = dragging != null && e.target.closest('.bd-col')
  if (!col) return
  e.preventDefault()
  col.classList.remove('over')
  const b = boardOf(currentRoute().board)
  if (b) void move(b, dragging, Number(col.dataset.status), rankAt(b, col, e.clientY, dragging))
})

// --- the board's settings, a new board, notifying -------------------------------
function coordinators(extra = []) {
  const names = new Set([...[...sessions.values()].filter(s => s.role === 'coordinator' && !s.archived_at).map(s => s.name), ...extra])
  return [...names].sort((a, b) => COLLATOR.compare(state.squadMeta.get(a)?.title || a, state.squadMeta.get(b)?.title || b))
}
const teamChecks = chosen => {
  const list = coordinators(chosen)
  return list.length
    ? `<fieldset class="bd-teams"><legend>${esc(T.boardTeams)}</legend>${list.map(c => `<label class="check"><input type="checkbox" name="team" value="${esc(c)}"${chosen.includes(c) ? ' checked' : ''}> <span>${esc(state.squadMeta.get(c)?.title || c)}${state.squadMeta.get(c)?.title ? ` <span class="dim-note">${esc(c)}</span>` : ''}</span></label>`).join('')}<span class="hint">${esc(T.boardTeamsHint)}</span></fieldset>`
    : `<p class="dim-note">${esc(T.noTeamsForBoard)}</p>`
}

function newBoardDialog() {
  const d = dialog(`<h3>${esc(T.newBoard)}</h3><form data-bnew>
      <label class="field"><span>${esc(T.boardName)}</span><input type="text" name="name" maxlength="60" required></label>
      <label class="field"><span>${esc(T.boardDescription)}</span><textarea name="description" rows="2" maxlength="1000"></textarea></label>
      ${teamChecks([])}
      <div class="err" role="alert"></div>
      <div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="submit" class="btn primary">${esc(T.createBoard)}</button></div></form>`)
  const f = d.el.querySelector('form')
  f.elements.name.focus()
  f.addEventListener('submit', async e => {
    e.preventDefault()
    try {
      const b = await postJson('/api/boards/create', {
        name: f.elements.name.value, description: f.elements.description.value,
        teams: [...f.querySelectorAll('[name=team]:checked')].map(x => x.value),
        statuses: T.defaultStatuses.map(([name, category]) => ({ name, category })),
        types: T.defaultTypes.map(([name, color]) => ({ name, color })),
      })
      state.boards = [...state.boards.filter(x => x.id !== b.id), b]
      peopleAt = 0
      d.close()
      location.hash = `#/b/${b.id}`
    } catch (err) { f.querySelector('.err').textContent = err.message }
  })
}

// Statuses, labels and types, edited as lists: ids kept, order as shown.
function listEditor(key, items, withCategory) {
  const rows = items.map((x, i) => `<div class="bd-row" data-i="${i}">
      <input type="text" class="input" data-k="name" value="${esc(x.name)}" maxlength="60" aria-label="${esc(T.boardName)}">
      ${withCategory
        ? `<select class="input" data-k="category" aria-label="${esc(T.bCategory)}">${CATEGORIES.map(c => `<option value="${c}"${c === x.category ? ' selected' : ''}>${esc(T.categories[c])}</option>`).join('')}</select>`
        : `<select class="input" data-k="color" aria-label="${esc(T.bColor)}">${COLORS.map(c => `<option value="${c}"${c === x.color ? ' selected' : ''}>${esc(T.colors[c])}</option>`).join('')}</select>`}
      <button type="button" class="icon-btn" data-up title="${esc(T.bMoveUp)}" aria-label="${esc(T.bMoveUp)}"${i === 0 ? ' disabled' : ''}>${icon('chevron', 'up')}</button>
      <button type="button" class="icon-btn" data-rm title="${esc(T.bRemove)}" aria-label="${esc(T.bRemove)}">${icon('close')}</button>
    </div>`).join('')
  return `<div class="bd-rows">${rows}</div><button type="button" class="btn quiet" data-add>${icon('plus')} ${esc(T.bAdd)}</button>`
}

function settingsDialog(b) {
  const lists = {
    statuses: b.statuses.map(({ id, name, category }) => ({ id, name, category })),
    labels: b.labels.map(({ id, name, color }) => ({ id, name, color })),
    types: b.types.map(({ id, name, color }) => ({ id, name, color })),
  }
  const d = dialog(`<h3>${esc(T.boardSettings)}</h3><form data-bset>
      <label class="field"><span>${esc(T.boardName)}</span><input type="text" name="name" maxlength="60" required value="${esc(b.name)}"></label>
      <label class="field"><span>${esc(T.boardDescription)}</span><textarea name="description" rows="2" maxlength="1000">${esc(b.description)}</textarea></label>
      ${teamChecks(b.teams)}
      <section class="bd-edit" data-list="statuses"><h4>${esc(T.bStatuses)}</h4><p class="dim-note">${esc(T.bStatusesHint)}</p><div></div></section>
      <section class="bd-edit" data-list="labels"><h4>${esc(T.bLabels)}</h4><div></div></section>
      <section class="bd-edit" data-list="types"><h4>${esc(T.bTypes)}</h4><div></div></section>
      <section class="bd-edit bd-ghsec"><h4>${esc(T.ghSection)}</h4>${ghSummary(b)}</section>
      <label class="field bd-prefix"><span>${esc(T.taskPrefix)}</span><input type="text" name="prefix" maxlength="6" value="${esc(state.boardPrefix)}" autocapitalize="characters"></label>
      <div class="err" role="alert"></div>
      <div class="actions bd-set-actions">
        <button type="button" class="btn" data-barchive>${esc(b.archived_at ? T.unarchiveBoard : T.archiveBoard)}</button>
        ${b.archived_at ? `<button type="button" class="btn danger" data-bdel>${esc(T.deleteBoard)}</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="submit" class="btn primary">${esc(T.save)}</button></div></form>`, { wide: true })
  const f = d.el.querySelector('form')
  const draw = key => { d.el.querySelector(`[data-list=${key}] > div`).innerHTML = listEditor(key, lists[key], key === 'statuses') }
  // (What is typed in a row is kept before the list is drawn again.)
  const read = key => {
    for (const row of d.el.querySelectorAll(`[data-list=${key}] .bd-row`)) {
      const x = lists[key][Number(row.dataset.i)]
      for (const el of row.querySelectorAll('[data-k]')) x[el.dataset.k] = el.value
    }
  }
  for (const key of Object.keys(lists)) draw(key)
  d.el.addEventListener('click', e => {
    const sec = e.target.closest('[data-list]')
    if (!sec) return
    const key = sec.dataset.list
    const i = Number(e.target.closest('.bd-row')?.dataset.i)
    if (e.target.closest('[data-add]')) { read(key); lists[key].push(key === 'statuses' ? { id: null, name: '', category: 'unstarted' } : { id: null, name: '', color: 'gray' }); draw(key); sec.querySelector('.bd-row:last-child input')?.focus(); return }
    if (e.target.closest('[data-up]') && i > 0) { read(key); [lists[key][i - 1], lists[key][i]] = [lists[key][i], lists[key][i - 1]]; draw(key); return }
    if (e.target.closest('[data-rm]')) { read(key); lists[key].splice(i, 1); draw(key) }
  })
  f.addEventListener('submit', async e => {
    e.preventDefault()
    for (const key of Object.keys(lists)) read(key)
    const clean = list => list.filter(x => x.name.trim()).map(x => ({ ...x, name: x.name.trim() }))
    try {
      if (f.elements.prefix.value.trim().toUpperCase() !== state.boardPrefix) {
        state.boardPrefix = (await postJson('/api/boards/prefix', { prefix: f.elements.prefix.value })).prefix
      }
      await postJson('/api/boards/update', {
        id: b.id, name: f.elements.name.value, description: f.elements.description.value,
        teams: [...f.querySelectorAll('[name=team]:checked')].map(x => x.value),
        statuses: clean(lists.statuses), labels: clean(lists.labels), types: clean(lists.types),
      })
      peopleAt = 0
      void loadPeople(true).then(() => soon(renderBoard))
      d.close()
    } catch (err) { f.querySelector('.err').textContent = err.message }
  })
  d.el.querySelector('[data-ghconnect]')?.addEventListener('click', () => { d.close(); githubDialog(b) })
  d.el.querySelector('.bd-ghsec').addEventListener('change', async e => {
    const box = e.target.closest('[data-ghmerge]')
    if (!box) return
    box.disabled = true
    try { const nb = await postJson('/api/boards/github-merge', { board: b.id, on: box.checked }); state.boards = state.boards.map(x => (x.id === nb.id ? nb : x)) } catch (err) { box.checked = !box.checked; f.querySelector('.err').textContent = err.message }
    box.disabled = false
  })
  d.el.querySelector('[data-ghsync]')?.addEventListener('click', async e => {
    e.target.disabled = true
    try { const nb = await postJson('/api/boards/github-sync', { board: b.id }); state.boards = state.boards.map(x => (x.id === nb.id ? nb : x)); d.el.querySelector('.bd-ghsec').innerHTML = `<h4>${esc(T.ghSection)}</h4>${ghSummary(nb)}`; void loadTasks(b.id).then(() => soon(renderBoard)) } catch (err) { f.querySelector('.err').textContent = err.message; e.target.disabled = false }
  })
  d.el.querySelector('[data-ghoff]')?.addEventListener('click', () => {
    d.close()
    confirmDialog({ title: T.ghDisconnectTitle, text: T.ghDisconnectText(esc(b.github.title ?? '')), confirm: T.ghDisconnect, danger: true, run: async () => { const nb = await postJson('/api/boards/github-off', { board: b.id }); state.boards = state.boards.map(x => (x.id === nb.id ? nb : x)); soon(renderBoard); soon(renderTop) } })
  })
  d.el.querySelector('[data-barchive]').addEventListener('click', async () => {
    try { await postJson('/api/boards/update', { id: b.id, archived: !b.archived_at }); d.close() } catch (err) { f.querySelector('.err').textContent = err.message }
  })
  d.el.querySelector('[data-bdel]')?.addEventListener('click', () => {
    d.close()
    confirmDialog({ title: T.deleteBoardTitle(b.name), text: esc(T.deleteBoardText(b.name)), confirm: T.deleteBoard, danger: true, run: async () => { await postJson('/api/boards/delete', { id: b.id }); location.hash = '#/boards' } })
  })
}

// The board's GitHub connection, in the settings: what it follows and how it went.
function ghSummary(b) {
  const g = b.github
  if (!g) return `<p class="dim-note">${esc(T.ghNone)}</p><button type="button" class="btn" data-ghconnect>${esc(T.ghConnect)}</button>`
  return `<p class="bd-ghstate"><a href="${esc(g.url ?? '#')}" target="_blank" rel="noopener noreferrer">${esc(T.ghStatus(g.title ?? '', g.repo))}</a></p>
    <p class="dim-note">${esc([g.synced_at ? T.ghSynced(ago(g.synced_at)) : T.ghSyncing, T.ghLinked(g.linked)].join(' · '))}</p>
    ${g.error ? `<p class="err" role="alert">${esc(g.error)}</p>` : ''}
    <label class="check"><input type="checkbox" data-ghmerge${g.merge_moves ? ' checked' : ''}> ${esc(T.ghMergeMoves)}</label>
    <p class="dim-note">${esc(T.ghPrsHint)}</p>
    <div class="bd-ghacts"><button type="button" class="btn" data-ghsync>${esc(T.ghSyncNow)}</button><button type="button" class="btn" data-ghconnect>${esc(T.ghChange)}</button><button type="button" class="btn danger" data-ghoff>${esc(T.ghDisconnect)}</button></div>`
}

function githubDialog(b) {
  const g = b.github
  const d = dialog(`<h3>${esc(T.ghTitle)}</h3><form data-bgh autocomplete="off">
      <label class="field"><span>${esc(T.ghUrl)}</span><input type="url" name="url" required placeholder="${esc(T.ghUrlPh)}" value="${esc(g ? `https://github.com/${g.owner_kind === 'org' ? 'orgs' : 'users'}/${g.owner}/projects/${g.number}` : '')}"></label>
      <label class="field"><span>${esc(T.ghRepo)}</span><input type="text" name="repo" required placeholder="${esc(T.ghRepoPh)}" value="${esc(g?.repo ?? '')}" autocapitalize="off" spellcheck="false"><span class="hint">${esc(T.ghRepoHint)}</span></label>
      <label class="field"><span>${esc(T.ghToken)}</span><input type="password" name="token" ${g ? `placeholder="${esc(T.ghTokenKeep)}"` : 'required'} autocomplete="new-password" spellcheck="false"><span class="hint">${esc(T.ghTokenHint)}</span></label>
      <p class="dim-note">${esc(T.ghColumnsNote)}</p>
      <div class="err" role="alert"></div>
      <div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="submit" class="btn primary">${esc(T.ghConnectBtn)}</button></div></form>`, { wide: true })
  const f = d.el.querySelector('form')
  f.elements.url.focus()
  f.addEventListener('submit', async e => {
    e.preventDefault()
    const button = f.querySelector('[type=submit]')
    button.disabled = true
    try {
      await postJson('/api/boards/github', { board: b.id, url: f.elements.url.value, repo: f.elements.repo.value, token: f.elements.token.value })
      f.elements.token.value = ''
      d.close()
      void loadPeople(true).then(() => { soon(renderBoard); soon(renderTop) })
    } catch (err) { f.querySelector('.err').textContent = err.message; button.disabled = false }
  })
}

// One column as a step of the flow: who handles it, what to do, where next.
function flowDialog(b, s) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(label)}</option>`
  const others = b.statuses.filter(x => x.id !== s.id)
  const d = dialog(`<h3>${esc(T.stepTitle(s.name))}</h3><form data-bflow>
      <p class="dim-note">${esc(T.stepHint)}</p>
      <label class="field"><span>${esc(T.stepHandler)}</span><select name="handler">${assigneeOptions(b, s.handler ? assigneeValue(s.handler) : '')}</select><span class="hint">${esc(T.stepHandlerHint)}</span></label>
      <label class="field"><span>${esc(T.stepInstructions)}</span><textarea name="instructions" rows="4" maxlength="4000" placeholder="${esc(T.stepInstructionsPh)}">${esc(s.instructions ?? '')}</textarea></label>
      <div class="row2">
        <label class="field"><span>${esc(T.stepNext)}</span><select name="next">${opt('', T.stepNoNext, s.next ?? '')}${others.map(x => opt(x.id, x.name, s.next)).join('')}</select></label>
        <label class="field"><span>${esc(T.stepBack)}</span><select name="back">${opt('', T.stepNoBack, s.back ?? '')}${others.map(x => opt(x.id, x.name, s.back)).join('')}</select></label>
      </div>
      <div class="err" role="alert"></div>
      <div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="submit" class="btn primary">${esc(T.save)}</button></div></form>`, { wide: true })
  const f = d.el.querySelector('form')
  f.elements.handler.focus()
  f.addEventListener('submit', async e => {
    e.preventDefault()
    const num = v => (v ? Number(v) : null)
    try {
      const nb = await postJson('/api/boards/flow', { board: b.id, status: s.id, handler: assigneeFrom(f.elements.handler.value), instructions: f.elements.instructions.value, next: num(f.elements.next.value), back: num(f.elements.back.value) })
      state.boards = state.boards.map(x => (x.id === nb.id ? nb : x))
      soon(renderBoard)
      d.close()
    } catch (err) { f.querySelector('.err').textContent = err.message }
  })
}

function notifyDialog(b) {
  const byTeam = new Map()
  for (const t of [...(tasksOf.get(b.id)?.values() ?? [])].sort(byRank)) {
    if (t.notify !== 'pending' || t.assignee?.kind !== 'session' || !ACTIVE.has(categoryOf(b, t))) continue
    const team = teamOf(b.id, t.assignee.id) ?? '?'
    if (!byTeam.has(team)) byTeam.set(team, [])
    byTeam.get(team).push(t)
  }
  const list = [...byTeam].map(([team, ts]) => `<li><b>${esc(state.squadMeta.get(team)?.title || team)}</b><ul>${ts.map(t => `<li><span class="bd-id">${esc(prefixed(t.seq))}</span> ${esc(t.title)} → ${esc(t.assignee.id)}</li>`).join('')}</ul></li>`).join('')
  confirmDialog({
    title: T.notifyTitle, text: `${esc(T.notifyText)}</p><ul class="bd-notify-list">${list}</ul><p>`, confirm: T.notifyConfirm, settles: true,
    run: async () => {
      const r = await postJson('/api/tasks/notify', { board: b.id })
      if (r.failed?.length) alertBox(T.notifyFailed(r.failed.map(x => x.team).join(', ')))
    },
  })
}

// --- clicks and typing ------------------------------------------------------------
$('boards').addEventListener('click', e => {
  if (e.target.closest('[data-newboard]')) return newBoardDialog()
  const step = e.target.closest('[data-colflow]')
  if (step) { const b = boardOf(currentRoute().board); const s = statusOf(b, Number(step.dataset.colflow)); if (s) void loadPeople().then(() => flowDialog(b, s)); return }
  const add = e.target.closest('[data-newtask]')
  if (add) { newStatus = Number(add.dataset.newtask); newParent = null; detail = null; const id = currentRoute().board; if (currentRoute().task === 'new') drawNew(boardOf(id)); else location.hash = `#/b/${id}/new`; return }
  if (e.target.closest('[data-bdelete]') && detail?.task?.seq) {
    const t = detail.task
    const b = boardOf(currentRoute().board)
    const subs = t.children?.length ?? 0
    return confirmDialog({
      title: T.deleteTaskTitle(prefixed(t.seq)), text: esc(T.deleteTaskText(prefixed(t.seq))), confirm: T.deleteTask, danger: true,
      option: subs ? T.deleteWithSubtasks(subs) : null, optionChecked: false,
      run: async withSubs => { await postJson('/api/tasks/delete', { id: t.seq, subtasks: !!withSubs }); tasksOf.get(b.id)?.delete(t.seq); detail = null; location.hash = `#/b/${b.id}` },
    })
  }
  if (e.target.closest('[data-addsub]') && detail?.task?.seq) {
    const parent = detail.task
    newStatus = null; newParent = parent.seq; detail = null
    location.hash = `#/b/${currentRoute().board}/new`
    return
  }
  // A card, a row or a subtask: open it (its title is the link; the rest of it too).
  const row = e.target.closest('.bd-card, .bd-table tr[data-task], .bd-subs li[data-task]')
  if (row && !e.target.closest('a, button, input, select, textarea')) {
    location.hash = `#/b/${currentRoute().board}/${prefixed(Number(row.dataset.task))}`
  }
})
$('boards').addEventListener('input', e => {
  const f = e.target.closest('[data-bf]')
  if (f) {
    const b = currentRoute().board
    const flt = filterOf(Number(b))
    flt[f.dataset.bf] = f.type === 'checkbox' ? f.checked : f.value
    return soon(renderBoard)
  }
  if (e.target.closest('[data-bform]') && detail) detail.dirty = true
})
$('boards').addEventListener('change', e => {
  // (A column someone handles, chosen in the form: shown as who will have it.)
  if (e.target.matches('[data-bform] [name=status]') && detail) {
    const b = boardOf(currentRoute().board)
    const s = statusOf(b, Number(e.target.value))
    const who = e.target.form.elements.assignee
    const label = e.target.closest('label')
    label.querySelector('.bd-step')?.remove()
    label.insertAdjacentHTML('beforeend', stepLine(b, s ?? {}))
    if (s?.handler && who && who.value === assigneeValue(detail.task?.assignee)) who.value = assigneeValue(s.handler)
  }
  const f = e.target.closest('[data-bf]')
  if (f) { filterOf(Number(currentRoute().board))[f.dataset.bf] = f.type === 'checkbox' ? f.checked : f.value; soon(renderBoard) }
})
$('boards').addEventListener('submit', async e => {
  const f = e.target
  if (f.matches('[data-bform]')) { e.preventDefault(); return save(f) }
  if (f.matches('[data-bcomment]')) {
    e.preventDefault()
    const text = f.elements.text.value.trim()
    if (!text || !detail?.task?.seq) return
    const button = f.querySelector('[type=submit]')
    button.disabled = true
    try {
      await postJson('/api/tasks/comment', { id: detail.task.seq, text, notify: !!f.elements.notify?.checked })
      f.elements.text.value = ''
      if (f.elements.notify) f.elements.notify.checked = false
      await openTask(detail.task.seq, { quiet: true })
    } catch (err) { f.querySelector('.err').textContent = err.message } finally { button.disabled = false }
  }
})
// Ctrl+Enter sends a comment or saves the task.
$('boards').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    const f = e.target.closest('[data-bform], [data-bcomment]')
    if (f) { e.preventDefault(); f.requestSubmit() }
  }
})

// The header's buttons (see topbar.js).
export function boardsTopClick(e) {
  if (e.target.closest('[data-newboard]')) { newBoardDialog(); return true }
  const b = boardOf(currentRoute().board)
  const m = e.target.closest('[data-bmode]')
  if (m) { store.set(companyPref('squadraBoardMode'), m.dataset.bmode); soon(renderBoard); soon(renderTop); return true }
  if (!b) return false
  if (e.target.closest('[data-bnotify]')) { void loadTasks(b.id).then(() => notifyDialog(b)); return true }
  if (e.target.closest('[data-bsettings]')) { void loadPeople().then(() => settingsDialog(b)); return true }
  if (e.target.closest('[data-btrash]')) { void trashDialog(b); return true }
  if (e.target.closest('[data-gherr]') && b.github?.error) { alertBox(T.ghStFailedText(b.github.error, b.github.pending), T.ghStFailedTitle); return true }
  const now = e.target.closest('[data-ghnow]')
  if (now) {
    now.disabled = true
    // (The board, and the task open beside it with its comments.)
    const seq = typeof detail?.seq === 'number' ? detail.seq : null
    const work = [postJson('/api/boards/github-sync', { board: b.id })]
    if (seq) work.push(postJson('/api/boards/github-watch', { board: b.id, task: seq, taskOpened: true }))
    Promise.all(work).catch(err => alertBox(err.message)).finally(() => { now.disabled = false; soon(renderTop) })
    return true
  }
  return false
}

// --- the trash: deleted tasks, to be restored ----------------------------------------
function trashRows(list) {
  if (!list.length) return `<p class="dim-note">${esc(T.bTrashEmpty)}</p>`
  return `<ul class="bd-trash">${list.map(t => `<li>
    <div class="grow"><div class="bd-trash-t"><span class="bd-id">${esc(t.id)}</span> ${esc(t.title)}</div>
      <div class="dim-note">${esc([T.bTrashBy(whoName(t.deleted_by), ago(t.deleted_at)), t.parent ? T.bTrashSubOf(t.parent.id, t.parent.trashed) : '', t.subtasks ? T.bTrashWith(t.subtasks) : ''].filter(Boolean).join(' · '))}</div></div>
    <button type="button" class="btn ok" data-restore="${t.seq}">${esc(T.restoreTask)}</button></li>`).join('')}</ul>`
}
async function trashDialog(b) {
  let list
  try { list = await api(`/api/boards/trash?board=${b.id}`) } catch (err) { alertBox(err.message); return }
  const d = dialog(`<h3>${esc(T.bTrashTitle(b.name))}</h3><div class="bd-trash-body">${trashRows(list)}</div><div class="err"></div><div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.close)}</button></div>`, { wide: true })
  const redraw = async () => { list = await api(`/api/boards/trash?board=${b.id}`); d.el.querySelector('.bd-trash-body').innerHTML = trashRows(list) }
  const restore = async (t, withSubs) => {
    const r = await postJson('/api/tasks/restore', { id: t.seq, subtasks: !!withSubs })
    if (r.without_parent && !t.parent?.trashed) alertBox(T.restoredNoParent(t.id, r.without_parent))
    await redraw()
  }
  d.el.addEventListener('click', e => {
    const btn = e.target.closest('[data-restore]')
    if (!btn) return
    const t = list.find(x => x.seq === Number(btn.dataset.restore))
    if (!t) return
    const orphan = t.parent?.trashed
    // (Nothing to ask: back at once.)
    if (!orphan && !t.subtasks) { btn.disabled = true; restore(t, false).catch(err => { d.el.querySelector('.err').textContent = err.message; btn.disabled = false }); return }
    confirmDialog({
      title: T.restoreTitle(t.id), text: esc(orphan ? T.restoreNoParent(t.id, t.parent.id) : T.restoreText(t.id)), confirm: T.restoreTask, settles: true,
      option: t.subtasks ? T.restoreWithSubtasks(t.subtasks) : null, run: withSubs => restore(t, withSubs),
    })
  })
}
// (The view switch sits in the header's tabs.)
$('topTabs').addEventListener('click', e => { if (e.target.closest('[data-bmode]')) boardsTopClick(e) })
