import { $ } from './dom.js'
import { T } from './i18n.js'
import { hosts, hostListeners, can } from './state.js'
import { esc, hhmm, now } from './format.js'
import { postJson, folderChips, addFolderDialog } from './machines.js'
import { newSessionDialog } from './squads.js'
import { currentRoute } from './router.js'

// A new machine, in one page: its name, the command to run on it, waiting for
// it to connect, and what to do once it has. The whole way is in sight from
// the start (what is not yet due, dimmed), and the page follows by itself.
// It survives going elsewhere and coming back: the code it made is kept.

let draft = null // { name, plugin, enroll, os, home, root, osUser, joined, error, generating, slowTimer, slow }
const fresh = () => ({ name: '', plugin: false, enroll: null, os: /Mac/i.test(navigator.platform) ? 'macos' : /Win/i.test(navigator.platform) ? 'windows' : 'linux', home: false, root: false, osUser: '', joined: null, error: '', generating: false, slow: false })

const expired = () => draft.enroll && !draft.joined && draft.enroll.expires_at < now()
const cmdRow = text => `<div class="cmdrow"><pre class="cmd">${esc(text)}</pre><button type="button" class="btn" data-copy>${esc(T.copy)}</button></div>`
const step = (n, done, label) => `<li class="nt-step${done ? ' done' : ''}"><b aria-hidden="true">${done ? '✓' : n}</b>${esc(label)}${done ? `<span class="sr-only"> · ${esc(T.fsDone)}</span>` : ''}</li>`

function installHtml() {
  const r = draft.enroll
  const os = draft.os
  const insecure = /^http:\/\//.test(r.server_url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(r.server_url)
  const extra = (draft.home ? ' --allow-home' : '') + (draft.root && os !== 'macos' ? ' --allow-root' : '') + (insecure ? ' --insecure' : '')
  // (A new system user needs root: the installer does the rest as that user.)
  const withUser = text => (os === 'linux' && draft.osUser ? `${text.replace('&& bash install.sh', '&& sudo bash install.sh')} --os-user=${draft.osUser}` : text)
  const advanced = draft.home || draft.root || draft.osUser
  return `<div class="am-os"><span>${esc(T.osPick)}</span><span class="seg" role="group" aria-label="${esc(T.osPick)}">${['linux', 'macos', 'windows'].map(o => `<button type="button" data-os="${o}" aria-pressed="${o === os}"${o === os ? ' class="on"' : ''}>${{ linux: 'Linux', macos: 'macOS', windows: 'Windows' }[o]}</button>`).join('')}</span></div>
    <p class="am-run">${T.runOn(os)}</p>${cmdRow(withUser(String(r.install?.[os] ?? '') + extra))}
    <p class="am-note">${T.runWhat}${os === 'windows' ? ` ${T.windowsNote}` : ''}</p>
    ${insecure ? `<p class="am-note am-warn">${esc(T.httpWarn)}</p>` : ''}
    <p class="am-note">${esc(T.codeValid(hhmm(r.expires_at)))}</p>
    <details class="am-adv"${advanced ? ' open' : ''}><summary>${esc(T.amAdvanced)}</summary>
      ${os === 'linux' ? `<label class="field"><span>${T.osUser}</span><input type="text" data-osuser value="${esc(draft.osUser)}" maxlength="32" autocomplete="off"><span class="hint">${T.osUserHint}</span></label>` : ''}
      <label class="check"><input type="checkbox" data-home ${draft.home ? 'checked' : ''}> <span>${T.allowHome}</span></label>
      ${os === 'macos' ? '' : `<label class="check"><input type="checkbox" data-root ${draft.root ? 'checked' : ''}> <span>${T.allowRoot}</span></label>`}
      ${os === 'windows' ? '' : `<p class="am-note">${T.manualCmd}</p>${cmdRow(String(r.command ?? '') + extra)}`}
    </details>`
}

function connectHtml() {
  if (draft.joined) return `<p class="am-wait ok" role="status"><span class="dot ok" aria-hidden="true"></span><span>${T.machineJoined(esc(draft.joined.name)).replace(/^✓\s*/, '')}</span></p>`
  if (expired()) return `<p class="am-wait bad" role="status">${esc(T.amExpired)}</p><button type="button" class="btn" data-again>${esc(T.amAnother)}</button>`
  return `<p class="am-wait" role="status"><span class="dot info pulse" aria-hidden="true"></span><span>${esc(T.waitingMachine)}</span></p>${draft.slow ? `<p class="am-note">${esc(T.amSlow)}</p>` : ''}`
}

function readyHtml() {
  const h = hosts.get(draft.joined.id) ?? draft.joined
  return `<p class="am-note">${T.amAfterJoin}</p>
    <div class="card am-folders"><b>${esc(T.amFolders)}</b><div>${folderChips(h)}</div></div>
    <div class="nt-actions">${can('operator') ? `<button type="button" class="btn" data-amsession>${esc(T.newSession)}</button><a class="btn primary" href="#/new" data-amdone>${esc(T.amNewTeam)}</a>` : `<a class="btn primary" href="#/hosts" data-amdone>${esc(T.amToMachines)}</a>`}</div>`
}

