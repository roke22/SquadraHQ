import { $ } from './dom.js'
import { T } from './i18n.js'
import { state, sessions, hosts, can } from './state.js'
import { esc } from './format.js'
import { postJson, terminalOf } from './machines.js'
import { personaOptions } from './squads.js'
import { icon } from './icons.js'
import { profiles, profileName, profileById, profileSummary } from './permissions.js'

// A new team, in one page: what it is for, who is in it, where it runs, and
// opening it. Each step says when it is done; nothing opens until the last.

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const slug = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 26)
const taken = name => sessions.get(name)?.online || !!terminalOf(name)

let draft = null // what is being made, while the page is open
let personas = { key: null, list: [], seq: 0 }

function fresh() {
  const free = base => { for (let i = 1; ; i++) { const n = `${base}${i}`; if (!taken(n)) return n } }
  const w1 = free('worker'), w2 = (() => { for (let i = Number(w1.slice(6)) + 1; ; i++) if (!taken(`worker${i}`)) return `worker${i}` })()
  const online = [...hosts.values()].filter(h => h.online)
  return { title: '', goal: '', start: 'workers', coord: { name: '', persona: '' }, workers: [{ name: w1, persona: '' }, { name: w2, persona: '' }], host: online[0]?.id ?? '', folder: online[0]?.info?.folders?.[0] ?? '', sub: '', profile: '', coordTouched: false, running: false, results: {} }
}

// The agents the chosen machine can run (an older machine: Claude Code only).
const agentsOf = id => { const a = hosts.get(id)?.info?.agents; return Array.isArray(a) && a.length ? a.map(x => x.id) : ['claude'] }

const folderNow = () => draft.folder ? (draft.sub.trim() ? `${draft.folder.replace(/\/+$/, '')}/${draft.sub.trim().replace(/^\/+|\/+$/g, '')}` : draft.folder) : ''
const members = () => [{ ...draft.coord, role: 'coordinator' }, ...(draft.start === 'solo' ? [] : draft.workers.map(w => ({ ...w, role: 'worker' })))]
function problems() {
  const out = []
  const names = members().map(m => m.name)
  for (const n of names) if (!NAME_RE.test(n)) { out.push(T.ntBadName(n)); break }
  if (new Set(names).size !== names.length) out.push(T.ntSameName)
  const busy = names.find(taken)
  if (busy) out.push(T.ntBusy(busy))
  if (!draft.host) out.push(T.noOnlineMachines)
  else if (!draft.folder) out.push(T.noFoldersHere)
  return out
}

function stepState() {
  const goal = !!draft.title.trim()
  const who = members().every(m => NAME_RE.test(m.name))
  const where = !!draft.host && !!draft.folder
  return [goal, who, where]
}

function memberRow(m, i) {
  const role = m.role === 'coordinator' ? 'coord' : 'worker'
  const res = draft.results[m.name]
  return `<li class="nt-member">
      <span class="role ${role}" aria-hidden="true"></span>
      <label class="nt-name"><span class="sr-only">${esc(T.ntNameOf(T.roleName[m.role]))}</span><input type="text" value="${esc(m.name)}" maxlength="32" spellcheck="false" autocomplete="off" data-name="${i}" ${draft.running ? 'disabled' : ''}></label>
      <span class="nt-role">${esc(T.roleName[m.role])}</span>
      ${agentsOf(draft.host).length > 1 ? `<label class="nt-agent"><span class="sr-only">${esc(T.agent)}</span><select data-agent="${i}" ${draft.running ? 'disabled' : ''}>${agentsOf(draft.host).map(a => `<option value="${a}" ${a === (m.agent ?? 'claude') ? 'selected' : ''}>${esc(T.agentName[a])}</option>`).join('')}</select></label>` : ''}
      <label class="nt-persona"><span class="sr-only">${esc(T.persona)}</span><select data-persona="${i}" ${draft.running ? 'disabled' : ''}><option value="">${esc(T.personaNone)}</option>${personaOptions(personas.list, m.persona, false)}</select></label>
      ${m.role === 'worker' && !draft.running ? `<button type="button" class="icon-btn" data-remove="${i - 1}" aria-label="${esc(T.ntRemove(m.name))}">${icon('close')}</button>` : '<span class="nt-gap"></span>'}
      ${res ? `<span class="nt-res ${res.ok ? 'ok' : res.ok === false ? 'bad' : ''}" role="status">${esc(res.text)}</span>` : ''}
    </li>`
}

