import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, can, sessions, hosts } from './state.js'
import { esc, now, ago } from './format.js'
import { sortedSessions, status, agentMark } from './content.js'
import { setHtml } from './nav.js'
import { postJson } from './machines.js'
import { alertBox } from './mosaic.js'
import { currentRoute } from './router.js'
import { replaceHash, closeTo } from './back.js'
import { api } from './api.js'
import { icon } from './icons.js'

// The inbox: everything that waits on you, in one list across the page; the
// one picked opens on the right, and closes again (✕ or Esc) to the list.
// Two tabs. Pending: decisions coordinators left (ask_user), permission
// prompts waiting in a session, names to approve; then what they wanted you
// to know (tell_user). It is all there, live: what arrives shows on its own.
// Done: what was answered, put away or closed, newest first, a page at a time
// from the server, by day, searched by its words or one team's.
// It says what they wrote and nothing more: what it is about, a ticket or
// anything else, is theirs.

const when = t => new Date(t).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
// (A link only if it really is one: a ref is whatever the session wrote.)
const refHtml = ref => {
  if (!ref) return ''
  let url = null
  try { url = new URL(ref) } catch {}
  return url && (url.protocol === 'https:' || url.protocol === 'http:')
    ? `<a class="ibx-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>`
    : `<code>${esc(ref)}</code>`
}
const teamOf = name => {
  const s = sessions.get(name)
  const c = s?.role === 'coordinator' ? name : s?.coordinator
  return c ? state.squadMeta.get(c)?.title || c : ''
}
const who = name => {
  const s = sessions.get(name)
  const role = s?.role === 'coordinator' ? 'coord' : s?.role === 'solo' ? 'solo' : 'worker'
  return `<span class="ibx-who"><span class="role ${role}" aria-hidden="true"></span>${agentMark(name)}<span class="sr-only">${esc(T.roleName[s?.role] ?? '')} </span>${esc(name)}</span>`
}

// The version of each question the user has had in front of them: if its
// coordinator changes it after that, an answer is refused until they read it
// again (they must never decide on what it no longer thinks).
const seen = new Map()
// What they were typing, kept across redraws.
const drafts = new Map()
// The option picked for each question, until it is sent (a pick alone sends nothing).
const picks = new Map()

// Why an answer can't be typed in the coordinator's terminal from here (null: it can).
export function cantAnswer(i) {
  const h = hosts.get(sessions.get(i.session)?.host_id)
  if (!h?.online) return T.inboxNoMachine
  if (!h.info?.answers) return T.inboxOldMachine
  if (h.info.allow_input === false) return T.inboxTypingOff
  return null
}

// What a session waiting for permission wants to run.
const permWhat = s => { const a = s.activity ?? {}; return a.tool?.name ? [a.tool.name, a.tool.summary].filter(Boolean).join(' · ') : a.waiting ?? '' }

// Which tab, and where its list and its entries are.
const tabOf = r => (r.tab === 'done' ? 'done' : 'pending')
const listHash = (r = currentRoute()) => (tabOf(r) === 'done' ? '#/inbox/done' : '#/inbox')
const itemHash = (tab, key) => (tab === 'done' ? `#/inbox/done/${key}` : `#/inbox/${key}`)

// What waits, in its groups. Each entry: { key, kind, ... }.
function entries() {
  const open = state.inbox.filter(i => !i.resolved_at)
  const asks = open.filter(i => i.kind === 'ask').map(i => ({ key: `i${i.id}`, kind: 'ask', i, at: i.updated_at ?? i.created_at }))
  // Permission prompts waiting in a session: answered in its terminal.
  const perms = sortedSessions().filter(s => status(s).waiting).map(s => ({ key: `p${s.name}`, kind: 'perm', s, at: (s.activity?.tool?.since ?? s.activity?.since ?? now()) }))
  const approvals = can('manager') ? sortedSessions().filter(s => s.approval_pending).map(s => ({ key: `a${s.name}`, kind: 'approve', s, at: (s.created_at ?? 0) * 1000 })) : []
  const tells = open.filter(i => i.kind === 'tell').map(i => ({ key: `i${i.id}`, kind: 'tell', i, at: i.created_at }))
  const newest = (a, b) => b.at - a.at
  return [
    { id: 'decide', label: T.ibxDecide, list: [...perms.sort(newest), ...asks.sort(newest), ...approvals] },
    { id: 'know', label: T.inboxTell, list: tells.sort(newest) },
  ]
}

