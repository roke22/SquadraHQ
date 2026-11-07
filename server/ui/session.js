import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, sessions, hosts } from './state.js'
import { esc, kfmt } from './format.js'
import { sortedSessions, status } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'

// Beside a session's conversation: its team, and where and how it runs.

const when = t => new Date(t).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })

function member(s, here) {
  const st = status(s)
  const role = s.role === 'coordinator' ? 'coord' : 'worker'
  return `<li><a href="#/s/${encodeURIComponent(s.name)}" class="sv-member${s.name === here ? ' on' : ''}${s.online ? '' : ' offline'}"${s.name === here ? ' aria-current="page"' : ''}><span class="role ${role}" aria-hidden="true"></span><span class="sr-only">${esc(T.roleName[s.role] ?? '')}</span><span class="sv-mname">${esc(s.name)}</span><span class="dot ${st.dot || 'off'}" aria-hidden="true"></span><span class="sv-mwhat">${esc(st.text)}</span></a></li>`
}

export function renderSessionAside() {
  const box = $('session').querySelector('.sv-info')
  const r = currentRoute()
  if (!box || r.view !== 'session') return
  const s = sessions.get(r.name)
  if (!s) { setHtml(box, ''); return }
  const a = s.activity ?? {}
  const team = s.role === 'coordinator' ? s.name : s.coordinator
  const members = team ? sortedSessions().filter(x => x.name === team || x.coordinator === team) : []
  const h = hosts.get(s.host_id)
  const facts = [
    [T.svMachine, h ? `<a class="ibx-link" href="#/h/${encodeURIComponent(h.id)}">${esc(h.name)}</a>` : ''],
    [T.svFolder, a.cwd ? `<span class="sv-mono">${esc(a.cwd)}</span>` : ''],
    [T.svContext, a.context_tokens ? esc(T.context(kfmt(a.context_tokens)) + (a.context_pct != null ? ` (${T.contextPct(a.context_pct)})` : '')) : ''],
    [T.svPersona, s.persona?.name ? esc(s.persona.name) : ''],
    [T.svOpened, s.created_at ? esc(when(s.created_at * 1000)) : ''],
  ].filter(f => f[1])
  setHtml(box, `${members.length ? `<section><h2 class="tq-label">${esc(T.svTeam)}</h2><ul class="sv-members">${members.map(m => member(m, s.name)).join('')}</ul><a class="ibx-link sv-small" href="#/q/${encodeURIComponent(team)}">${esc(T.svSeeTeam)}</a></section>` : ''}
    ${facts.length ? `<section><h2 class="tq-label">${esc(T.svDetails)}</h2><dl class="ibx-facts sv-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></section>` : ''}
    ${a.observe === 'off' ? `<p class="sv-small sv-quiet">${esc(T.svNotObserved)}</p>` : ''}`)
}
export const refreshSessionAside = () => { if (currentRoute().view === 'session' && !$('session').hidden) renderSessionAside() }
