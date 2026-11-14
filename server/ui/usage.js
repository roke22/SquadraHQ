import { $, store } from './dom.js'
import { T, LOCALE, COLLATOR } from './i18n.js'
import { state, companyPref } from './state.js'
import { esc } from './format.js'
import { api } from './api.js'
import { setHtml, soon } from './nav.js'
import { currentRoute } from './router.js'
import { agentMark } from './content.js'

// What the agents spent, in tokens: a period, filters, the totals, the
// spending over time, and by team, what started it, task, session and model.
// Read from /api/usage (kept by the hour on the server); counts only.
const KINDS = ['input', 'cache_write', 'cache_read', 'output']
const RANGES = { today: 0, d7: 7, d30: 30, d90: 90 }
const HOUR = 3600_000, DAY = 24 * HOUR
const COMPACT = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 })
const FULL = new Intl.NumberFormat(LOCALE)
const DAY_FMT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const HOUR_FMT = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })

let view = { range: store.get(companyPref('pishaUsageRange')) ?? 'd7', team: '', agent: '', model: '' }
let data = null, loading = 0, timer = null

const total = r => r.input + r.cache_read + r.cache_write + r.output
const num = n => COMPACT.format(n)
const period = () => {
  const now = Date.now()
  if (view.range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: now, bucket: 'hour' } }
  return { from: now - (RANGES[view.range] ?? 7) * DAY, to: now, bucket: 'day' }
}

async function load() {
  const seq = ++loading
  const p = period()
  const q = new URLSearchParams({ from: p.from, to: p.to, bucket: p.bucket, tz: -new Date().getTimezoneOffset() })
  for (const k of ['team', 'agent', 'model']) if (view[k]) q.set(k, view[k])
  try {
    const r = await api(`/api/usage?${q}`)
    if (seq !== loading) return
    data = r
  } catch (err) { if (seq === loading) data = { error: err.message } }
  if (currentRoute().view === 'usage') draw()
}

export function renderUsage() {
  if (!data) setHtml($('usage'), `<div class="u-wrap"><p class="dim-note">${esc(T.usageLoading)}</p></div>`)
  void load()
  clearInterval(timer)
  // (While it is open: what is being spent now shows up within a minute.)
  timer = setInterval(() => { if (currentRoute().view === 'usage' && !$('usage').hidden) void load(); else clearInterval(timer) }, 60_000)
}

// The header: the period, and the export.
export function usageHead() {
  const seg = Object.keys(RANGES).map(k => `<button type="button" data-urange="${k}" class="${view.range === k ? 'on' : ''}" aria-pressed="${view.range === k}">${esc(T.usageRanges[k])}</button>`).join('')
  return { title: esc(T.usage), tabs: `<span class="seg" role="group" aria-label="${esc(T.usagePeriod)}">${seg}</span>`, right: `<button type="button" class="btn" data-uexport>${esc(T.usageExport)}</button>` }
}

const teamName = t => (t ? state.squadMeta.get(t)?.title || t : T.usageNoTeam)