// What is done: the pages asked for, and what the live list brings on top of
// them (closed meanwhile), without what has since been opened again.
const done = { q: '', team: '', items: [], next: null, loaded: false, loading: false, failed: false, turn: 0 }
const PAGE = 50
async function loadDone(more = false) {
  if (more && (done.loading || !done.next)) return
  const turn = ++done.turn
  done.loading = true; done.failed = false
  const qs = new URLSearchParams({ limit: String(PAGE) })
  if (done.team) qs.set('team', done.team)
  if (done.q.trim()) qs.set('q', done.q.trim())
  if (more) qs.set('before', done.next)
  refreshInbox()
  try {
    const r = await api(`/api/inbox/done?${qs}`)
    if (turn !== done.turn) return
    done.items = more ? [...done.items, ...r.items] : r.items
    done.next = r.next_before
    done.loaded = true
  } catch {
    if (turn === done.turn) done.failed = true
  } finally {
    if (turn === done.turn) { done.loading = false; refreshInbox() }
  }
}
const newer = (a, b) => a.resolved_at > b.resolved_at || (a.resolved_at === b.resolved_at && a.id > b.id)
function doneEntries() {
  const open = new Set(state.inbox.filter(i => !i.resolved_at).map(i => i.id))
  const words = done.q.trim().toLowerCase()
  // (Live ones only above where the pages end: below, the next page has them in order.)
  const bottom = done.next ? done.items.at(-1) : null
  const live = state.inbox.filter(i => i.resolved_at && (!done.team || i.session === done.team)
    && (!words || [i.text, i.answer, i.closed_reason].some(t => t?.toLowerCase().includes(words)))
    && (!bottom || newer(i, bottom)))
  const byId = new Map()
  for (const i of [...done.items, ...live]) byId.set(i.id, i)
  return [...byId.values()].filter(i => !open.has(i.id)).sort((a, b) => (newer(a, b) ? -1 : 1))
    .map(i => ({ key: `i${i.id}`, kind: 'done', i, at: i.resolved_at }))
}

// "Today", "Yesterday", then the date: what is done, by the day it was.
function dayOf(t) {
  const d = new Date(t), today = new Date()
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(today) - start(d)) / 86400_000)
  if (days === 0) return T.dayToday
  if (days === 1) return T.dayYesterday
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

// What arrived while the list was in view: marked a moment, never moved to.
const arrived = new Map() // key -> when it first showed
let listedKeys = null
const FRESH_MS = 3000

function row(e, on, tab = 'pending') {
  const href = itemHash(tab, e.key)
  const fresh = Date.now() - (arrived.get(e.key) ?? 0) < FRESH_MS
  let dot, title, meta
  if (e.kind === 'perm') {
    dot = 'warn'; title = T.ibxPermTitle(e.s.name, permWhat(e.s))
    meta = [who(e.s.name), esc(T.ibxPermission), esc(teamOf(e.s.name)), esc(ago(e.at))]
  } else if (e.kind === 'approve') {
    dot = 'warn'; title = T.ibxApproveTitle(e.s.name)
    meta = [who(e.s.name), esc(T.approveNote)]
  } else {
    const i = e.i
    dot = e.kind === 'ask' ? 'warn' : e.kind === 'tell' ? 'info' : 'ok'
    title = i.text.replace(/\s+/g, ' ')
    meta = [who(i.session), esc(teamOf(i.session)), i.updated_at && e.kind === 'ask' ? `<span class="ibx-upd">${esc(T.inboxUpdated(ago(i.updated_at)))}</span>` : '', esc(ago(e.at))]
  }
  return `<li><a href="${href}" class="ibx-item${on ? ' on' : ''}${e.kind === 'done' ? ' done' : ''}${fresh ? ' new' : ''}"${on ? ' aria-current="true"' : ''} data-key="${esc(e.key)}">`
    + `<span class="dot ${dot}" aria-hidden="true"></span><span class="ibx-item-b"><span class="ibx-item-t">${esc(title)}</span><span class="ibx-item-m">${meta.filter(Boolean).join('<span aria-hidden="true">·</span>')}</span></span></a></li>`
}

