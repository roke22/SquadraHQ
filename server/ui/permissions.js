import { T } from './i18n.js'
import { state, can, sessions, hosts } from './state.js'
import { esc } from './format.js'
import { dialog, confirmDialog } from './dialogs.js'
import { call as post, inCompany } from './api.js'

// Permission profiles: what the agents of a team may do without asking.
// Written here (Settings › Agent permissions), followed by a team or by one
// session; each machine turns them into Claude Code's own rules when it opens
// a session from the dashboard, as far as it takes them. The server keeps
// them (server/permissions/) and says which capability is which rules.

export const CAPS = ['edit', 'tests', 'install', 'commit', 'push', 'history', 'remove', 'web', 'docker', 'sudo']
const STATES = ['default', 'allow', 'ask', 'deny']
const NONE = 'none'

export const profiles = () => state.permissions?.profiles ?? []
export const profileById = id => profiles().find(p => p.id === id) ?? null
export const profileName = p => (p ? (p.builtin ? T.permBuiltin[p.id] ?? p.name : p.name) : '')

// Which profile a session follows, and why: its own, its team's, or none.
export function profileOf(s) {
  if (!s) return { profile: null, from: null }
  const own = state.permissions?.sessions?.[s.name] ?? null
  if (own === NONE) return { profile: null, from: 'session' }
  if (own) return { profile: profileById(own), from: 'session' }
  const role = s.role ?? s.opened_role
  const team = role === 'coordinator' ? s.name : role === 'worker' ? s.coordinator : null
  const id = team ? state.permissions?.teams?.[team] : null
  return { profile: id ? profileById(id) : null, from: id ? 'team' : null }
}
export const teamProfile = coordinator => profileById(state.permissions?.teams?.[coordinator] ?? '')

// What a profile lets them do, in a few words: what it allows and forbids.
export function profileSummary(p) {
  if (!p) return T.permNoProfile
  const by = st => CAPS.filter(c => p.caps?.[c] === st).map(c => T.permCapShort[c])
  const own = (p.extra?.allow?.length ?? 0) + (p.extra?.ask?.length ?? 0) + (p.extra?.deny?.length ?? 0)
  return [
    by('allow').length ? `${T.permStates.allow}: ${by('allow').join(', ')}` : '',
    by('ask').length ? `${T.permStates.ask}: ${by('ask').join(', ')}` : '',
    by('deny').length ? `${T.permStates.deny}: ${by('deny').join(', ')}` : '',
    own ? T.permOwnCount(own) : '',
  ].filter(Boolean).join(' · ') || T.permNothingSet
}

