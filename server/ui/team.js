import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, sessions, hosts, can, linksOf } from './state.js'
import { api } from './api.js'
import { esc, now } from './format.js'
import { sortedSessions, status, agentMark } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'
import { permissionsSection } from './permissions.js'

// One team: what it is for, what its workers last reported, who is in it and
// where each runs, the teams it is linked with, and saving it as a template.

const RTF = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' })
function ago(t) {
  const s = Math.round((t - now()) / 1000), a = Math.abs(s)
  return a < 45 ? RTF.format(0, 'second') : a < 3600 ? RTF.format(Math.round(s / 60), 'minute') : a < 86400 ? RTF.format(Math.round(s / 3600), 'hour') : RTF.format(Math.round(s / 86400), 'day')
}
const titleOf = c => state.squadMeta.get(c)?.title || c
const REPORT_TAG = { done: 'ok', blocked: 'err', failed: 'err', question: 'warn' }

// Its workers' final reports, newest first (asked once per team shown, and
// again when a new one may have come).
const reports = new Map() // coordinator -> { at, list }
async function loadReports(coord) {
  const have = reports.get(coord)
  if (have && now() - have.at < 15_000) return
  reports.set(coord, { at: now(), list: have?.list ?? null })
  try {
    const list = await api(`/api/messages?session=${encodeURIComponent(coord)}&limit=300`)
    reports.set(coord, { at: now(), list: list.filter(m => m.report && m.target === coord).reverse().slice(0, 12) })
  } catch { reports.set(coord, { at: now(), list: [] }) }
  if (currentRoute().view === 'team' && currentRoute().squad === coord) renderTeam()
}

function who(s, extra = '') {
  const st = status(s)
  const role = s.role === 'coordinator' ? 'coord' : 'worker'
  const h = hosts.get(s.host_id)
  return `<li><a href="#/s/${encodeURIComponent(s.name)}" class="tq-member${s.online ? '' : ' offline'}"><span class="role ${role}" aria-hidden="true"></span>${agentMark(s)}<span class="sr-only">${esc(T.roleName[s.role] ?? '')}</span>`
    + `<span class="tq-name">${esc(s.name)}</span><span class="dot ${st.dot || 'off'}" aria-hidden="true"></span><span class="tq-where">${esc(h?.name ?? T.tqNoMachine)}</span>${extra}</a></li>`
}