function draw() {
  const box = $('usage')
  if (data?.error) { setHtml(box, `<div class="u-wrap"><p class="err">${esc(data.error)}</p></div>`); return }
  const d = data
  const opts = (k, list, label, name = x => x) => `<label class="u-filter"><span class="sr-only">${esc(label)}</span><select data-ufilter="${k}"><option value="">${esc(label)}</option>${list.map(v => `<option value="${esc(v)}"${view[k] === v ? ' selected' : ''}>${esc(name(v))}</option>`).join('')}</select></label>`
  const teams = [...new Set([...(view.team ? [view.team] : []), ...d.by.team.map(r => r.team).filter(Boolean)])].sort((a, b) => COLLATOR.compare(teamName(a), teamName(b)))
  const agents = [...new Set([...(view.agent ? [view.agent] : []), ...d.by.agent.map(r => r.agent)])]
  const models = [...new Set([...(view.model ? [view.model] : []), ...d.by.model.map(r => r.model).filter(Boolean)])]
  const filters = `<div class="u-filters">${opts('team', teams, T.usageAllTeams, teamName)}${opts('agent', agents, T.usageAllAgents, a => T.agentName[a] ?? a)}${opts('model', models, T.usageAllModels)}</div>`
  const t = d.totals, all = total(t)
  if (!all) {
    setHtml(box, `<div class="u-wrap">${filters}<div class="empty u-empty"><b>${esc(T.usageEmpty)}</b><span>${esc(T.usageEmptyHint)}</span></div></div>`)
    return
  }
  const inAll = t.input + t.cache_read + t.cache_write
  const cached = inAll ? Math.round(t.cache_read / inAll * 100) : 0
  const tile = (k, label, value, note = '') => `<div class="u-tile"${k ? ` data-k="${k}"` : ''}><span class="u-tl">${k ? '<i aria-hidden="true"></i>' : ''}${esc(label)}</span><b title="${esc(FULL.format(value))}">${esc(num(value))}</b>${note ? `<span class="u-tn">${esc(note)}</span>` : ''}</div>`
  const tiles = `<div class="u-tiles">
      ${tile('', T.usageTotal, all, T.usageCalls(t.calls))}
      ${tile('input', T.usageKinds.input, t.input)}
      ${tile('output', T.usageKinds.output, t.output)}
      ${tile('cache_read', T.usageKinds.cache_read, t.cache_read, T.usageCached(cached))}
      ${tile('cache_write', T.usageKinds.cache_write, t.cache_write)}
    </div>`
  setHtml(box, `<div class="u-wrap">${filters}${tiles}
      <section class="card u-card"><header class="u-ch"><h2>${esc(T.usageOverTime)}</h2>${legend()}</header>${chart(d)}</section>
      <div class="u-grid">
        ${breakdown(T.usageByTeam, d.by.team.map(r => ({ ...r, label: teamName(r.team), key: r.team })), 'team')}
        ${breakdown(T.usageByCause, d.by.cause.map(r => ({ ...r, label: T.usageCauses[r.cause] ?? r.cause, hint: T.usageCauseHints[r.cause] ?? '' })))}
        ${breakdown(T.usageByTask, d.by.task.filter(r => r.task).map(r => ({ ...r, label: r.task, href: taskHref(r.task) })), '', T.usageNoTasks)}
        ${breakdown(T.usageByModel, d.by.model.map(r => ({ ...r, label: r.model || '?' })))}
        ${breakdown(T.usageBySession, d.by.session.map(r => ({ ...r, label: r.session, sub: [teamName(r.team), T.roleName[r.role] ?? r.role].filter(Boolean).join(' · '), lead: agentMark({ agent: r.agent }), href: `#/s/${encodeURIComponent(r.session)}` })), '', '', true)}
      </div>
    </div>`)
}

const legend = () => `<span class="u-legend">${KINDS.map(k => `<span data-k="${k}"><i aria-hidden="true"></i>${esc(T.usageKinds[k])}</span>`).join('')}</span>`

// Stacked bars, one per hour or day of the period (empty ones too).
function chart(d) {
  const p = period(), step = d.bucket === 'hour' ? HOUR : DAY
  const start = d.bucket === 'hour' ? Math.floor(p.from / HOUR) * HOUR : (() => { const x = new Date(p.from); x.setHours(0, 0, 0, 0); return x.getTime() })()
  const byT = new Map(d.series.map(s => [s.t, s]))
  const buckets = []
  for (let x = start; x <= p.to; x += step) {
    // (Days by the calendar: a day with a clock change isn't 24 h.)
    const key = d.bucket === 'hour' ? x : [...byT.keys()].find(k => Math.abs(k - x) < 3 * HOUR) ?? x
    buckets.push({ t: x, ...(byT.get(key) ?? { input: 0, cache_read: 0, cache_write: 0, output: 0, calls: 0 }) })
    if (d.bucket === 'day') { const n = new Date(x); n.setDate(n.getDate() + 1); x = n.getTime() - step }
  }
  const max = Math.max(1, ...buckets.map(total))
  const W = 1000, H = 220, gap = buckets.length > 40 ? 1 : 3, bw = (W - gap * (buckets.length - 1)) / buckets.length
  const fmt = d.bucket === 'hour' ? HOUR_FMT : DAY_FMT
  const bars = buckets.map((b, i) => {
    let y = H
    const x = i * (bw + gap)
    const parts = KINDS.map(k => { const h = b[k] / max * H; y -= h; return h > 0 ? `<rect data-k="${k}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>` : '' }).join('')
    const tip = `${fmt.format(b.t)}: ${FULL.format(total(b))} · ${KINDS.map(k => `${T.usageKinds[k]} ${num(b[k])}`).join(' · ')}`
    return `<g class="u-bar"><title>${esc(tip)}</title><rect class="u-hit" x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}"/>${parts}</g>`
  }).join('')
  const every = Math.ceil(buckets.length / 8)
  const labels = buckets.map((b, i) => (i % every ? '' : `<span style="left:${((i * (bw + gap) + bw / 2) / W * 100).toFixed(2)}%">${esc(fmt.format(b.t))}</span>`)).join('')
  return `<div class="u-chart"><span class="u-max">${esc(num(max))}</span><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(T.usageOverTime)}">${bars}</svg><div class="u-axis">${labels}</div></div>`
}

