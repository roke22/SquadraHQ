import { $ } from './dom.js'
import { T } from './i18n.js'
import { state, can, linksOf, unread } from './state.js'
import { esc } from './format.js'
import { sortedSessions, status, squadsOf, agentMark } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'
import { personaTag } from './topbar.js'
import { planMeter } from './team.js'

// Teams: one card per team, its coordinator and its workers, what each is
// doing, and what the team is for. Sessions outside every team after them.

const titleOf = c => state.squadMeta.get(c)?.title || c

function person(s, sub) {
  const st = status(s)
  const role = s.role === 'coordinator' ? 'coord' : s.role === 'solo' ? 'solo' : 'worker'
  const n = unread.get(s.name) ?? 0
  const attention = st.waiting ? `<span class="badge attn" aria-hidden="true">!</span><span class="sr-only">${esc(T.waitingOnYou)}</span>` : n ? `<span class="badge" aria-hidden="true">${n > 99 ? '99+' : n}</span><span class="sr-only">${esc(T.unreadN(n))}</span>` : ''
  return `<li><a href="#/s/${encodeURIComponent(s.name)}" class="tm-person${sub ? ' sub' : ''}${s.online ? '' : ' offline'}">
      <span class="role ${role}" aria-hidden="true"></span>${agentMark(s)}<span class="sr-only">${esc(T.roleName[s.role] ?? T.roleName.worker)}</span>
      <span class="tm-who">${esc(s.name)}</span><span class="dot ${st.dot || 'off'}" aria-hidden="true"></span>${personaTag(s.persona)}
      <span class="tm-what">${esc(st.text)}</span>${attention}</a></li>`
}

function card({ coord, workers }) {
  const meta = state.squadMeta.get(coord.name)
  const plan = state.plans.get(coord.name)
  const linked = linksOf(coord.name).map(titleOf)
  const on = workers.filter(w => w.online).length
  return `<section class="card tm-card" aria-labelledby="tm-${esc(coord.name)}">
      <header class="tm-h"><h2 id="tm-${esc(coord.name)}"><a href="#/q/${encodeURIComponent(coord.name)}">${esc(titleOf(coord.name))}</a></h2>
        <span class="tm-sub">${esc([workers.length ? T.squadCount(on, workers.length) : T.noWorkers, linked.length ? T.linkedWith(linked.join(', ')) : ''].filter(Boolean).join(' · '))}</span></header>
      <ul class="tm-people">${person(coord, false)}${workers.map(w => person(w, true)).join('')}</ul>
      <footer class="tm-foot">${plan?.tasks.length ? `<div class="tm-plan"><span class="tm-goal">${esc(plan.title || meta?.goal || T.planTitle)}</span><span class="tm-none">${esc(T.ofTotal(plan.tasks.filter(t => t.state === 'done').length, plan.tasks.length))}</span></div>${planMeter(plan)}` : meta?.goal ? `<span class="tm-goal">${esc(meta.goal)}</span>` : `<span class="tm-none">${esc(T.tmNoGoal)}</span>`}</footer>
    </section>`
}

function loose(title, list) {
  return `<section class="card tm-card"><header class="tm-h"><h2>${esc(title)}</h2><span class="tm-sub">${esc(T.tmSessions(list.length))}</span></header>
      <ul class="tm-people">${list.map(s => person(s, false)).join('')}</ul></section>`
}

export function renderTeams() {
  const list = sortedSessions()
  const { squads, orphans, solos } = squadsOf(list)
  const cards = [...squads.map(card), ...(orphans.length ? [loose(squads.length ? T.noCoordinator : T.workers, orphans)] : []), ...(solos.length ? [loose(T.standalone, solos)] : [])]
  setHtml($('teams'), cards.length
    ? `<div class="tm-grid">${cards.join('')}</div>`
    : `<div class="empty"><b>${esc(T.noTeams)}</b><span>${esc(T.tmEmptyHint)}</span>${can('operator') ? '<button type="button" class="btn primary" data-newteam>' + esc(T.newTeam) + '</button>' : ''}</div>`)
  $('topSub').textContent = T.tmCount(squads.length, list.length)
}
export const refreshTeams = () => { if (currentRoute().view === 'teams' && !$('teams').hidden) renderTeams() }

$('teams').addEventListener('click', async e => {
  if (e.target.closest('[data-newteam]')) location.hash = '#/new'
})
