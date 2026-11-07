import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, can, sessions, hosts } from './state.js'
import { esc, now } from './format.js'
import { sortedSessions, status } from './content.js'
import { setHtml } from './nav.js'
import { postJson } from './machines.js'
import { alertBox } from './mosaic.js'
import { currentRoute } from './router.js'
import { icon } from './icons.js'

// The inbox: everything that waits on you, in one list, and the one picked
// on the right. Decisions coordinators left (ask_user), permission prompts
// waiting in a session, names to approve; then what they wanted you to know
// (tell_user); then what is done. It says what they wrote and nothing more:
// what it is about, a ticket or anything else, is theirs.

const when = t => new Date(t).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
// "3 min ago", "now": in the reader's language, from the browser.
const RTF = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' })
function ago(t) {
  const s = Math.round((t - now()) / 1000), a = Math.abs(s)
  return a < 45 ? RTF.format(0, 'second') : a < 3600 ? RTF.format(Math.round(s / 60), 'minute') : a < 86400 ? RTF.format(Math.round(s / 3600), 'hour') : RTF.format(Math.round(s / 86400), 'day')
}
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
  return `<span class="ibx-who"><span class="role ${role}" aria-hidden="true"></span><span class="sr-only">${esc(T.roleName[s?.role] ?? '')} </span>${esc(name)}</span>`
}

// The version of each question the user has had in front of them: if its
// coordinator changes it after that, an answer is refused until they read it
// again (they must never decide on what it no longer thinks).
const seen = new Map()
// What they were typing, kept across redraws.
const drafts = new Map()

// Why an answer can't be typed in the coordinator's terminal from here (null: it can).
function cantAnswer(i) {
  const h = hosts.get(sessions.get(i.session)?.host_id)
  if (!h?.online) return T.inboxNoMachine
  if (!h.info?.answers) return T.inboxOldMachine
  if (h.info.allow_input === false) return T.inboxTypingOff
  return null
}

// Everything listed, in its groups. Each entry: { key, kind, ... }.
function entries() {
  const open = state.inbox.filter(i => !i.resolved_at)
  const asks = open.filter(i => i.kind === 'ask').map(i => ({ key: `i${i.id}`, kind: 'ask', i, at: i.updated_at ?? i.created_at }))
  // Permission prompts waiting in a session: answered in its terminal.
  const perms = sortedSessions().filter(s => status(s).waiting).map(s => ({ key: `p${s.name}`, kind: 'perm', s, at: (s.activity?.tool?.since ?? s.activity?.since ?? now()) }))
  const approvals = can('manager') ? sortedSessions().filter(s => s.approval_pending).map(s => ({ key: `a${s.name}`, kind: 'approve', s, at: (s.created_at ?? 0) * 1000 })) : []
  const tells = open.filter(i => i.kind === 'tell').map(i => ({ key: `i${i.id}`, kind: 'tell', i, at: i.created_at }))
  const done = state.inbox.filter(i => i.resolved_at).map(i => ({ key: `i${i.id}`, kind: 'done', i, at: i.resolved_at }))
  const newest = (a, b) => b.at - a.at
  return [
    { id: 'decide', label: T.ibxDecide, list: [...perms.sort(newest), ...asks.sort(newest), ...approvals] },
    { id: 'know', label: T.inboxTell, list: tells.sort(newest) },
    { id: 'done', label: T.ibxDone, list: done.sort(newest), folded: true },
  ]
}