export function renderAddMachine() {
  draft ??= fresh()
  const box = $('addmachine')
  // (Typing in a field of the page: redrawn around it, never over it.)
  const keep = document.activeElement?.closest?.('#addmachine') ? document.activeElement.dataset?.osuser !== undefined ? 'osuser' : document.activeElement.name : null
  const made = !!draft.enroll
  const joined = !!draft.joined
  const ready = joined && !!(hosts.get(draft.joined.id) ?? draft.joined).info?.folders?.length
  box.innerHTML = `<div class="nt am">
    <ol class="nt-steps" aria-label="${esc(T.addTitle)}">${step(1, made, T.amNameStep)}${step(2, made && joined, T.amInstallStep)}${step(3, joined, T.amConnectStep)}${step(4, ready, T.amReadyStep)}</ol>
    <section class="nt-sec"><h2>${esc(T.amNameStep)}</h2><p class="am-note am-intro">${esc(T.addIntro)}</p>
      <label class="field"><span>${esc(T.machineName)}</span><input type="text" name="amname" maxlength="40" value="${esc(draft.name)}" placeholder="${esc(T.machineNameHint)}" autocomplete="off" ${made ? 'disabled' : ''}></label>
      <label class="check"><input type="checkbox" name="amplugin" ${draft.plugin ? 'checked' : ''} ${made ? 'disabled' : ''}> <span>${T.configurePlugin}</span></label>
      ${draft.error ? `<p class="nt-issues" role="alert">${esc(draft.error)}</p>` : ''}
      ${made ? '' : `<div class="nt-actions"><button type="button" class="btn primary" data-gen ${draft.generating ? 'disabled' : ''}>${esc(T.generate)}</button></div>`}
    </section>
    <section class="nt-sec${made ? '' : ' later'}"${made ? '' : ' aria-disabled="true"'}><h2>${esc(T.amInstallStep)}</h2>${made ? installHtml() : `<p class="am-note">${esc(T.amInstallLater)}</p>`}</section>
    <section class="nt-sec${made ? '' : ' later'}"><h2>${esc(T.amConnectStep)}</h2>${made ? connectHtml() : `<p class="am-note">${esc(T.amConnectLater)}</p>`}</section>
    <section class="nt-sec${joined ? '' : ' later'}" data-ready><h2>${esc(T.amReadyStep)}</h2>${joined ? readyHtml() : `<p class="am-note">${esc(T.amReadyLater)}</p>`}</section>
  </div>`
  if (keep === 'osuser') box.querySelector('[data-osuser]')?.focus()
  else if (keep) box.querySelector(`[name="${keep}"]`)?.focus()
  else if (!made && currentRoute().view === 'addmachine' && !document.activeElement?.closest?.('#addmachine')) box.querySelector('[name=amname]')?.focus({ preventScroll: true })
}
export const refreshAddMachine = () => { if (currentRoute().view === 'addmachine' && !$('addmachine').hidden) renderAddMachine() }
// Done with it (a session or team opened from it, or cancelled): the next visit starts afresh.
export const forgetAddMachine = () => { clearTimeout(draft?.slowTimer); draft = null }

async function generate() {
  draft.generating = true
  draft.error = ''
  renderAddMachine()
  try {
    draft.enroll = await postJson('/api/hosts/enroll', { name: draft.name.trim(), configure_plugin: draft.plugin })
    draft.joined = null
    draft.slow = false
    clearTimeout(draft.slowTimer)
    // A minute without it: some help, where the waiting is.
    const mine = draft
    draft.slowTimer = setTimeout(() => { if (draft === mine && !mine.joined) { mine.slow = true; refreshAddMachine() } }, 60_000)
  } catch (err) { draft.error = err.message }
  draft.generating = false
  renderAddMachine()
  $('addmachine').querySelector('.cmd')?.closest('section')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

// The machine that used this page's code (only that one) connected.
hostListeners.add(h => {
  if (draft?.joined && h.id === draft.joined.id) return refreshAddMachine() // its folders, as they change
  if (!draft?.enroll || draft.joined || h.removed || !h.online || h.enrollment !== draft.enroll.enrollment) return
  draft.joined = h
  clearTimeout(draft.slowTimer)
  refreshAddMachine()
  $('addmachine').querySelector('[data-ready]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
})
document.addEventListener('click', e => { if (e.target.closest?.('[data-amcancel]')) forgetAddMachine() })

const box = $('addmachine')
box.addEventListener('input', e => {
  if (e.target.name === 'amname') draft.name = e.target.value
})
box.addEventListener('change', e => {
  const t = e.target
  if (t.name === 'amplugin') draft.plugin = t.checked
  else if (t.matches('[data-home]')) { draft.home = t.checked; renderAddMachine() }
  else if (t.matches('[data-root]')) { draft.root = t.checked; renderAddMachine() }
  else if (t.matches('[data-osuser]')) { draft.osUser = /^[a-z_][a-z0-9_-]{0,31}$/.test(t.value) ? t.value : ''; renderAddMachine() }
})
box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.name === 'amname' && !draft.enroll) { e.preventDefault(); void generate() } })
box.addEventListener('click', async e => {
  const t = e.target
  if (t.closest('[data-gen]')) return generate()
  if (t.closest('[data-again]')) { draft.enroll = null; return generate() }
  const os = t.closest('[data-os]')
  if (os) { draft.os = os.dataset.os; return renderAddMachine() }
  const copy = t.closest('[data-copy]')
  if (copy) {
    const pre = copy.parentElement.querySelector('.cmd')
    try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = T.copied } catch {
      const range = document.createRange(); range.selectNodeContents(pre)
      getSelection().removeAllRanges(); getSelection().addRange(range)
    }
    return
  }
  const add = t.closest('[data-hact="addfolder"]')
  if (add) return addFolderDialog(add.dataset.h, refreshAddMachine)
  if (t.closest('[data-amsession]')) { const id = draft.joined.id; forgetAddMachine(); location.hash = '#/hosts'; return newSessionDialog(id) }
  if (t.closest('[data-amdone]')) forgetAddMachine()
})