const step = (n, done, label) => `<li class="nt-step${done ? ' done' : ''}"><b aria-hidden="true">${done ? '✓' : n}</b>${esc(label)}${done ? `<span class="sr-only"> · ${esc(T.fsDone)}</span>` : ''}</li>`
function stepsHtml() {
  const [g, w, h] = stepState()
  return `${step(1, g, T.ntGoalStep)}${step(2, w, T.ntWhoStep)}${step(3, h, T.ntWhereStep)}${step(4, false, T.ntLaunchStep)}`
}
function goHtml() {
  const issues = problems()
  return `${issues.length && !draft.running ? `<p class="nt-issues" role="alert">${issues.map(esc).join('<br>')}</p>` : ''}
    <div class="nt-actions"><a class="btn plain" href="#/teams">${esc(T.cancel)}</a><button class="btn primary" data-launch ${issues.length || draft.running ? 'disabled' : ''}>${esc(draft.running ? T.opening : T.ntLaunch(members().length))}</button></div>`
}
// While typing: only what depends on it, so the field keeps its caret.
function updateStatus() {
  const box = $('newteam')
  if (!draft.coordTouched) {
    draft.coord.name = draft.title.trim() ? `coord-${slug(draft.title) || 'team'}` : (taken('coord') ? '' : 'coord')
    const input = box.querySelector('[data-name="0"]')
    if (input && document.activeElement !== input) input.value = draft.coord.name
  }
  box.querySelector('.nt-steps').innerHTML = stepsHtml()
  box.querySelector('.nt-go').innerHTML = goHtml()
}

