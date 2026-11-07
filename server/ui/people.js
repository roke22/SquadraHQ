import { $, store } from './dom.js'
import { T, LOCALE, LANG } from './i18n.js'
import { state, can } from './state.js'
import { call, inCompany } from './api.js'
import { esc } from './format.js'
import { alertBox } from './mosaic.js'
import { icon } from './icons.js'
import { themeChoice, setTheme, onTheme } from './theme.js'

const ROLES = ['observer', 'operator', 'manager', 'owner']
// Only owners give or take the role of owner.
const grantable = () => ROLES.filter(r => r !== 'owner' || can('owner'))
const roleSelect = (value, attrs = '') => `<select ${attrs}>${grantable().map(r => `<option value="${r}" ${r === value ? 'selected' : ''}>${esc(T.roles[r])}</option>`).join('')}</select>`
const fmtTime = ms => new Date(ms).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
const linkBox = l => `<div class="cmdrow"><pre class="cmd">${esc(l.link)}</pre><button class="btn" data-copy>${esc(T.copy)}</button></div><p class="note">${esc(T.linkOnce)}</p>`

// Settings: over the whole dashboard, without its sidebar, in three groups by
// whom they affect: you, this company, the whole server. Only what this
// user's role allows is there. Esc, or the button at the top, closes them.
let closeOpen = null
export function openSettings(start) {
  closeOpen?.()
  const admin = state.me?.user.is_platform_admin
  const manager = can('manager')
  const here = state.me?.companies.find(c => c.id === state.company)
  const groups = [
    [T.setMine, [['account', T.setProfile], ['appearance', T.setAppearance]]],
    ...(manager && here ? [[here.name, [['members', T.people], ['company', T.tabCompany]]]] : []),
    ...(admin ? [[T.setServer, [['companies', T.tabCompanies], ['users', T.tabUsers], ['machines', T.tabMachines]]]] : []),
  ]
  const tabs = groups.flatMap(g => g[1])
  const root = $('settings')
  const opener = document.activeElement
  root.innerHTML = `<div class="settings" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <aside class="settings-side"><nav class="settings-nav" aria-label="${esc(T.settingsSections)}">
        ${groups.map(([title, items]) => `<div class="settings-group"><div class="settings-group-h">${esc(title)}</div>${items.map(([k, label]) => `<button type="button" data-tab="${k}">${esc(label)}</button>`).join('')}</div>`).join('')}
        <div class="settings-sep"></div>
        <button type="button" class="settings-out" data-logout>${icon('logout')}${esc(T.logout)}</button>
      </nav></aside>
      <div class="settings-body"><div class="settings-content">
        <h2 class="settings-title" id="settingsTitle"></h2>
        <div class="err" role="alert"></div><div data-body></div>
      </div></div>
      <button type="button" class="settings-close" data-close aria-label="${esc(T.closeSettings)}"><span class="x">${icon('close')}</span><kbd>Esc</kbd></button>
    </div>`
  root.hidden = false
  $('app').inert = true
  const d = { el: root }
  const stopTheme = onTheme(() => { if (current === 'appearance') { current = null; show('appearance') } })
  function close() {
    root.hidden = true
    root.innerHTML = ''
    $('app').inert = false
    stopTheme()
    document.removeEventListener('keydown', keys, true)
    closeOpen = null
    if (opener?.isConnected) opener.focus()
  }
  closeOpen = close
  // Esc closes it, unless a dialog or menu is open over it; Tab stays inside.
  function keys(e) {
    if (root.hidden) return
    if (e.key === 'Escape' && !document.querySelector('.modal-bg, .menu') && $('palette').hidden) { e.preventDefault(); close() }
    if (e.key === 'Tab' && !document.querySelector('.modal-bg')) {
      const f = [...root.querySelectorAll('button, [href], input, select, textarea')].filter(x => !x.disabled && x.offsetParent)
      if (!f.length) return
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus() }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus() }
    }
  }
  document.addEventListener('keydown', keys, true)
  root.querySelector('[data-close]').onclick = close
  root.querySelector('[data-logout]').onclick = async () => { close(); (await import('./app.js')).logOut() }
  const body = d.el.querySelector('[data-body]')
  const fail = err => { d.el.querySelector('.err').textContent = err.status === 429 ? T.tooManyTries : err.message.replace(/^(Unauthorized|Bad Request|Not Found|Conflict|Forbidden): /, '') }
  const ok = () => { d.el.querySelector('.err').textContent = '' }

  // Only what was asked for last is drawn, and a tab already open isn't drawn
  // again: what is being typed in it stays.
  let current = null
  let drawing = 0
  async function show(tab) {
    if (tab === current) return
    current = tab
    ok()
    for (const b of d.el.querySelectorAll('[data-tab]')) {
      b.classList.toggle('on', b.dataset.tab === tab)
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current')
    }
    root.querySelector('#settingsTitle').textContent = tabs.find(t => t[0] === tab)?.[1] ?? ''
    try { await ({ members, company, companies, users, machines, account, appearance })[tab]() } catch (err) { fail(err) }
  }

  // How the dashboard looks to you, in this browser.
  function appearance() {
    drawing++
    const choice = themeChoice()
    const seg = (name, value, label, on) => `<button type="button" data-${name}="${value}" aria-pressed="${on}"${on ? ' class="on"' : ''}>${esc(label)}</button>`
    body.innerHTML = `<div class="settings-row"><b id="themeLbl">${esc(T.theme)}</b><div class="seg" role="group" aria-labelledby="themeLbl">${[['system', T.themeSystem], ['light', T.themeLight], ['dark', T.themeDark]].map(([v, l]) => seg('theme', v, l, v === choice)).join('')}</div></div>
      <div class="settings-row"><b id="langLbl">${esc(T.language)}</b><div class="seg" role="group" aria-labelledby="langLbl">${[['en', 'English'], ['es', 'Español']].map(([v, l]) => seg('lang', v, l, v === LANG)).join('')}</div></div>
      <p class="note settings-ver">${esc(document.querySelector('.ver')?.textContent ?? '')}</p>`
    for (const b of body.querySelectorAll('[data-theme]')) b.onclick = () => setTheme(b.dataset.theme)
    for (const b of body.querySelectorAll('[data-lang]')) b.onclick = () => { if (b.dataset.lang !== LANG) { store.set('squadraLang', b.dataset.lang); location.reload() } }
  }

  async function members() {
    const turn = ++drawing
    const [list, pending, { join_token }] = await Promise.all([call(inCompany('/api/members')), call(inCompany('/api/invitations')), call(inCompany('/api/join-token'))])
    if (turn !== drawing) return
    // What can't be changed is only shown: someone else's owner, or the only owner.
    const owners = list.filter(m => m.role === 'owner').length
    const fixed = m => m.role === 'owner' && (!can('owner') || owners < 2)
    body.innerHTML = `<table class="people"><tbody>${list.map(m => `<tr><td><b>${esc(m.name)}</b><br><span class="note">${esc(m.email)}${m.disabled ? ` · ${esc(T.disabled)}` : ''}</span></td>
        <td>${fixed(m) ? esc(T.roles[m.role]) : roleSelect(m.role, `data-role-of="${esc(m.id)}"`)}</td><td>${fixed(m) ? '' : `<button class="btn danger" data-remove="${esc(m.id)}">${esc(T.remove)}</button>`}</td></tr>`).join('')}</tbody></table>
      <h4>${esc(T.inviteTitle)}</h4><div class="set-card"><form data-invite class="people-form"><label class="field"><span>${esc(T.email)}</span><input type="text" name="email" required></label>
        <label class="field"><span>${esc(T.role)}</span>${roleSelect('operator', 'name="role"')}</label>
        <button class="btn primary">${esc(T.invite)}</button></form><div data-link></div></div>
      ${pending.length ? `<h4>${esc(T.pendingInvites)}</h4><table class="people"><tbody>${pending.map(i => `<tr><td>${esc(i.email)} <span class="note">${esc(T.roles[i.role] ?? i.role)}</span></td><td><button class="btn danger" data-cancel-invite="${esc(i.id)}">${esc(T.cancelInvite)}</button></td></tr>`).join('')}</tbody></table>` : ''}
      <h4>${esc(T.joinToken)}</h4><div class="set-card"><p class="note">${esc(T.joinTokenHint)}</p>
      <div class="cmdrow"><pre class="cmd">${esc(join_token)}</pre><button class="btn" data-copy>${esc(T.copy)}</button></div>
      <button class="btn danger" data-rotate>${esc(T.rotate)}</button></div>`
    body.querySelector('[data-invite]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        const r = await call(inCompany('/api/members/invite'), Object.fromEntries(new FormData(e.target)))
        await members()
        body.querySelector('[data-link]').innerHTML = linkBox(r)
      } catch (err) { fail(err) }
    }
    for (const s of body.querySelectorAll('[data-role-of]')) {
      s.onchange = async () => {
        ok()
        try { await call(inCompany('/api/members/role'), { user: s.dataset.roleOf, role: s.value }) } catch (err) { fail(err); await members() }
      }
    }
  }

  // Who did what here; and, for its owners, how long things are kept, and the
  // company as a file, or deleted.
  async function company() {
    const turn = ++drawing
    const [log, kept] = await Promise.all([call(inCompany('/api/company/audit?limit=50')), call(inCompany('/api/company/retention'))])
    if (turn !== drawing) return
    const here = state.me.companies.find(c => c.id === state.company)
    const rows = log.map(e => `<tr><td><span class="note">${esc(fmtTime(e.at))}</span></td><td>${esc(e.who ?? '—')}</td><td>${esc(e.action)}${e.target ? ` · ${esc(e.target)}` : ''}</td></tr>`).join('')
    body.innerHTML = `<h4>${esc(T.auditTitle)}</h4>${rows ? `<table class="people audit"><tbody>${rows}</tbody></table>` : `<p class="note">${esc(T.auditEmpty)}</p>`}
      ${can('owner') ? `<h4>${esc(T.retentionTitle)}</h4>
      <div class="set-card"><form data-retention class="people-form"><label class="field"><span>${esc(T.retentionDays)}</span><input type="text" inputmode="numeric" name="retention_days" value="${esc(kept.retention_days)}"></label>
        <label class="field"><span>${esc(T.eventHours)}</span><input type="text" inputmode="numeric" name="event_hours" value="${esc(kept.event_hours)}"></label>
        <button class="btn primary">${esc(T.save)}</button></form><p class="note" data-saved></p></div>
      <h4>${esc(T.exportTitle)}</h4><div class="set-card set-row"><p class="note">${esc(T.exportHint)}</p>
      <a class="btn" href="${esc(inCompany('/api/company/export'))}" download>${esc(T.exportBtn)}</a></div>
      ${state.company === 'default' ? '' : `<h4>${esc(T.deleteCompanyTitle)}</h4><div class="set-card"><p class="note">${esc(T.deleteCompanyHint)}</p>
      <form data-delete-company class="people-form"><label class="field"><span>${esc(T.deleteCompanyConfirm(here?.name ?? ''))}</span><input type="text" name="confirm" autocomplete="off" required></label>
        <button class="btn danger">${esc(T.deleteCompanyBtn)}</button></form></div>`}` : ''}`
    const retention = body.querySelector('[data-retention]')
    if (retention) {
      retention.onsubmit = async e => {
        e.preventDefault()
        ok()
        const v = Object.fromEntries(new FormData(e.target))
        try {
          await call(inCompany('/api/company/retention/set'), { retention_days: Number(v.retention_days), event_hours: Number(v.event_hours) })
          body.querySelector('[data-saved]').textContent = T.saved
        } catch (err) { fail(err) }
      }
    }
    const del = body.querySelector('[data-delete-company]')
    if (del) {
      del.onsubmit = async e => {
        e.preventDefault()
        ok()
        if (new FormData(e.target).get('confirm') !== here?.name) { d.el.querySelector('.err').textContent = T.deleteCompanyWrong; return }
        try {
          await call(inCompany('/api/company/delete'), Object.fromEntries(new FormData(e.target)))
          location.href = location.origin + location.pathname
        } catch (err) { fail(err) }
      }
    }
  }

  async function companies() {
    const turn = ++drawing
    const list = await call('/api/companies')
    if (turn !== drawing) return
    const mine = new Set(state.me.companies.map(c => c.id))
    body.innerHTML = `<table class="people"><tbody>${list.map(c => `<tr><td><b>${esc(c.name)}</b><br><span class="note">${esc(c.id)}${c.status === 'unavailable' ? ` · ${esc(T.unavailable)}` : ''}</span></td>
        <td>${c.status === 'deleting' ? `<span class="note">${esc(T.deletesOn(fmtTime(c.delete_after)))}</span> <button class="btn ok" data-restore="${esc(c.id)}">${esc(T.restore)}</button>` : mine.has(c.id) ? `<a class="btn" href="?company=${encodeURIComponent(c.id)}">${esc(T.openCompany)}</a>` : `<button class="btn" data-join="${esc(c.id)}">${esc(T.joinCompany)}</button>`}</td></tr>`).join('')}</tbody></table>
      <div class="set-card"><form data-create class="people-form"><label class="field"><span>${esc(T.companyName)}</span><input type="text" name="name" required maxlength="80"></label>
        <button class="btn primary">${esc(T.createCompany)}</button></form><div data-link></div></div>`
    body.querySelector('[data-create]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        const r = await call('/api/companies/create', Object.fromEntries(new FormData(e.target)))
        await call('/api/companies/join', { company: r.id })
        state.me.companies.push({ id: r.id, name: r.name, role: 'owner' })
        await companies()
      } catch (err) { fail(err) }
    }
  }

  async function users() {
    const turn = ++drawing
    const [list, links] = await Promise.all([call('/api/users'), call('/api/pending-links')])
    if (turn !== drawing) return
    body.innerHTML = `<table class="people"><tbody>${list.map(u => `<tr><td><b>${esc(u.name)}</b>${u.is_platform_admin ? ` <span class="note">${esc(T.administrator)}</span>` : ''}<br><span class="note">${esc(u.email)}${u.disabled ? ` · ${esc(T.disabled)}` : ''}</span></td>
        <td><button class="btn" data-reset="${esc(u.id)}">${esc(T.resetLink)}</button>
        ${u.id === state.me.user.id ? '' : `<button class="btn ${u.disabled ? 'ok' : 'danger'}" data-${u.disabled ? 'enable' : 'disable'}="${esc(u.id)}">${esc(u.disabled ? T.enable : T.disable)}</button>`}</td></tr>`).join('')}</tbody></table><div data-link></div>
      ${links.length ? `<h4>${esc(T.pendingLinks)}</h4><table class="people"><tbody>${links.map(l => `<tr><td>${esc(l.email)} <span class="note">${esc(l.kind === 'reset' ? T.linkReset : T.linkInvite)} · ${esc(fmtTime(l.expires_at))}</span></td><td><button class="btn danger" data-cancel-link="${esc(l.id)}">${esc(T.cancelInvite)}</button></td></tr>`).join('')}</tbody></table>` : ''}`
  }

  // What runs where: several companies on one machine, and how far apart they are.
  async function machines() {
    const turn = ++drawing
    const list = await call('/api/machines')
    if (turn !== drawing) return
    body.innerHTML = list.length ? `<table class="people"><tbody>${list.map(m => `<tr><td><b>${esc(m.hostname)}</b> <span class="note">${esc(T.machineSessions(m.sessions))}</span><br>
        <span class="note">${esc(T.isolation[m.isolation])}</span>${m.isolation === 'same-user' ? ` <span class="note warn-text">${esc(T.sharedUserWarn)}</span>` : ''}
        ${m.instances.map(i => `<br><span class="dot ${i.online ? 'ok' : ''}"></span> ${esc(i.company_name)} · ${esc(i.name)}${i.os_user ? ` <span class="note">(${esc(i.os_user)})</span>` : ''} <span class="note">${esc(T.instanceSessions(i.sessions, i.max_sessions))}</span>`).join('')}</td></tr>`).join('')}</tbody></table>` : `<p class="note">${esc(T.noMachines)}</p>`
  }

  function account() {
    drawing++
    const me = state.me.user
    const waiting = state.me.deleting ?? []
    body.innerHTML = `<div class="set-card set-me"><span class="set-avatar" aria-hidden="true">${esc((me.name || me.email || '?').trim().charAt(0).toUpperCase())}</span><div><b>${esc(me.name)}</b><span class="note">${esc(me.email)}</span></div></div>
      ${waiting.length ? `<table class="people"><tbody>${waiting.map(c => `<tr><td><b>${esc(c.name)}</b><br><span class="note">${esc(T.deletesOn(fmtTime(c.delete_after)))}</span></td><td><button class="btn ok" data-restore="${esc(c.id)}">${esc(T.restore)}</button></td></tr>`).join('')}</tbody></table>` : ''}
      <h4>${esc(T.passwordTitle)}</h4><div class="set-card"><form data-password class="people-stack"><label class="field"><span>${esc(T.currentPassword)}</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>${esc(T.newPassword)}</span><input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
      <button class="btn primary">${esc(T.setPassword)}</button></form><p class="note" data-done></p></div>`
    body.querySelector('[data-password]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        await call('/auth/password', Object.fromEntries(new FormData(e.target)))
        e.target.reset()
        body.querySelector('[data-done]').textContent = T.passwordSet
      } catch (err) { fail(err) }
    }
  }

  body.addEventListener('click', async e => {
    const b = e.target.closest('button')
    if (!b) return
    ok()
    try {
      if (b.dataset.copy !== undefined) await navigator.clipboard?.writeText(b.previousElementSibling.textContent)
      if (b.dataset.remove) {
        const r = await call(inCompany('/api/members/remove'), { user: b.dataset.remove })
        await members()
        if (r.rotate_join_token) d.el.querySelector('.err').textContent = T.rotateAdvice
      }
      if (b.dataset.cancelLink) { await call('/api/pending-links/cancel', { id: b.dataset.cancelLink }); await users() }
      if (b.dataset.cancelInvite) { await call(inCompany('/api/invitations/cancel'), { id: b.dataset.cancelInvite }); await members() }
      if (b.dataset.rotate !== undefined) { await call(inCompany('/api/join-token/rotate'), {}); await members() }
      if (b.dataset.join) { await call('/api/companies/join', { company: b.dataset.join }); state.me.companies.push({ id: b.dataset.join, role: 'owner' }); await companies() }
      if (b.dataset.restore) { await call('/api/companies/restore', { company: b.dataset.restore }); location.href = `?company=${encodeURIComponent(b.dataset.restore)}` }
      if (b.dataset.reset) {
        const made = await call('/api/users/reset', { user: b.dataset.reset })
        await users()
        body.querySelector('[data-link]').innerHTML = linkBox(made)
      }
      if (b.dataset.disable) {
        const r = await call('/api/users/disable', { user: b.dataset.disable })
        await users()
        if (r.rotate_join_token?.length) alertBox(T.rotateAdviceIn(r.rotate_join_token.join(', ')))
      }
      if (b.dataset.enable) { await call('/api/users/enable', { user: b.dataset.enable }); await users() }
    } catch (err) { fail(err) }
  })
  for (const b of d.el.querySelectorAll('[data-tab]')) b.onclick = () => show(b.dataset.tab)
  const first = tabs.some(t => t[0] === start) ? start : manager && here ? 'members' : admin && !here ? 'companies' : tabs[0][0]
  show(first).then(() => root.querySelector(`[data-tab="${first}"]`)?.focus())
}
export const openPeople = openSettings