function row(e, on) {
  const href = `#/inbox/${e.key}`
  let dot, title, meta
  if (e.kind === 'perm') {
    dot = 'warn'; title = T.ibxPermTitle(e.s.name, status(e.s).text)
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
  return `<li><a href="${href}" class="ibx-item${on ? ' on' : ''}${e.kind === 'done' ? ' done' : ''}"${on ? ' aria-current="true"' : ''} data-key="${esc(e.key)}">`
    + `<span class="dot ${dot}" aria-hidden="true"></span><span class="ibx-item-b"><span class="ibx-item-t">${esc(title)}</span><span class="ibx-item-m">${meta.filter(Boolean).join('<span aria-hidden="true">·</span>')}</span></span></a></li>`
}

function detail(e) {
  if (!e) return `<div class="empty">${icon('inbox', 'empty-ic')}<b>${esc(T.inboxEmpty)}</b><span>${esc(T.ibxEmptyHint)}</span></div>`
  const back = `<a class="ibx-back" href="#/inbox">${icon('chevron', 'flip')}<span>${esc(T.inbox)}</span></a>`
  if (e.kind === 'perm') {
    const s = e.s
    return `${back}<div class="ibx-meta">${who(s.name)}<span>${esc(teamOf(s.name))}</span></div>
      <h2 class="ibx-q">${esc(T.ibxPermTitle(s.name, ''))}</h2><pre class="ibx-perm">${esc(status(s).text)}</pre>
      <p class="ibx-note">${esc(T.ibxPermHint)}</p>
      <div class="ibx-actions"><a class="btn primary" href="#/s/${encodeURIComponent(s.name)}">${esc(T.ibxOpenSession)}</a></div>`
  }
  if (e.kind === 'approve') {
    const s = e.s
    return `${back}<div class="ibx-meta">${who(s.name)}</div>
      <h2 class="ibx-q">${esc(T.ibxApproveTitle(s.name))}</h2><p class="ibx-note">${esc(T.ibxApproveHint)}</p>
      <div class="ibx-actions"><a class="btn primary" href="#/s/${encodeURIComponent(s.name)}">${esc(T.ibxOpenSession)}</a></div>`
  }
  const i = e.i
  const open = !i.resolved_at
  const ask = i.kind === 'ask'
  if (open && !seen.has(i.id)) seen.set(i.id, i.version)
  const changed = open && seen.get(i.id) !== i.version
  const why = open && ask && can('operator') ? cantAnswer(i) : null
  const answering = open && ask && can('operator') && !why
  const recIndex = i.options.findIndex(o => i.recommended && o.trim().toLowerCase() === i.recommended.trim().toLowerCase())
  const opts = i.options.map((o, n) => answering
    ? `<button type="button" class="ibx-opt${n === recIndex ? ' rec' : ''}" data-option="${n}"><kbd>${n + 1}</kbd><span>${esc(o)}</span>${n === recIndex ? `<span class="tag">${esc(T.inboxRecommended)}</span>` : ''}</button>`
    : `<li>${esc(o)}${n === recIndex ? ` <span class="tag">${esc(T.inboxRecommended)}</span>` : ''}</li>`).join('')
  return `${back}<div class="ibx-meta">${who(i.session)}<span>${esc(teamOf(i.session))}</span><a class="ibx-link" href="#/s/${encodeURIComponent(i.session)}">${esc(T.ibxOpenSession)}</a></div>
    ${changed ? `<div class="ibx-changed" data-changed role="status">${esc(T.inboxChangedSince)}</div>` : ''}
    <h2 class="ibx-q${ask ? '' : ' tell'}">${esc(i.text)}</h2>
    ${i.options.length ? (answering ? `<div class="ibx-opts" role="group" aria-label="${esc(T.inboxOptions)}">${opts}</div>` : `<ul class="ibx-optlist">${opts}</ul>`) : ''}
    ${i.recommended && recIndex < 0 ? `<p class="ibx-rec"><span class="tag">${esc(T.inboxRecommended)}</span> ${esc(i.recommended)}</p>` : ''}
    ${answering ? `<form class="ibx-answer" data-answer="${i.id}"><label class="field"><span>${esc(i.options.length ? T.ibxOwnWordsOr : T.ibxOwnWords)}</span><textarea name="answer" rows="3" maxlength="2000" placeholder="${esc(T.ibxReachesTo(i.session))}"></textarea></label>
        <div class="ibx-actions"><span class="ibx-note">${esc(i.options.length ? T.ibxOptionDetail : T.ibxGoesOn)}</span><span class="row">${can('operator') ? `<button type="button" class="btn quiet" data-resolve="${i.id}">${esc(T.inboxResolve)}</button>` : ''}<button class="btn primary">${esc(T.inboxSend)}</button></span></div></form>` : ''}
    ${why ? `<p class="ibx-note">${esc(why)}</p>` : ''}
    ${open && !answering && can('operator') ? `<div class="ibx-actions">${why ? `<a class="btn" href="#/s/${encodeURIComponent(i.session)}">${esc(T.inboxAnswer)}</a>` : ''}<button type="button" class="btn${why ? '' : ' primary'}" data-resolve="${i.id}">${esc(T.inboxResolve)}</button></div>` : ''}
    ${i.answer != null ? `<p class="ibx-result">${esc(T.inboxAnswered(i.answered_by ?? '', i.answer))}</p>` : ''}
    ${i.closed_reason ? `<p class="ibx-result">${esc(T.inboxClosed(i.closed_reason))}</p>` : ''}
    <dl class="ibx-facts">
      ${i.ref ? `<dt>${esc(T.ibxRef)}</dt><dd>${refHtml(i.ref)}</dd>` : ''}
      <dt>${esc(T.ibxLeft)}</dt><dd>${esc(when(i.created_at))}</dd>
      ${i.updated_at ? `<dt>${esc(T.ibxChanged)}</dt><dd>${esc(when(i.updated_at))}</dd>` : ''}
      ${i.resolved_at ? `<dt>${esc(T.ibxClosedAt)}</dt><dd>${esc(when(i.resolved_at))}</dd>` : ''}
    </dl>`
}

let doneOpen = false
export function renderInbox() {
  const r = currentRoute()
  const groups = entries()
  const all = groups.flatMap(g => g.list)
  const waiting = groups[0].list.length
  // What is picked: the one in the address, or the first that waits.
  const picked = all.find(e => e.key === r.item) ?? (r.item ? null : groups.find(g => !g.folded && g.list.length)?.list[0] ?? null)
  if (picked?.kind === 'done') doneOpen = true
  const focus = document.activeElement?.closest?.('#inbox') ? document.activeElement : null
  const focusKey = focus?.closest('[data-key]')?.dataset.key
  const typing = focus?.name === 'answer'
  const list = groups.filter(g => g.list.length).map(g => g.folded
    ? `<details class="ibx-group"${doneOpen ? ' open' : ''} data-folded><summary class="ibx-group-h"><span>${esc(g.label)}</span><span class="badge soft">${g.list.length}</span></summary><ul>${g.list.map(e => row(e, e === picked)).join('')}</ul></details>`
    : `<section class="ibx-group"><h2 class="ibx-group-h"><span>${esc(g.label)}</span><span class="badge soft">${g.list.length}</span></h2><ul>${g.list.map(e => row(e, e === picked)).join('')}</ul></section>`).join('')
  setHtml($('inbox'), `<div class="ibx${r.item ? ' has-pick' : ''}">
      <nav class="ibx-list" aria-label="${esc(T.inbox)}">${list || `<p class="ibx-none">${esc(T.ibxNothingListed)}</p>`}</nav>
      <section class="ibx-detail" aria-live="polite">${detail(picked)}</section>
    </div>`)
  $('topSub').textContent = waiting ? T.ibxWaiting(waiting) : ''
  // Back where the user was: the answer they were typing, the row they were on.
  for (const f of $('inbox').querySelectorAll('[data-answer]')) {
    const input = f.elements.answer
    const d = drafts.get(Number(f.dataset.answer))
    if (d && !input.value) input.value = d
    if (typing && document.activeElement !== input) input.focus()
  }
  if (focusKey && !typing && document.activeElement !== focus) $('inbox').querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus()
}
export const refreshInbox = () => { if (currentRoute().view === 'inbox' && !$('inbox').hidden) renderInbox() }

// After an answer, the next one that waits.
function next(id) {
  const list = entries()[0].list.filter(e => e.i?.id !== id)
  location.hash = list.length ? `#/inbox/${list[0].key}` : '#/inbox'
}

async function answer(id, text) {
  const i = state.inbox.find(x => x.id === id)
  if (!i || !text.trim()) return
  try {
    await postJson('/api/inbox/answer', { id, version: seen.get(id) ?? i.version, answer: text })
    drafts.delete(id)
    next(id)
  } catch (err) {
    // Changed since they read it: now they have, and it says so.
    if (err.reason === 'changed') seen.set(id, i.version)
    alertBox(err.reason === 'changed' ? T.inboxChangedSince : err.message)
    renderInbox()
  }
}
const pickedAsk = () => { const f = $('inbox').querySelector('[data-answer]'); return f ? Number(f.dataset.answer) : null }
function choose(n) {
  const id = pickedAsk()
  const i = state.inbox.find(x => x.id === id)
  const choice = i?.options[n]
  if (!choice) return
  const detailText = drafts.get(id)?.trim()
  return answer(id, detailText ? `${choice}. ${detailText}` : choice)
}

$('inbox').addEventListener('click', async e => {
  const opt = e.target.closest('[data-option]')
  if (opt) return choose(Number(opt.dataset.option))
  const b = e.target.closest('[data-resolve]')
  if (b) {
    try { await postJson('/api/inbox/resolve', { id: Number(b.dataset.resolve) }); next(Number(b.dataset.resolve)) } catch (err) { alertBox(err.message) }
  }
})
$('inbox').addEventListener('toggle', e => { if (e.target.matches?.('[data-folded]')) doneOpen = e.target.open }, true)
$('inbox').addEventListener('input', e => {
  const f = e.target.closest('[data-answer]')
  if (f) drafts.set(Number(f.dataset.answer), e.target.value)
})
$('inbox').addEventListener('submit', e => {
  const f = e.target.closest('[data-answer]')
  if (!f) return
  e.preventDefault()
  void answer(Number(f.dataset.answer), f.elements.answer.value)
})
$('inbox').addEventListener('keydown', e => {
  // Enter with Ctrl or ⌘ sends what was typed.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.name === 'answer') { e.preventDefault(); e.target.form.requestSubmit() }
  // ↑ ↓ move along the list.
  const item = e.target.closest('.ibx-item')
  if (item && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    const items = [...$('inbox').querySelectorAll('.ibx-item')].filter(x => x.offsetParent)
    const to = items[items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)]
    if (to) { to.focus(); to.click() }
  }
})
// 1–9 picks an option, from anywhere in the inbox but a text field.
document.addEventListener('keydown', e => {
  if ($('inbox').hidden || !/^[1-9]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || !$('palette').hidden || !$('settings').hidden || document.querySelector('.modal-bg')) return
  if (pickedAsk() != null) { e.preventDefault(); choose(Number(e.key) - 1) }
})