// Nothing open yet on this company: the three steps to a first team.
function firstSteps() {
  const machine = hosts.size > 0
  const team = sortedSessions().some(s => s.role === 'coordinator')
  const step = (n, done, now, title, hint, action) => `<li class="fs-step${done ? ' done' : now ? ' now' : ''}"><span class="fs-mark" aria-hidden="true">${done ? '✓' : n}</span><div><b>${esc(title)}</b>${now && hint ? `<p>${esc(hint)}</p>` : ''}${now && action ? action : ''}</div>${done ? `<span class="sr-only">${esc(T.fsDone)}</span>` : ''}</li>`
  return `<div class="fs"><h2 class="fs-title">${esc(T.fsTitle)}</h2><p class="fs-sub">${esc(T.fsSub)}</p>
    <ol class="fs-steps card">
      ${step(1, true, false, T.fsAccount)}
      ${step(2, machine, !machine, T.fsMachine, T.fsMachineHint, can('manager') ? `<button type="button" class="btn primary" data-addmachine>${esc(T.actAddMachine)}</button>` : '')}
      ${step(3, team, machine && !team, T.fsTeam, T.fsTeamHint, can('operator') ? `<button type="button" class="btn primary" data-newteam>${esc(T.newTeam)}</button>` : '')}
    </ol>
    <p class="fs-hint">${T.fsLogin}</p></div>`
}

const emptyState = () => `<div class="empty">${icon('inbox', 'empty-ic')}<b>${esc(T.inboxEmpty)}</b><span>${esc(T.ibxEmptyHint)}</span></div>`

// Who left it, as a mail client shows a sender: their mark, name and team,
// what it is and when; the way to their session on the right.
function head(name, kind, at, link = true) {
  const s = sessions.get(name)
  const role = s?.role === 'coordinator' ? 'coord' : s?.role === 'solo' ? 'solo' : 'worker'
  return `<header class="ibx-head"><span class="ibx-avatar ${role}" aria-hidden="true"><span class="role ${role}"></span></span>
    <div class="ibx-from"><b>${esc(name)} ${agentMark(name)}</b><span>${[esc(teamOf(name)), esc(kind), at ? `<time title="${esc(when(at))}">${esc(ago(at))}</time>` : ''].filter(Boolean).join('<span aria-hidden="true"> · </span>')}</span></div>
    ${link ? `<a class="btn" href="#/s/${encodeURIComponent(name)}" aria-label="${esc(T.ibxOpenSession)}"><span class="ibx-l">${esc(T.ibxOpenSession)}</span><span class="ibx-s" aria-hidden="true">${esc(T.ibxSessionShort)}</span></a>` : ''}
    <a class="icon-btn ibx-close" href="${listHash()}" aria-label="${esc(T.close)}" title="${esc(T.close)} (Esc)">${icon('close')}</a></header>`
}

