import { $ } from './dom.js'
import { T } from './i18n.js'
import { state, sessions, hosts, can } from './state.js'
import { esc } from './format.js'
import { sortedSessions, status } from './content.js'
import { icon } from './icons.js'
import { toggleTheme } from './theme.js'

// Ctrl+K: go anywhere, or do something, by typing a few letters. What it
// offers is what this user's role allows; nothing here acts on its own
// beyond opening a screen or a dialog.

const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// How well a query fits a text: from its start best, then a word's start,
// anywhere, and the letters in order last. Null: not at all.
function score(q, text) {
  const t = fold(text)
  if (!q) return { s: 1, at: -1 }
  if (t.startsWith(q)) return { s: 100, at: 0 }
  const word = t.search(new RegExp(`(^|[\\s·_./-])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  if (word >= 0) return { s: 70, at: word + (t[word] === q[0] ? 0 : 1) }
  const at = t.indexOf(q)
  if (at >= 0) return { s: 45, at }
  let i = 0
  for (const c of t) if (c === q[i]) i++
  return i === q.length ? { s: 10, at: -1 } : null
}
// The part that matched, marked. (Folding keeps the length of plain letters;
// when it doesn't, nothing is marked rather than the wrong letters.)
function marked(text, q, at) {
  if (!q || at < 0 || fold(text).length !== text.length) return esc(text)
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + q.length))}</mark>${esc(text.slice(at + q.length))}`
}

function candidates() {
  const items = []
  const teamOf = s => (s.role === 'coordinator' ? s.name : s.coordinator)
  const titleOf = c => state.squadMeta.get(c)?.title || c
  // Sessions: who waits on you first.
  const list = sortedSessions()
  for (const s of [...list].sort((a, b) => (status(b).waiting === true) - (status(a).waiting === true))) {
    const st = status(s)
    const role = s.role === 'coordinator' ? 'coord' : s.role === 'solo' ? 'solo' : 'worker'
    const team = teamOf(s) ? titleOf(teamOf(s)) : ''
    items.push({ group: 'sessions', label: s.name, mono: true, sub: [team, st.text].filter(Boolean).join(' · '), lead: `<span class="role ${role}" aria-hidden="true"></span>`, tail: `<span class="dot ${st.dot || 'off'}" aria-hidden="true"></span>`, keys: [team], go: `#/s/${encodeURIComponent(s.name)}`, rank: st.waiting ? 1 : 0 })
  }
  for (const c of list.filter(s => s.role === 'coordinator')) {
    const n = list.filter(s => s.coordinator === c.name).length
    items.push({ group: 'teams', label: titleOf(c.name), sub: `${c.name} · ${T.squadCount(list.filter(s => s.coordinator === c.name && s.online).length, n)}`, lead: icon('teams'), go: `#/q/${encodeURIComponent(c.name)}` })
  }
  for (const i of state.inbox.filter(x => !x.resolved_at).slice(0, 20)) {
    items.push({ group: 'inbox', label: i.text.replace(/\s+/g, ' ').slice(0, 120), sub: i.session, lead: icon('inbox'), go: '#/', focus: `[data-inbox="${i.id}"]` })
  }
  items.push(
    { group: 'screens', label: T.inbox, lead: icon('inbox'), go: '#/' },
    { group: 'screens', label: T.teams, lead: icon('teams'), go: '#/teams' },
    { group: 'screens', label: T.viewMosaic, sub: T.allSessions, lead: icon('teams'), go: '#/mosaic' },
    { group: 'screens', label: T.org, lead: icon('teams'), go: '#/org' },
    { group: 'screens', label: T.machines, sub: hosts.size ? T.ofTotal([...hosts.values()].filter(h => h.online).length, hosts.size) : '', lead: icon('machines'), go: '#/hosts' },
    { group: 'screens', label: T.settings, lead: icon('settings'), run: async () => (await import('./people.js')).openSettings() },
  )
  if (sortedSessions({ archived: true }).length) items.push({ group: 'screens', label: T.archived, lead: icon('archive'), go: '#/archived' })
  if (can('operator')) items.push(
    { group: 'actions', label: T.actNewSession, lead: icon('plus'), run: async () => (await import('./squads.js')).newSessionDialog() },
    { group: 'actions', label: T.actNewTeam, lead: icon('plus'), go: '#/new' },
  )
  if (can('manager')) items.push(
    { group: 'actions', label: T.actAddMachine, lead: icon('machines'), run: async () => { if (location.hash !== '#/hosts') location.hash = '#/hosts'; (await import('./machines.js')).addMachineDialog() } },
    { group: 'actions', label: T.actInvite, lead: icon('teams'), run: async () => (await import('./people.js')).openSettings('members') },
  )
  items.push({ group: 'actions', label: T.actTheme, lead: icon('settings'), run: toggleTheme })
  return items
}

const ORDER_EMPTY = ['inbox', 'screens', 'sessions', 'actions']
const ORDER_QUERY = ['sessions', 'teams', 'inbox', 'screens', 'actions']
const PER_GROUP = 8

let shown = [] // what is listed, in order
let active = 0
let opener = null

function results(q) {
  const qf = fold(q.trim())
  const out = []
  for (const g of qf ? ORDER_QUERY : ORDER_EMPTY) {
    const found = []
    for (const it of candidates().filter(x => x.group === g)) {
      if (!qf) { found.push({ it, s: 0, at: -1 }); continue }
      const best = [it.label, it.sub, ...(it.keys ?? [])].map((t, k) => ({ m: score(qf, t ?? ''), k })).filter(x => x.m).sort((a, b) => b.m.s - a.m.s)[0]
      if (best) found.push({ it, s: best.m.s - best.k * 5 + (it.rank ?? 0), at: best.k === 0 ? best.m.at : -1 })
    }
    found.sort((a, b) => b.s - a.s)
    // (Empty, sessions only show those waiting on you, and the inbox a few.)
    const keep = qf ? found : g === 'sessions' ? found.filter(f => f.it.rank) : found
    for (const f of keep.slice(0, qf ? PER_GROUP : g === 'inbox' ? 5 : PER_GROUP)) out.push({ ...f.it, at: f.at })
  }
  return out
}

function draw() {
  const q = $('palInput').value
  shown = results(q)
  active = Math.min(active, Math.max(0, shown.length - 1))
  let html = '', last = null
  shown.forEach((it, i) => {
    if (it.group !== last) { html += `<div class="pal-g" role="presentation" id="palg-${it.group}">${esc(T.palGroup[it.group])}</div>`; last = it.group }
    html += `<div class="pal-i${i === active ? ' on' : ''}" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === active}" aria-describedby="palg-${it.group}">${it.lead ?? ''}<span class="pal-t${it.mono ? ' mono' : ''}">${marked(it.label, fold(q.trim()), it.at)}</span>${it.tail ?? ''}${it.sub ? `<span class="pal-s">${esc(it.sub)}</span>` : '<span class="pal-s"></span>'}<span class="pal-go" aria-hidden="true">${icon('enter')}</span></div>`
  })
  $('palList').innerHTML = html || `<div class="pal-empty">${esc(T.palNothing(q.trim()))}</div>`
  select(active)
}

function select(i) {
  if (!shown.length) { $('palInput').removeAttribute('aria-activedescendant'); return }
  active = (i + shown.length) % shown.length
  for (const el of $('palList').querySelectorAll('.pal-i')) {
    const on = Number(el.dataset.i) === active
    el.classList.toggle('on', on)
    el.setAttribute('aria-selected', String(on))
  }
  $('palInput').setAttribute('aria-activedescendant', `pal-${active}`)
  $(`pal-${active}`)?.scrollIntoView({ block: 'nearest' })
}

async function run(i) {
  const it = shown[i]
  if (!it) return
  closePalette(!!it.go)
  if (it.go) {
    if (location.hash !== it.go) location.hash = it.go
    if (it.focus) setTimeout(() => { const el = document.querySelector(it.focus); el?.scrollIntoView({ block: 'center' }); el?.querySelector('input, button')?.focus() }, 60)
  } else await it.run?.()
}

export function openPalette() {
  const p = $('palette')
  if (!p.hidden) return $('palInput').focus()
  opener = document.activeElement
  p.innerHTML = `<div class="pal-scrim" data-close></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="${esc(T.palLabel)}">
      <div class="pal-top">${icon('search')}<input id="palInput" type="text" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(T.palPlaceholder)}" aria-label="${esc(T.palPlaceholder)}"></div>
      <div class="pal-list" id="palList" role="listbox" aria-label="${esc(T.palLabel)}"></div>
      <div class="pal-foot"><span>${esc(T.palHint)}</span><span>${esc(T.palEsc)}</span></div>
    </div>`
  p.hidden = false
  active = 0
  draw()
  const input = $('palInput')
  input.focus()
  input.addEventListener('input', () => { active = 0; draw() })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(active + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(active - 1) }
    else if (e.key === 'PageDown') { e.preventDefault(); select(Math.min(active + 5, shown.length - 1)) }
    else if (e.key === 'PageUp') { e.preventDefault(); select(Math.max(active - 5, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(active) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette() }
    else if (e.key === 'Tab') e.preventDefault() // (the list is reached with the arrows)
  })
  $('palList').addEventListener('mousemove', e => { const el = e.target.closest('.pal-i'); if (el && Number(el.dataset.i) !== active) select(Number(el.dataset.i)) })
  $('palList').addEventListener('click', e => { const el = e.target.closest('.pal-i'); if (el) run(Number(el.dataset.i)) })
  p.querySelector('[data-close]').addEventListener('click', () => closePalette())
}

// (Going somewhere: the focus goes with the new screen, not back to where it was.)
export function closePalette(leaving = false) {
  const p = $('palette')
  if (p.hidden) return
  p.hidden = true
  p.innerHTML = ''
  shown = []
  if (!leaving && opener?.isConnected) opener.focus()
  opener = null
}
export const paletteOpen = () => !$('palette').hidden