// The plan its coordinator keeps (update_plan): how far it is, and each task.
const TASK_DOT = { todo: 'off', doing: 'info', done: 'ok', blocked: 'err', waiting: 'warn' }
const refLink = ref => {
  let url = null
  try { url = new URL(ref) } catch {}
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? `<a class="ibx-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : `<span class="sv-mono">${esc(ref)}</span>`
}
export function planMeter(plan, big = false) {
  const n = plan.tasks.length
  const count = s => plan.tasks.filter(t => t.state === s).length
  const parts = ['done', 'doing', 'blocked', 'waiting'].map(s => [s, count(s)]).filter(([, c]) => c)
  const say = T.planSays(count('done'), n, count('doing'), count('blocked'), count('waiting'))
  return `<div class="pl-meter${big ? ' big' : ''}" role="img" aria-label="${esc(say)}">${parts.map(([s, c]) => `<i class="pl-${s}" style="width: ${(c / n * 100).toFixed(2)}%"></i>`).join('')}</div>`
}
function planCard(coord) {
  const plan = state.plans.get(coord)
  if (!plan?.tasks.length) return ''
  const count = s => plan.tasks.filter(t => t.state === s).length
  const n = plan.tasks.length
  return `<section class="card tq-card">
      <header class="tq-h"><h2>${esc(plan.title || T.planTitle)}</h2><span class="tq-sub">${esc(T.planBy(coord, ago(plan.updated_at)))}</span></header>
      <div class="tq-body pl-sum">${planMeter(plan, true)}<div class="pl-legend">${[['done', T.planDone(count('done'), n)], ['doing', T.planDoing(count('doing'))], ['blocked', T.planBlocked(count('blocked'))], ['waiting', T.planWaiting(count('waiting'))]].filter(([s]) => count(s)).map(([s, l]) => `<span><i class="pl-key pl-${s}" aria-hidden="true"></i>${esc(l)}</span>`).join('')}</div></div>
      <div class="mc-scroll"><table class="pl-table"><thead><tr><th scope="col">${esc(T.planTask)}</th><th scope="col">${esc(T.planWho)}</th><th scope="col">${esc(T.mcState)}</th><th scope="col">${esc(T.ibxRef)}</th></tr></thead><tbody>
      ${plan.tasks.map(t => `<tr class="pl-row-${t.state}"><td><span class="pl-t">${esc(t.title)}</span>${t.note ? `<span class="pl-note">${esc(t.note)}</span>` : ''}</td>
        <td>${t.who ? `<a class="pl-who" href="#/s/${encodeURIComponent(t.who)}"><span class="role ${sessions.get(t.who)?.role === 'coordinator' ? 'coord' : 'worker'}" aria-hidden="true"></span>${agentMark(t.who)}${esc(t.who)}</a>` : `<span class="tq-quiet0">${esc(T.planNobody)}</span>`}</td>
        <td><span class="mc-state"><span class="dot ${TASK_DOT[t.state]}${t.state === 'doing' ? ' pulse' : ''}" aria-hidden="true"></span>${esc(T.planState[t.state])}</span></td>
        <td>${t.ref ? refLink(t.ref) : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <footer class="pl-foot">${esc(T.planWhose)}</footer>
    </section>`
}

export function renderTeam() {
  const r = currentRoute()
  const coord = sessions.get(r.squad)
  if (!coord) { setHtml($('team'), `<div class="empty"><b>${esc(T.tqGone(r.squad))}</b><a class="btn" href="#/teams">${esc(T.teams)}</a></div>`); return }
  const meta = state.squadMeta.get(coord.name) ?? {}
  const workers = sortedSessions().filter(s => s.role !== 'coordinator' && s.coordinator === coord.name)
  const linked = linksOf(coord.name)
  void loadReports(coord.name)
  const rep = reports.get(coord.name)?.list
  const repHtml = rep == null ? `<p class="tq-quiet">${esc(T.loading)}</p>`
    : rep.length ? `<ul class="tq-reports">${rep.map(m => `<li><a href="#/s/${encodeURIComponent(m.from)}" class="tq-report"><span class="tag ${REPORT_TAG[m.report] ?? ''}">${esc(T.reportWord[m.report] ?? m.report)}</span><span class="role worker" aria-hidden="true"></span><span class="tq-name">${esc(m.from)}</span><span class="tq-text">${esc((m.text ?? '').replace(/\s+/g, ' '))}</span><span class="tq-when">${esc(ago(m.created_at))}</span></a></li>`).join('')}</ul>`
    : `<p class="tq-quiet">${esc(T.tqNoReports)}</p>`
  setHtml($('team'), `<div class="tq">
      <div class="tq-main">
        ${planCard(coord.name)}
        <section class="card tq-card">
          <header class="tq-h"><h2>${esc(T.tqGoal)}</h2>${can('manager') ? `<button type="button" class="btn quiet" data-describe>${esc(T.tqEdit)}</button>` : ''}</header>
          <div class="tq-body">${meta.goal ? `<p class="tq-goal">${esc(meta.goal)}</p>` : `<p class="tq-quiet">${esc(T.tmNoGoal)}</p>`}</div>
        </section>
        <section class="card tq-card">
          <header class="tq-h"><h2>${esc(T.tqReports)}</h2><span class="tq-sub">${esc(T.tqReportsHint)}</span></header>
          ${repHtml}
        </section>
      </div>
      <aside class="tq-aside" aria-label="${esc(T.tqTeam)}">
        <section><h3 class="tq-label">${esc(T.tqWho)}</h3><ul class="tq-members">${who(coord)}${workers.map(w => who(w)).join('')}</ul>${workers.length ? '' : `<p class="tq-quiet">${esc(T.noWorkers)}</p>`}</section>
        <section><h3 class="tq-label">${esc(T.tqLinks)}</h3><p class="tq-small">${linked.length ? esc(T.tqLinkedTo(linked.map(titleOf).join(', '))) : esc(T.tqNoLinks)}</p>${can('manager') ? `<button type="button" class="btn quiet tq-act" data-links="${esc(coord.name)}">${esc(T.tqManageLinks)}</button>` : ''}</section>
        ${permissionsSection({ coordinator: coord.name })}
        ${can('manager') ? `<section><h3 class="tq-label">${esc(T.tqTemplate)}</h3><p class="tq-small">${esc(T.tqTemplateHint)}</p><button type="button" class="btn tq-act" data-savetpl="${esc(coord.name)}">${esc(T.tqSaveTemplate)}</button></section>` : ''}
      </aside>
    </div>`)
  $('topSub').textContent = workers.length ? T.squadCount(workers.filter(w => w.online).length, workers.length) : T.noWorkers
}
export const refreshTeam = () => { if (currentRoute().view === 'team' && !$('team').hidden) renderTeam() }
// A new report from a worker: the list is asked for again.
export function noteReport(m) { if (m?.report && m.target) reports.delete(m.target) }

$('team').addEventListener('click', async e => {
  const name = currentRoute().squad
  if (e.target.closest('[data-describe]')) return (await import('./org.js')).squadDialog(name)
  const l = e.target.closest('[data-links]')
  if (l) return (await import('./org.js')).linksDialog(l.dataset.links)
  const t = e.target.closest('[data-savetpl]')
  if (t) return (await import('./squads.js')).saveTemplateDialog(t.dataset.savetpl)
})