function detail(e) {
  if (!e && !sortedSessions().length) return firstSteps()
  if (!e) return emptyState()
  if (e.kind === 'perm') {
    const s = e.s
    return `<article class="ibx-card">${head(s.name, T.ibxPermission, e.at, false)}
      <div class="ibx-body"><h2 class="ibx-q">${esc(T.ibxPermTitle(s.name, ''))}</h2><pre class="ibx-perm">${esc(permWhat(s) || status(s).text)}</pre>
      <p class="ibx-note">${esc(T.ibxPermHint)}</p>
      <div class="ibx-actions"><a class="btn primary ok" href="#/s/${encodeURIComponent(s.name)}">${esc(T.ibxOpenSession)}</a></div></div></article>`
  }
  if (e.kind === 'approve') {
    const s = e.s
    return `<article class="ibx-card">${head(s.name, T.approveNote, e.at, false)}
      <div class="ibx-body"><h2 class="ibx-q">${esc(T.ibxApproveTitle(s.name))}</h2><p class="ibx-note">${esc(T.ibxApproveHint)}</p>
      <div class="ibx-actions"><a class="btn primary ok" href="#/s/${encodeURIComponent(s.name)}">${esc(T.ibxOpenSession)}</a></div></div></article>`
  }
  const i = e.i
  const open = !i.resolved_at
  const ask = i.kind === 'ask'
  if (open && !seen.has(i.id)) seen.set(i.id, i.version)
  const changed = open && seen.get(i.id) !== i.version
  const why = open && ask && can('operator') ? cantAnswer(i) : null
  const answering = open && ask && can('operator') && !why
  // Something it was told can be replied to as well ("update the branches with
  // main"), when it can be typed in its coordinator's terminal; Done still closes it.
  const replying = open && !ask && can('operator') && !cantAnswer(i)
  // The option it recommends: its words, perhaps followed by why ("Keep it: nothing is lost").
  const rec = String(i.recommended ?? '').trim()
  const recIndex = rec ? i.options.findIndex(o => { const t = o.trim().toLowerCase(), r = rec.toLowerCase(); return r === t || (r.startsWith(t) && /^[\s:.,;—–-]/.test(r.slice(t.length))) }) : -1
  const recRest = recIndex >= 0 ? rec.slice(i.options[recIndex].trim().length).replace(/^[\s:.,;—–-]+/, '') : ''
  const recWhy = recRest.charAt(0).toUpperCase() + recRest.slice(1)
  const opts = i.options.map((o, n) => answering
    ? `<button type="button" class="ibx-opt${n === recIndex ? ' rec' : ''}" data-option="${n}" aria-pressed="${picks.get(i.id) === n}"><kbd>${n + 1}</kbd><span>${esc(o)}</span>${n === recIndex ? `<span class="tag">${esc(T.inboxRecommended)}</span>` : ''}</button>`
    : `<li>${esc(o)}${n === recIndex ? ` <span class="tag">${esc(T.inboxRecommended)}</span>` : ''}</li>`).join('')
  const kind = !open ? T.ibxClosedAt : ask ? T.ibxKindAsk : T.inboxTell
  return `<article class="ibx-card${open ? '' : ' closed'}">${head(i.session, kind, i.updated_at ?? i.created_at)}
    <div class="ibx-body">
    ${changed ? `<div class="ibx-changed" data-changed role="status">${esc(T.inboxChangedSince)}</div>` : ''}
    <h2 class="ibx-q${ask ? '' : ' tell'}">${esc(i.text)}</h2>
    ${i.options.length ? (answering ? `<div class="ibx-opts" role="group" aria-label="${esc(T.inboxOptions)}">${opts}</div>` : `<ul class="ibx-optlist">${opts}</ul>`) : ''}
    ${rec && (recIndex < 0 || recWhy) ? `<p class="ibx-rec"><span class="tag">${esc(T.inboxRecommended)}</span> ${esc(recIndex < 0 ? rec : recWhy)}</p>` : ''}
    ${answering ? `<form class="ibx-answer" data-answer="${i.id}"><label class="field"><span>${esc(i.options.length ? T.ibxOwnWordsOr : T.ibxOwnWords)}</span><textarea name="answer" rows="3" maxlength="2000" placeholder="${esc(T.ibxReachesTo(i.session))}"></textarea></label>
        <div class="ibx-actions"><span class="ibx-note">${esc(i.options.length ? T.ibxOptionDetail : T.ibxGoesOn)}</span><span class="row"><button type="button" class="btn danger" data-dismiss="${i.id}">${esc(T.inboxDismiss)}</button><button class="btn primary ok">${esc(T.inboxSend)}</button></span></div></form>` : ''}
    ${replying ? `<form class="ibx-answer" data-answer="${i.id}"><label class="field"><span>${esc(T.ibxReplyTell)}</span><textarea name="answer" rows="2" maxlength="2000" placeholder="${esc(T.ibxReachesTo(i.session))}"></textarea></label>
        <div class="ibx-actions"><span class="ibx-note">${esc(T.ibxReplyTellNote)}</span><span class="row"><button type="button" class="btn ok" data-resolve="${i.id}">${esc(T.inboxResolve)}</button><button class="btn primary ok">${esc(T.inboxSend)}</button></span></div></form>` : ''}
    ${why ? `<p class="ibx-note">${esc(why)}</p>` : ''}
    ${open && !answering && !replying && can('operator') ? `<div class="ibx-actions">${why ? `<a class="btn ok" href="#/s/${encodeURIComponent(i.session)}">${esc(T.inboxAnswer)}</a>` : ''}${ask ? `<button type="button" class="btn danger" data-dismiss="${i.id}">${esc(T.inboxDismiss)}</button>` : `<button type="button" class="btn ok${why ? '' : ' primary'}" data-resolve="${i.id}">${esc(T.inboxResolve)}</button>`}</div>` : ''}
    ${i.answer != null ? `<p class="ibx-result">${esc(T.inboxAnswered(i.answered_by ?? '', i.answer))}</p>` : ''}
    ${i.dismissed_by ? `<p class="ibx-result">${esc(T.inboxDismissed(i.dismissed_by))}</p>` : ''}
    ${i.closed_reason ? `<p class="ibx-result">${esc(T.inboxClosed(i.closed_reason))}</p>` : ''}
    </div>
    <dl class="ibx-facts">
      ${i.ref ? `<dt>${esc(T.ibxRef)}</dt><dd>${refHtml(i.ref)}</dd>` : ''}
      <dt>${esc(T.ibxLeft)}</dt><dd>${esc(when(i.created_at))}</dd>
      ${i.updated_at ? `<dt>${esc(T.ibxChanged)}</dt><dd>${esc(when(i.updated_at))}</dd>` : ''}
      ${i.resolved_at ? `<dt>${esc(T.ibxClosedAt)}</dt><dd>${esc(when(i.resolved_at))}</dd>` : ''}
    </dl></article>`
}