// One breakdown: a row per item with its share of the period and its kinds.
function breakdown(title, rows, filterKey = '', empty = '', wide = false) {
  const max = Math.max(1, ...rows.map(total))
  const sumAll = rows.reduce((n, r) => n + total(r), 0) || 1
  const row = r => {
    const name = r.href ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : filterKey && r.key ? `<button type="button" class="linkish" data-ufilter-set="${filterKey}" data-v="${esc(r.key)}">${esc(r.label)}</button>` : esc(r.label)
    const bar = KINDS.map(k => (r[k] ? `<i data-k="${k}" style="width:${(r[k] / max * 100).toFixed(2)}%"></i>` : '')).join('')
    return `<li class="u-row"${r.hint ? ` title="${esc(r.hint)}"` : ''}>
        <span class="u-name">${r.lead ?? ''}<span class="u-nt"><b>${name}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ''}</span></span>
        <span class="u-val" title="${esc(FULL.format(total(r)))} · ${esc(T.usageCalls(r.calls))}">${esc(num(total(r)))}<small>${Math.round(total(r) / sumAll * 100)}%</small></span>
        <span class="u-stack">${bar}</span>
      </li>`
  }
  return `<section class="card u-card${wide ? ' wide' : ''}"><header class="u-ch"><h2>${esc(title)}</h2></header>${rows.length ? `<ul class="u-rows">${rows.slice(0, 50).map(row).join('')}</ul>` : `<p class="dim-note">${esc(empty)}</p>`}</section>`
}

// A task's link: on the board it is on (the dashboard's first open one).
const taskHref = id => {
  const b = state.boards.find(x => !x.archived_at) ?? state.boards[0]
  return b ? `#/b/${b.id}/${encodeURIComponent(id)}` : ''
}

// The period's spending as CSV: by session, day or hour, with every column.
function exportCsv() {
  if (!data?.by) return
  const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  const head = ['session', 'team', 'role', 'agent', ...KINDS, 'total', 'calls']
  const lines = [head.join(','), ...data.by.session.map(r => [r.session, r.team, r.role, r.agent, ...KINDS.map(k => r[k]), total(r), r.calls].map(cell).join(','))]
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }))
  a.download = `pisha-usage-${new Date(data.from).toISOString().slice(0, 10)}-${new Date(data.to).toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// Clicks and choices on the screen and in its header.
document.addEventListener('click', e => {
  if (currentRoute().view !== 'usage') return
  const r = e.target.closest('[data-urange]')
  if (r) { view.range = r.dataset.urange; store.set(companyPref('pishaUsageRange'), view.range); soon(async () => (await import('./topbar.js')).renderTop()); void load(); return }
  if (e.target.closest('[data-uexport]')) return exportCsv()
  const f = e.target.closest('[data-ufilter-set]')
  if (f) { view[f.dataset.ufilterSet] = f.dataset.v; void load() }
})
document.addEventListener('change', e => {
  const f = e.target.closest?.('[data-ufilter]')
  if (!f || currentRoute().view !== 'usage') return
  view[f.dataset.ufilter] = f.value
  void load()
})