// The lines below filled in from what the user wrote: a guess, shown for them
// to check before saving (nothing is asked of any model). Each clause says
// one thing ("commit, but never push"): a "no" in it forbids what it names.
const CUES = {
  history: /\bforce\b|\bforzar\b|--force|reset\s+--hard|reescrib\w*\s+(?:la\s+)?historia|rewrit\w*\s+(?:the\s+)?history|\brebase\b/i,
  push: /\bpush\w*\b|\bsub(?:ir|an|e)\s+(?:los\s+)?cambios\b|\bsubir\s+(?:a|al)\s+(?:remoto|github|gitlab|origin)\b/i,
  commit: /\bcommit\w*\b|\bcomite\w*\b/i,
  install: /\bdependenc\w*|\binstal\w*\s+(?:paquetes|librer[ií]as|dependencias)|\binstall\w*\s+(?:packages|dependencies|libraries)|\bnpm\s+install\b|\bpip\s+install\b/i,
  tests: /\btests?\b|\btesting\b|\bpruebas?\b|\bcompil\w*|\bbuild\w*\b|\blint\w*\b/i,
  edit: /\bedit\w*\b|\bmodific\w*\b|\bescrib\w*\s+(?:c[oó]digo|ficheros|archivos)|\bcambi\w*\s+(?:el\s+)?(?:c[oó]digo|ficheros|archivos)|\bwrite\s+(?:code|files)|\bchange\s+(?:the\s+)?(?:code|files)/i,
  remove: /\b(?:borr|elimin)\w*\s+(?:ficheros|archivos|carpetas|files)|\b(?:delete|remove)\s+(?:files|folders)|\brm\b/i,
  web: /\bweb\b|\binternet\b|\bnaveg\w*|\bbrows\w*|\bonline\b/i,
  docker: /\bdocker\w*\b|\bcontenedor\w*|\bcontainers?\b/i,
  sudo: /\bsudo\b|\broot\b|\badministrador\w*\b|\badmin\s+rights\b/i,
}
const NEG = /\b(?:no|nunca|jam[aá]s|ni|sin|prohib\w*|never|not|don['’]?t|doesn['’]?t|cannot|can['’]?t|mustn['’]?t|forbid\w*|nothing)\b/i
const ASK = /\bpregunt\w*|\bconsult\w*|\bpid\w*\s+permiso|\bcon\s+permiso|\bpermiso\s+(?:antes|primero)|\bask\w*\b|\bwith\s+permission|\bconfirm\w*/i
export function guessCaps(text) {
  const out = {}
  const clauses = String(text ?? '').split(/[.;,:\n!?]+|\s+(?:pero|aunque|sino|excepto|salvo|but|except|although|though)\s+/i)
  for (const clause of clauses) {
    const found = Object.keys(CUES).filter(c => CUES[c].test(clause))
    // ("never force push" is about rewriting history, not about pushing.)
    const caps = found.includes('history') ? found.filter(c => c !== 'push') : found
    if (!caps.length) continue
    const st = NEG.test(clause) ? 'deny' : ASK.test(clause) ? 'ask' : 'allow'
    for (const c of caps) out[c] = st
  }
  return out
}

const call = (what, body) => post(inCompany(`/api/permissions/${what}`), body)
  .catch(err => { throw Object.assign(new Error(err.message.replace(/^(Bad Request|Conflict|Forbidden): /, '')), { status: err.status }) })
const lines = v => String(v ?? '').split('\n').map(l => l.trim()).filter(Boolean)

// Settings › Agent permissions: the profiles, who follows each, and how to
// change them.
export function permissionsTab(body, fail) {
  const usedBy = id => Object.values(state.permissions?.teams ?? {}).filter(x => x === id).length + Object.values(state.permissions?.sessions ?? {}).filter(x => x === id).length
  const machines = [...hosts.values()]
  const takes = machines.map(h => [h, h.info?.permission_profiles ?? null])
  const row = p => `<tr data-profile="${esc(p.id)}"><td><b>${esc(profileName(p))}</b>${p.builtin ? ` <span class="tag">${esc(T.permBuiltinTag)}</span>` : ''}<br><span class="note">${esc(profileSummary(p))}</span>${usedBy(p.id) ? `<br><span class="note">${esc(T.permUsedBy(usedBy(p.id)))}</span>` : ''}</td>
      <td class="perm-acts">${p.builtin ? `<button type="button" class="btn" data-copy-profile="${esc(p.id)}">${esc(T.permCopy)}</button>` : `<button type="button" class="btn" data-edit-profile="${esc(p.id)}">${esc(T.permEdit)}</button><button type="button" class="btn danger" data-delete-profile="${esc(p.id)}">${esc(T.permDelete)}</button>`}</td></tr>`
  body.innerHTML = `<p class="note">${esc(T.permIntro)}</p>
    <table class="people perm-list"><tbody>${profiles().map(row).join('')}</tbody></table>
    <p><button type="button" class="btn primary" data-new-profile>${esc(T.permNew)}</button></p>
    <h4>${esc(T.permMachinesH)}</h4><div class="set-card"><p class="note">${T.permMachinesHint}</p>
      ${takes.length ? `<table class="people"><tbody>${takes.map(([h, t]) => `<tr><td>${esc(h.name)}</td><td><span class="note">${esc(T.permTakes[t ?? 'old'])}</span></td></tr>`).join('')}</tbody></table>` : `<p class="note">${esc(T.permNoMachines)}</p>`}</div>`
  body.onclick = e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.newProfile != null) return profileDialog(null)
    if (b.dataset.copyProfile) { const p = profileById(b.dataset.copyProfile); return profileDialog({ ...p, id: null, builtin: false, name: `${profileName(p)} (${T.permCopyWord})` }) }
    if (b.dataset.editProfile) return profileDialog(profileById(b.dataset.editProfile))
    if (b.dataset.deleteProfile) {
      const p = profileById(b.dataset.deleteProfile)
      return confirmDialog({ title: T.permDeleteTitle(profileName(p)), text: esc(T.permDeleteText(usedBy(p.id))), confirm: T.permDelete, danger: true, run: () => call('delete', { id: p.id }).catch(err => { fail(err); throw err }) })
    }
  }
}