let hadPick = null // the key of the one open at the last draw

// The two tabs, in the header: how many wait on the first.
function tabs(tab, waiting) {
  const a = (t, href, label, n) => `<a href="${href}"${t === tab ? ' class="on" aria-current="page"' : ''} data-ibxtab="${t}">${esc(label)}${n ? ` <span class="badge soft">${n}</span>` : ''}</a>`
  return `<nav class="seg" aria-label="${esc(T.inbox)}">${a('pending', '#/inbox', T.ibxPending, waiting)}${a('done', '#/inbox/done', T.ibxDoneTab, 0)}</nav>`
}

// Pending: what needs you, then what to know (read all at once, if several).
function pendingList(groups, picked) {
  return groups.filter(g => g.list.length).map(g => {
    const readAll = g.id === 'know' && g.list.length > 1 && can('operator') ? `<button type="button" class="btn quiet ibx-readall" data-readall>${esc(T.ibxReadAll)}</button>` : ''
    return `<section class="ibx-group"><h2 class="ibx-group-h"><span>${esc(g.label)}</span>${readAll}<span class="badge soft">${g.list.length}</span></h2><ul>${g.list.map(e => row(e, e === picked)).join('')}</ul></section>`
  }).join('')
}

// Done: a search, a team, the days, and more as the list ends.
function doneList(list, picked) {
  const coords = sortedSessions().filter(x => x.role === 'coordinator')
  if (done.team && !coords.some(c => c.name === done.team)) coords.push({ name: done.team })
  const tools = `<form class="ibx-tools" role="search" data-donefilter>
      <input class="input" type="search" id="ibxQ" name="q" value="${esc(done.q)}" placeholder="${esc(T.ibxSearch)}" aria-label="${esc(T.ibxSearch)}" autocomplete="off" maxlength="100">
      <select class="input" name="team" aria-label="${esc(T.ibxTeam)}"><option value="">${esc(T.ibxAllTeams)}</option>${coords.map(c => `<option value="${esc(c.name)}"${c.name === done.team ? ' selected' : ''}>${esc(state.squadMeta.get(c.name)?.title || c.name)}</option>`).join('')}</select>
    </form>`
  const days = []
  for (const e of list) {
    const day = dayOf(e.at)
    if (days.at(-1)?.day !== day) days.push({ day, list: [] })
    days.at(-1).list.push(e)
  }
  const body = days.map(d => `<section class="ibx-group"><h2 class="ibx-group-h"><span>${esc(d.day)}</span></h2><ul>${d.list.map(e => row(e, e === picked, 'done')).join('')}</ul></section>`).join('')
  const filtered = !!(done.q.trim() || done.team)
  const foot = done.failed ? `<p class="ibx-none">${esc(T.ibxLoadFailed)} <button type="button" class="btn quiet" data-more>${esc(T.tplRetry)}</button></p>`
    : done.next ? `<div class="ibx-more"><button type="button" class="btn" data-more${done.loading ? ' disabled' : ''}>${esc(done.loading ? T.ibxLoading : T.ibxLoadMore)}</button></div>`
    : !done.loaded ? `<p class="ibx-none">${esc(T.ibxLoading)}</p>`
    : list.length ? `<p class="ibx-end">${esc(T.ibxEnd)}</p>`
    : `<p class="ibx-none">${esc(filtered ? T.ibxNoMatch : T.ibxNoDone)}</p>`
  return tools + body + foot
}