export function renderNewTeam() {
  if (!can('operator')) { $('newteam').innerHTML = `<div class="empty"><b>${esc(T.ntNotAllowed)}</b></div>`; return }
  if (!draft) draft = fresh()
  const online = [...hosts.values()].filter(h => h.online)
  if (!draft.host && online[0]) { draft.host = online[0].id; draft.folder = online[0].info?.folders?.[0] ?? '' }
  if (!draft.coordTouched) draft.coord.name = draft.title.trim() ? `coord-${slug(draft.title) || 'team'}` : (taken('coord') ? '' : 'coord')
  const host = hosts.get(draft.host)
  const folders = host?.info?.folders ?? []
  // (What had the focus keeps it: a click that redraws the page doesn't lose your place.)
  const focused = document.activeElement?.closest?.('#newteam') ? document.activeElement : null
  const focusSel = focused ? (focused.name ? `[name="${focused.name}"]` : ['data-name', 'data-agent', 'data-persona', 'data-start', 'data-remove'].map(a => focused.hasAttribute(a) ? `[${a}="${CSS.escape(focused.getAttribute(a))}"]` : '').find(Boolean)) : null
  $('newteam').innerHTML = `<form class="nt" novalidate>
      <ol class="nt-steps" aria-label="${esc(T.ntSteps)}">${stepsHtml()}</ol>

      <section class="nt-sec"><h2>${esc(T.ntGoalStep)}</h2>
        <label class="field"><span>${esc(T.ntTitle)}</span><input type="text" name="title" maxlength="40" value="${esc(draft.title)}" placeholder="${esc(T.ntTitleHint)}" autocomplete="off" ${draft.running ? 'disabled' : ''}></label>
        <label class="field"><span>${esc(T.ntGoal)}</span><textarea name="goal" maxlength="300" rows="2" placeholder="${esc(T.ntGoalHint)}" ${draft.running ? 'disabled' : ''}>${esc(draft.goal)}</textarea></label>
        ${can('manager') ? `<label class="field"><span>${esc(T.tqPermissions)}</span><select name="profile" ${draft.running ? 'disabled' : ''}><option value="">${esc(T.permNone)}</option>${profiles().map(p => `<option value="${esc(p.id)}" ${draft.profile === p.id ? 'selected' : ''}>${esc(profileName(p))}</option>`).join('')}</select></label>
        <p class="nt-note" data-profile-say>${esc(profileSummary(profileById(draft.profile)))}</p>` : ''}
      </section>

      <section class="nt-sec"><h2>${esc(T.ntWhoStep)}</h2>
        <div class="nt-choices" role="radiogroup" aria-label="${esc(T.ntStartWith)}">
          ${[['workers', T.ntWithWorkers, T.ntWithWorkersHint], ['solo', T.ntJustCoord, T.ntJustCoordHint], ...state.templates.map(t => [`tpl:${t.name}`, T.ntTemplate(t.name), T.tplSummary(t.coordinator?.name ?? '?', t.workers.length)])]
            .map(([v, l, hint]) => `<button type="button" role="radio" aria-checked="${draft.start === v}" class="nt-choice${draft.start === v ? ' on' : ''}" data-start="${esc(v)}" ${draft.running ? 'disabled' : ''}><b>${esc(l)}</b><span>${esc(hint)}</span></button>`).join('')}
        </div>
        <div class="card nt-card"><header class="nt-card-h"><h3>${esc(T.ntWillOpen)}</h3>${draft.start !== 'solo' && !draft.running ? `<button type="button" class="btn quiet" data-addworker>${esc(T.tqAddWorker)}</button>` : ''}</header>
          <ul class="nt-members">${members().map(memberRow).join('')}</ul>
          <p class="nt-note">${esc(T.ntPersonasNote)}</p></div>
      </section>

      <section class="nt-sec"><h2>${esc(T.ntWhereStep)}</h2>
        ${online.length ? `<div class="nt-row">
          <label class="field"><span>${esc(T.machine)}</span><select name="host" ${draft.running ? 'disabled' : ''}>${online.map(x => `<option value="${esc(x.id)}" ${x.id === draft.host ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(T.folder)}</span><select name="folder" ${draft.running ? 'disabled' : ''}>${folders.length ? folders.map(x => `<option value="${esc(x)}" ${x === draft.folder ? 'selected' : ''}>${esc(x)}</option>`).join('') : '<option value="">—</option>'}</select></label>
          <label class="field"><span>${esc(T.subfolder)}</span><input type="text" name="sub" value="${esc(draft.sub)}" placeholder="${esc(T.subfolderHint)}" autocomplete="off" ${draft.running ? 'disabled' : ''}></label>
        </div>` : `<p class="nt-note">${esc(T.noOnlineMachines)} <a class="ibx-link" href="#/hosts">${esc(T.machines)}</a></p>`}
      </section>

      <section class="nt-sec nt-go">${goHtml()}</section>
    </form>`
  if (focusSel) $('newteam').querySelector(focusSel)?.focus()
  void loadPersonas()
}

async function loadPersonas() {
  const key = `${draft.host}\0${folderNow()}`
  if (key === personas.key || !draft.host || !draft.folder) return
  personas = { key, list: [], seq: personas.seq + 1 }
  const seq = personas.seq
  try {
    const r = await postJson('/api/hosts/personas', { host: draft.host, folder: folderNow() })
    if (seq !== personas.seq) return
    personas.list = r.personas ?? []
    renderNewTeam()
  } catch {}
}

async function launch() {
  const list = members()
  const folder = folderNow()
  draft.running = true
  draft.results = {}
  renderNewTeam()
  let failed = false
  for (const [i, m] of list.entries()) {
    draft.results[m.name] = { text: T.opening }
    renderNewTeam()
    const tpl = draft.start.startsWith('tpl:') ? state.templates.find(t => `tpl:${t.name}` === draft.start) : null
    const own = tpl ? (i ? tpl.workers[i - 1] : tpl.coordinator) : null
    const spec = { name: m.name, role: m.role, folder: own?.folder ?? folder, ...(m.persona ? { persona: m.persona } : {}), ...(m.agent && m.agent !== 'claude' && agentsOf(draft.host).includes(m.agent) ? { agent: m.agent } : {}), ...(own?.compact_window ? { compact_window: own.compact_window } : { compact_window: 600000 }) }
    if (i) spec.coordinator = list[0].name
    try {
      // (The team's permission profile first: its sessions open with it.)
      if (!i && draft.profile) await postJson('/api/permissions/assign', { coordinator: m.name, profile: draft.profile })
      await postJson('/api/terminals/open', { host: draft.host, spec })
      draft.results[m.name] = { ok: true, text: T.ntOpened }
      // Once its coordinator exists, the team has its name and what it is for.
      if (!i && (draft.title.trim() || draft.goal.trim())) await postJson('/api/org/squad', { coordinator: m.name, title: draft.title.trim(), goal: draft.goal.trim() }).catch(() => {})
    } catch (e) {
      draft.results[m.name] = { ok: false, text: e.message }
      failed = true
      if (!i) break // without its coordinator, the workers would have no one to report to
    }
    renderNewTeam()
  }
  draft.running = false
  if (!failed) { const coord = list[0].name; draft = null; location.hash = `#/q/${encodeURIComponent(coord)}`; return }
  renderNewTeam()
}

$('newteam').addEventListener('input', e => {
  const t = e.target
  if (t.name === 'title') draft.title = t.value
  else if (t.name === 'goal') { draft.goal = t.value; return }
  else if (t.name === 'sub') draft.sub = t.value
  else if (t.dataset.name != null) {
    const i = Number(t.dataset.name)
    if (i === 0) { draft.coord.name = t.value.trim(); draft.coordTouched = true } else draft.workers[i - 1].name = t.value.trim()
  } else return
  updateStatus()
})
$('newteam').addEventListener('change', e => {
  const t = e.target
  if (t.name === 'host') { draft.host = t.value; draft.folder = hosts.get(t.value)?.info?.folders?.[0] ?? '' }
  else if (t.name === 'folder') draft.folder = t.value
  else if (t.name === 'profile') { draft.profile = t.value; $('newteam').querySelector('[data-profile-say]').textContent = profileSummary(profileById(t.value)); return }
  else if (t.dataset.persona != null) { const i = Number(t.dataset.persona); if (i === 0) draft.coord.persona = t.value; else draft.workers[i - 1].persona = t.value; return }
  else if (t.dataset.agent != null) { const i = Number(t.dataset.agent); (i === 0 ? draft.coord : draft.workers[i - 1]).agent = t.value; return }
  else return
  renderNewTeam()
})
$('newteam').addEventListener('click', e => {
  const s = e.target.closest('[data-start]')
  if (s) {
    draft.start = s.dataset.start
    const tpl = state.templates.find(t => `tpl:${t.name}` === draft.start)
    if (tpl) {
      draft.coord = { name: tpl.coordinator.name, persona: tpl.coordinator.persona ?? '' }
      draft.coordTouched = true
      draft.workers = tpl.workers.map(w => ({ name: w.name, persona: w.persona ?? '' }))
      if (tpl.host && hosts.get(tpl.host)?.online) draft.host = tpl.host
    }
    return renderNewTeam()
  }
  if (e.target.closest('[data-addworker]')) {
    for (let i = 1; ; i++) { const n = `worker${i}`; if (!taken(n) && !members().some(m => m.name === n)) { draft.workers.push({ name: n, persona: '' }); break } }
    return renderNewTeam()
  }
  const r = e.target.closest('[data-remove]')
  if (r) { draft.workers.splice(Number(r.dataset.remove), 1); return renderNewTeam() }
})
$('newteam').addEventListener('submit', e => { e.preventDefault(); if (!draft.running && !problems().length) void launch() })
// Leaving the page leaves what was typed behind, unless it is opening.
window.addEventListener('hashchange', () => { if (location.hash !== '#/new' && !draft?.running) draft = null })