// A profile, new or changed: in the user's words, then each capability, then
// rules of its own.
export function profileDialog(p) {
  const v = p ?? { id: null, name: '', notes: '', caps: {}, extra: { allow: [], ask: [], deny: [] } }
  const select = c => `<select name="cap-${c}" data-cap="${c}">${STATES.map(st => `<option value="${st}" ${(v.caps?.[c] ?? 'default') === st ? 'selected' : ''}>${esc(T.permStates[st])}</option>`).join('')}</select>`
  const d = dialog(`<h3>${esc(v.id ? T.permEditTitle(profileName(v)) : T.permNew)}</h3>
    <div class="perm-dialog">
      <label class="field"><span>${esc(T.permName)}</span><input name="name" maxlength="40" value="${esc(v.name ?? '')}" required></label>
      <label class="field"><span>${esc(T.permNotes)}</span><textarea name="notes" rows="3" maxlength="2000" placeholder="${esc(T.permNotesPlaceholder)}">${esc(v.notes ?? '')}</textarea></label>
      <p class="note perm-fillrow"><button type="button" class="btn" data-fill>${esc(T.permFill)}</button> <span data-filled>${esc(T.permNotesHint)}</span></p>
      <h4>${esc(T.permCapsH)}</h4>
      <table class="people perm-caps"><tbody>${CAPS.map(c => `<tr><td><label for="cap-${c}-${v.id ?? 'new'}">${esc(T.permCaps[c])}</label><br><span class="note">${esc(T.permCapHint[c])}</span></td><td>${select(c).replace('<select ', `<select id="cap-${c}-${v.id ?? 'new'}" `)}</td></tr>`).join('')}</tbody></table>
      <details class="perm-own"${(v.extra?.allow?.length || v.extra?.ask?.length || v.extra?.deny?.length) ? ' open' : ''}><summary>${esc(T.permOwnRules)}</summary>
        <p class="note">${esc(T.permOwnHint)}</p>
        ${['allow', 'ask', 'deny'].map(k => `<label class="field"><span>${esc(T.permStates[k])}</span><textarea name="own-${k}" rows="2" class="mono" spellcheck="false">${esc((v.extra?.[k] ?? []).join('\n'))}</textarea></label>`).join('')}
      </details>
      <p class="note">${esc(T.permAppliesWhen)}</p>
    </div>
    <div class="err" role="alert"></div>
    <div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="button" class="btn primary" data-save>${esc(T.save)}</button></div>`, { wide: true })
  const f = n => d.el.querySelector(`[name="${n}"]`)
  f('name').focus()
  d.el.querySelector('[data-fill]').onclick = () => {
    const g = guessCaps(f('notes').value)
    for (const [c, st] of Object.entries(g)) f(`cap-${c}`).value = st
    for (const c of CAPS) f(`cap-${c}`).closest('tr').classList.toggle('perm-filled', c in g)
    d.el.querySelector('[data-filled]').textContent = Object.keys(g).length ? T.permFilled(Object.keys(g).length) : T.permFillNone
  }
  const save = async () => {
    const btn = d.el.querySelector('[data-save]')
    btn.disabled = true
    try {
      await call('save', {
        ...(v.id ? { id: v.id } : {}),
        name: f('name').value,
        notes: f('notes').value,
        caps: Object.fromEntries(CAPS.map(c => [c, f(`cap-${c}`).value]).filter(([, st]) => st !== 'default')),
        extra: { allow: lines(f('own-allow').value), ask: lines(f('own-ask').value), deny: lines(f('own-deny').value) },
      })
      d.close()
    } catch (err) {
      d.el.querySelector('.err').textContent = err.message
      btn.disabled = false
    }
  }
  d.el.querySelector('[data-save]').onclick = save
  f('name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save() } })
}

// Which profile a team follows ({ coordinator }) or one session ({ session }).
export function assignDialog(target) {
  const team = target.coordinator ?? null
  const s = target.session ? sessions.get(target.session) : null
  const current = team ? state.permissions?.teams?.[team] ?? '' : state.permissions?.sessions?.[target.session] ?? ''
  const teamOf = s ? ((s.role ?? s.opened_role) === 'coordinator' ? s.name : s.coordinator) : null
  const inherited = teamOf ? teamProfile(teamOf) : null
  const options = [
    ...(team ? [['', T.permNone]] : [['', T.permFromTeam(inherited ? profileName(inherited) : null)], [NONE, T.permNone]]),
    ...profiles().map(p => [p.id, profileName(p)]),
  ]
  const d = dialog(`<h3>${esc(T.permAssignTitle(team ? (state.squadMeta.get(team)?.title || team) : target.session))}</h3>
    <label class="field"><span>${esc(T.permProfile)}</span><select name="profile">${options.map(([id, label]) => `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
    <p class="note" data-summary></p>
    <p class="note">${esc(team ? T.permAssignTeamHint : T.permAssignSessionHint)} ${esc(T.permAppliesWhen)}</p>
    <div class="err" role="alert"></div>
    <div class="actions"><button type="button" class="btn plain" data-cancel>${esc(T.cancel)}</button><button type="button" class="btn primary" data-ok>${esc(T.save)}</button></div>`)
  const sel = d.el.querySelector('[name=profile]')
  const show = () => { d.el.querySelector('[data-summary]').textContent = sel.value === NONE ? T.permNoProfile : sel.value ? profileSummary(profileById(sel.value)) : team ? T.permNoProfile : profileSummary(inherited) }
  sel.onchange = show
  show()
  sel.focus()
  d.el.querySelector('[data-ok]').onclick = async () => {
    try {
      await call('assign', team ? { coordinator: team, profile: sel.value } : { session: target.session, profile: sel.value })
      d.close()
    } catch (err) { d.el.querySelector('.err').textContent = err.message }
  }
}

// A section for the side of a team's page or a session's: what it follows,
// and (for a manager) a button to change it.
export function permissionsSection({ coordinator, session }) {
  const s = session ? sessions.get(session) : null
  const { profile, from } = coordinator ? { profile: teamProfile(coordinator), from: 'team' } : profileOf(s)
  const running = s ? [...hosts.values()].flatMap(h => h.info?.terminals ?? []).find(t => t.id === s.name) : null
  const said = profile ? (from === 'team' && session ? T.permFollowsTeam(profileName(profile)) : T.permFollows(profileName(profile))) : T.permNoProfile
  return `<section class="perm-side"><h3 class="tq-label">${esc(T.tqPermissions)}</h3><p class="tq-small">${esc(said)}</p>${profile ? `<p class="tq-small sv-quiet">${esc(profileSummary(profile))}</p>` : ''}${running?.profile && running.profile !== profile?.name ? `<p class="tq-small sv-quiet">${esc(T.permRunningWith(running.profile))}</p>` : ''}
    ${can('manager') ? `<button type="button" class="btn quiet tq-act" data-perm-assign="${esc(coordinator ?? '')}" data-perm-session="${esc(session ?? '')}">${esc(T.permChange)}</button>` : ''}</section>`
}
// (Wired once, wherever such a section is drawn.)
document.addEventListener('click', e => {
  const b = e.target.closest('[data-perm-assign]')
  if (!b) return
  assignDialog(b.dataset.permAssign ? { coordinator: b.dataset.permAssign } : { session: b.dataset.permSession })
})