// (The next page, as the end of the list comes into view.)
const moreSeen = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) void loadDone(true) }, { rootMargin: '200px' })
  : null

export function renderInbox() {
  const r = currentRoute()
  const tab = tabOf(r)
  const groups = entries()
  const pending = groups.flatMap(g => g.list)
  const waiting = groups[0].list.length
  if (tab === 'done' && !done.loaded && !done.loading && !done.failed) void loadDone()
  const doneList_ = tab === 'done' ? doneEntries() : []
  const all = tab === 'done' ? doneList_ : pending
  // What arrived since the last draw of the list (not on the first).
  const keys = pending.map(e => e.key)
  if (listedKeys) for (const k of keys) if (!listedKeys.has(k) && !arrived.has(k)) arrived.set(k, Date.now())
  listedKeys = new Set(keys)
  for (const [k, t] of arrived) if (Date.now() - t > FRESH_MS * 10) arrived.delete(k)
  // What is picked: only the one in the address; without one, the list has the page.
  // (Pending, one just answered stays open until the next is.)
  const picked = r.item ? (all.find(e => e.key === r.item) ?? (tab === 'pending' ? (() => {
    const i = state.inbox.find(x => `i${x.id}` === r.item)
    return i ? { key: r.item, kind: i.resolved_at ? 'done' : i.kind, i, at: i.resolved_at ?? i.created_at } : null
  })() : null)) : null
  const focus = document.activeElement?.closest?.('#inbox') ? document.activeElement : null
  const focusKey = focus?.closest('[data-key]')?.dataset.key
  const typing = focus?.name === 'answer'
  const searching = focus?.id === 'ibxQ' ? [focus.selectionStart, focus.selectionEnd] : null
  const list = tab === 'done' ? doneList(doneList_, picked) : pendingList(groups, picked)
  const fresh = tab === 'pending' && !pending.length && !sortedSessions().length
  const caughtUp = tab === 'pending' && !pending.length
  const pick = !!picked
  setHtml($('inbox'), `<div class="ibx${pick ? ' has-pick' : ''}${fresh ? ' fresh' : ''}${caughtUp && !fresh ? ' none' : ''}" data-tab="${tab}">
      <nav class="ibx-list" aria-label="${esc(T.inbox)}"><div class="ibx-col">${tab === 'pending' ? (caughtUp && !fresh ? '' : list || `<p class="ibx-none">${esc(T.ibxNothingListed)}</p>`) : list}</div></nav>
      <section class="ibx-detail${pick && !hadPick ? ' enter' : ''}" aria-live="polite">${tab === 'done' && !picked ? doneHint() : detail(picked)}</section>
    </div>`)
  const closed = !pick && hadPick
  hadPick = picked?.key ?? null
  setHtml($('topTabs'), tabs(tab, pending.length))
  $('topSub').textContent = tab === 'pending' && waiting ? T.ibxWaiting(waiting) : ''
  if (moreSeen) { moreSeen.disconnect(); const m = $('inbox').querySelector('.ibx-more [data-more]'); if (m) moreSeen.observe(m) }
  // Back where the user was: the answer they were typing, the search, the row they were on.
  for (const f of $('inbox').querySelectorAll('[data-answer]')) {
    const input = f.elements.answer
    const d = drafts.get(Number(f.dataset.answer))
    if (d && !input.value) input.value = d
    if (typing && document.activeElement !== input) input.focus()
  }
  const q = $('ibxQ')
  if (q && q.value !== done.q) q.value = done.q
  if (searching && q && document.activeElement !== q) { q.focus(); q.setSelectionRange(...searching) }
  if (focusKey && !typing && !searching && document.activeElement !== focus) $('inbox').querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus()
  // Just closed: the keyboard goes back to its row.
  else if (closed) $('inbox').querySelector(`[data-key="${CSS.escape(closed)}"]`)?.focus({ preventScroll: true })
}
// (Done, with none open: what the tab is.)
const doneHint = () => `<div class="empty">${icon('archive', 'empty-ic')}<b>${esc(T.ibxDoneTab)}</b><span>${esc(T.ibxDoneHint)}</span></div>`
export const refreshInbox = () => { if (currentRoute().view === 'inbox' && !$('inbox').hidden) renderInbox() }

// After an answer, the next decision that waits; after a note, the next note.
// With none left, back to the whole list.
function next(id) {
  const [decide, know] = entries()
  // (Known by its kind: answered, it may have left the list already.)
  const wasNote = know.list.some(e => e.i?.id === id) || state.inbox.find(x => x.id === id)?.kind === 'tell'
  const list = [...decide.list, ...(wasNote ? know.list : [])].filter(e => e.i?.id !== id)
  if (list.length) replaceHash(`#/inbox/${list[0].key}`); else closeTo('#/inbox')
}

async function answer(id, text) {
  const i = state.inbox.find(x => x.id === id)
  if (!i || !text.trim()) return
  try {
    await postJson('/api/inbox/answer', { id, version: seen.get(id) ?? i.version, answer: text })
    drafts.delete(id)
    picks.delete(id)
    next(id)
  } catch (err) {
    // Changed since they read it: now they have, and it says so.
    if (err.reason === 'changed') seen.set(id, i.version)
    alertBox(err.reason === 'changed' ? T.inboxChangedSince : err.message)
    renderInbox()
  }
}
const pickedAsk = () => { const f = $('inbox').querySelector('[data-answer]'); return f ? Number(f.dataset.answer) : null }
// Picking an option only marks it: it goes with Send (or Ctrl+Enter), along
// with whatever is typed, before or after. Picked again, it is unmarked.
function choose(n, { toggle = true } = {}) {
  const id = pickedAsk()
  const i = state.inbox.find(x => x.id === id)
  if (!i?.options[n]) return
  if (toggle && picks.get(id) === n) picks.delete(id); else picks.set(id, n)
  for (const b of $('inbox').querySelectorAll('[data-option]')) b.setAttribute('aria-pressed', String(picks.get(id) === Number(b.dataset.option)))
}
// What Send sends: the option picked, with the detail typed; or only what is typed.
function send(f) {
  const id = Number(f.dataset.answer)
  const i = state.inbox.find(x => x.id === id)
  const typed = f.elements.answer.value.trim()
  const choice = i?.options[picks.get(id)]
  if (!choice && !typed) { f.elements.answer.focus(); return }
  return answer(id, choice ? (typed ? `${choice}. ${typed}` : choice) : typed)
}

$('inbox').addEventListener('click', async e => {
  // The open one, clicked again, closes.
  const on = e.target.closest('.ibx-item.on')
  if (on && !e.metaKey && !e.ctrlKey) { e.preventDefault(); closeTo(listHash()); return }
  if (e.target.closest('.ibx-close') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); closeTo(listHash()); return }
  if (e.target.closest('[data-more]')) { done.failed = false; return void loadDone(done.loaded) }
  // Everything to know, read: what is listed now, not what arrives meanwhile.
  if (e.target.closest('[data-readall]')) {
    const ids = entries()[1].list.map(x => x.i.id)
    try { await postJson('/api/inbox/read-all', { ids }) } catch (err) { alertBox(err.message) }
    return
  }
  if (e.target.closest('[data-addmachine]')) { location.hash = '#/hosts/new'; return }
  if (e.target.closest('[data-newteam]')) { location.hash = '#/new'; return }
  const opt = e.target.closest('[data-option]')
  if (opt) return choose(Number(opt.dataset.option))
  // A question put away: its coordinator is told not to wait, if it can be.
  const dm = e.target.closest('[data-dismiss]')
  if (dm) {
    const id = Number(dm.dataset.dismiss)
    const session = state.inbox.find(x => x.id === id)?.session ?? ''
    try {
      const r = await postJson('/api/inbox/dismiss', { id })
      next(id)
      if (r && r.told === false) alertBox(T.inboxDismissNotTold(session))
    } catch (err) { alertBox(err.message) }
    return
  }
  const b = e.target.closest('[data-resolve]')
  if (b) {
    try { await postJson('/api/inbox/resolve', { id: Number(b.dataset.resolve) }); next(Number(b.dataset.resolve)) } catch (err) { alertBox(err.message) }
  }
})
// Searching what is done: as it is typed (a moment after), or a team picked.
let searchSoon = null
$('inbox').addEventListener('input', e => {
  const f = e.target.closest('[data-answer]')
  if (f) drafts.set(Number(f.dataset.answer), e.target.value)
  if (e.target.id === 'ibxQ') {
    done.q = e.target.value
    clearTimeout(searchSoon)
    searchSoon = setTimeout(() => { done.items = []; done.next = null; done.loaded = false; void loadDone() }, 250)
  }
})
$('inbox').addEventListener('change', e => {
  if (e.target.name !== 'team' || !e.target.closest('[data-donefilter]')) return
  done.team = e.target.value
  done.items = []; done.next = null; done.loaded = false
  void loadDone()
})
$('inbox').addEventListener('submit', e => {
  if (e.target.closest('[data-donefilter]')) { e.preventDefault(); return }
  const f = e.target.closest('[data-answer]')
  if (!f) return
  e.preventDefault()
  void send(f)
})
$('inbox').addEventListener('keydown', e => {
  // Enter with Ctrl or ⌘ sends the answer: from the text, or from an option picked.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    const f = e.target.name === 'answer' ? e.target.form : e.target.closest('[data-option]') ? $('inbox').querySelector('[data-answer]') : null
    if (f) { e.preventDefault(); f.requestSubmit() }
  }
  // ↑ ↓ move along the list.
  const item = e.target.closest('.ibx-item')
  if (item && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    const items = [...$('inbox').querySelectorAll('.ibx-item')].filter(x => x.offsetParent)
    const to = items[items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)]
    // With one open, the next opens too; with the list alone, it only moves.
    if (to) { to.focus(); if (currentRoute().item) replaceHash(to.getAttribute('href')) }
  }
})
// Esc closes the one open, back to the list and to its row.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('inbox').hidden || !currentRoute().item) return
  if (!$('palette').hidden || !$('settings').hidden || document.querySelector('.modal-bg')) return
  if (e.target.closest?.('textarea, input') && e.target.value) return
  closeTo(listHash())
})
// 1–9 picks an option (without sending it), from anywhere in the inbox but a text field.
document.addEventListener('keydown', e => {
  if ($('inbox').hidden || !/^[1-9]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || !$('palette').hidden || !$('settings').hidden || document.querySelector('.modal-bg')) return
  if (pickedAsk() != null) { e.preventDefault(); choose(Number(e.key) - 1, { toggle: false }) }
})
