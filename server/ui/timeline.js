import { T, LOCALE } from './i18n.js'
import { state, sessions, hosts, companyPref } from './state.js'
import { store } from './dom.js'
import { esc, hhmm } from './format.js'
import { api } from './api.js'
import { status } from './content.js'
import { planMeter } from './team.js'

// Beside a session's terminal: what it is doing now, and what mattered so far.
// Nothing is asked of the model: it is read from what the session already
// reports (its events and messages), and from the inbox and the plan. What
// isn't recognised isn't shown, and nothing is made up.

export const timelines = new Set()

// Commands that say what they did: tests, a commit, a push (a guess from the
// command line: anything else is left out).
const TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?\b|\bnpx\s+(?:vitest|jest|playwright\s+test|mocha)\b|\b(?:pytest|vitest|jest|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bmake\s+(?:test|check)\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradle\w*\s+test\b/
const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/
const PUSH_RE = /\bgit\s+(?:-C\s+\S+\s+)?push\b/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const firstLine = (s, n = 140) => { const l = String(s ?? '').trim().split('\n')[0]; return l.length > n ? `${l.slice(0, n - 1)}…` : l }
const commitMsg = cmd => /-m\s+(["'])(.+?)\1/.exec(cmd)?.[2] ?? /-m\s+(\S+)/.exec(cmd)?.[1] ?? ''
const passed = text => /(\d+)\s+(?:tests?\s+)?(?:passed|passing)\b/i.exec(text ?? '')?.[1]
const fileOf = summary => String(summary ?? '').replace(/\s+\([^)]*\)$/, '').replace(/\s+\+\d+\s+[−-]\d+$/, '')

// What mattered, oldest first, from the session's history.
function milestones(name, items) {
  const s = sessions.get(name)
  const out = []
  const add = (ts, kind, tone, title, detail = '', full = '') => out.push({ ts, kind, tone, title, detail, full: full || detail })
  const starts = new Map() // tool use id -> its start
  let edits = null // the files edited in this turn, and when the last one was
  let editedAt = 0
  const flush = () => { if (edits?.size) add(editedAt, 'edits', 'muted', T.tlEdits(edits.size), [...edits].slice(0, 3).join(', ') + (edits.size > 3 ? '…' : ''), [...edits].join('\n')); edits = null }
  for (const it of items) {
    if (it.t === 'event') {
      if (it.agent) continue // a subagent's own steps: its Task is the main session's
      switch (it.kind) {
        case 'session_start': if (it.source === 'clear') add(it.ts, 'start', 'muted', T.tlCleared); else if (it.source !== 'compact') add(it.ts, 'start', 'muted', T.tlStart); break
        case 'prompt':
          flush()
          if (it.channel || !it.text) break // a channel message: shown as the message itself
          if (/^\s*Inbox #\d+/.test(it.text)) add(it.ts, 'answer', 'ok', T.tlInboxAnswer, firstLine(it.text.replace(/^\s*Inbox #\d+\s*(\("[^"]*"\))?,?\s*/, '').replace(/\s*\[They are not following[\s\S]*$/, '')))
          else add(it.ts, 'order', 'info', T.tlTyped, firstLine(it.text))
          break
        case 'tool_start':
          starts.set(it.ref, it)
          if (EDIT_TOOLS.has(it.tool) && it.summary) { (edits ??= new Set()).add(fileOf(it.summary)); editedAt = it.ts }
          break
        case 'tool_end': {
          const start = starts.get(it.ref)
          const cmd = it.tool === 'Bash' ? start?.summary ?? '' : ''
          if (cmd && TEST_RE.test(cmd)) {
            const n = passed(it.detail)
            add(it.ts, 'tests', it.ok === false ? 'err' : 'ok', it.ok === false ? T.tlTestsFailed : T.tlTestsPassed, n && it.ok !== false ? T.tlPassedN(n) : firstLine(cmd, 80), cmd)
          } else if (cmd && COMMIT_RE.test(cmd) && it.ok !== false) add(it.ts, 'commit', 'ok', T.tlCommit, commitMsg(cmd), cmd)
          else if (cmd && PUSH_RE.test(cmd) && it.ok !== false) add(it.ts, 'push', 'ok', T.tlPush, firstLine(cmd, 80))
          else if (/update_plan$/.test(it.tool ?? '') && it.ok !== false) add(it.ts, 'plan', 'info', T.tlPlan)
          break
        }
        case 'notification': if (it.type === 'permission_prompt') add(it.ts, 'perm', 'warn', T.tlPerm, firstLine(it.text)); break
        case 'stop': flush(); break
        case 'compacted': add(it.ts, 'compact', 'muted', T.tlCompact); break
        case 'session_end': flush(); add(it.ts, 'end', 'muted', T.tlEnd); break
      }
    } else if (it.t === 'message' && !it.system) {
      // Its coordinator's orders, and its own reports.
      if (it.target === name && s?.coordinator && it.from === s.coordinator && !it.fyi) add(it.ts, 'order', 'info', T.tlOrder(it.from), firstLine(it.text))
      else if (it.from === name && it.report) add(it.ts, 'report', it.report === 'done' ? 'ok' : it.report === 'question' ? 'warn' : 'err', T.tlReport[it.report] ?? it.report, firstLine(it.text))
    }
  }
  flush()
  // What it left in the inbox, and what became of it.
  for (const i of state.inbox.filter(x => x.session === name)) {
    add(i.created_at, 'inbox', i.kind === 'ask' ? 'warn' : 'info', i.kind === 'ask' ? T.tlAsked : T.tlTold, firstLine(i.text))
    if (i.resolved_at && i.answer != null) add(i.resolved_at, 'answer', 'ok', T.tlAnswered, firstLine(i.answer))
    else if (i.resolved_at && i.dismissed_by) add(i.resolved_at, 'dismiss', 'err', T.tlDismissed, firstLine(i.text))
  }
  return out.sort((a, b) => b.ts - a.ts)
}

const day = ts => new Date(ts).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })

export class Timeline {
  constructor(name, box) {
    this.name = name
    this.box = box
    this.items = []
    this.loaded = false
    this.timer = null
    timelines.add(this)
    this.render()
    this.load()
  }
  async load() {
    try {
      const r = await api(`/api/timeline?session=${encodeURIComponent(this.name)}&limit=500`)
      if (!timelines.has(this)) return
      this.items = r.items
    } catch { /* shown as nothing yet */ }
    this.loaded = true
    this.render()
  }
  // Something new from the server: kept if it is this session's.
  live(it) {
    if (!this.loaded) return
    const mine = it.t === 'event' ? it.session === this.name : it.from === this.name || it.target === this.name
    if (!mine || (it.t === 'event' && it.kind === 'usage')) return
    this.items.push(it)
    if (this.items.length > 2000) this.items.splice(0, this.items.length - 2000)
    this.soon()
  }
  soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.render(), 250) }
  destroy() { clearTimeout(this.timer); timelines.delete(this) }

  render() {
    const s = sessions.get(this.name)
    if (!s) { this.box.innerHTML = ''; return }
    const st = status(s)
    const a = s.activity ?? {}
    const team = s.role === 'coordinator' ? s.name : s.coordinator
    const plan = team ? state.plans.get(team) : null
    const task = plan?.tasks.find(t => t.who === this.name && t.state === 'doing') ?? plan?.tasks.find(t => t.who === this.name && (t.state === 'blocked' || t.state === 'waiting'))
    const h = hosts.get(s.host_id)
    const pct = a.context_pct
    const now = `<section class="tl-now"><h2 class="tq-label">${esc(T.tlNow)}</h2>
      <p class="tl-state"><span class="dot ${st.dot || 'off'}" aria-hidden="true"></span><span>${esc(st.text)}</span></p>
      ${pct != null ? `<div class="tl-ctx" title="${esc(T.contextPct(pct))}"><span>${esc(T.svContext)}</span><span class="tl-bar"><i style="width:${pct}%"${pct >= 80 ? ' class="hot"' : ''}></i></span><span>${pct} %</span></div>` : ''}
      ${s.role === 'coordinator' && plan?.tasks.length ? `<div class="tl-plan">${planMeter(plan)}<span>${esc(T.planDone(plan.tasks.filter(t => t.state === 'done').length, plan.tasks.length))}</span></div>` : ''}
      ${task ? `<p class="tl-task"><span class="tq-label">${esc(T.tlTask)}</span>${esc(task.title)}</p>` : ''}
      <dl class="tl-facts">${h ? `<dt>${esc(T.svMachine)}</dt><dd>${esc(h.name)}</dd>` : ''}${a.cwd ? `<dt>${esc(T.svFolder)}</dt><dd class="sv-mono" title="${esc(a.cwd)}">${esc(a.cwd)}</dd>` : ''}</dl>
    </section>`
    const list = this.loaded ? milestones(this.name, this.items) : []
    let lastDay = new Date().toDateString()
    const rows = list.map(m => {
      const d = new Date(m.ts).toDateString()
      const head = d !== lastDay ? `<li class="tl-day">${esc(day(m.ts))}</li>` : ''
      lastDay = d
      return `${head}<li class="tl-item ${m.tone}" data-kind="${m.kind}"><time datetime="${new Date(m.ts).toISOString()}">${esc(hhmm(m.ts))}</time><span class="tl-mark" aria-hidden="true"></span><div><b>${esc(m.title)}</b>${m.detail ? `<span title="${esc(m.full)}">${esc(m.detail)}</span>` : ''}</div></li>`
    }).join('')
    this.box.innerHTML = `${now}<section class="tl-past"><h2 class="tq-label">${esc(T.tlImportant)}</h2>
      ${!this.loaded ? `<p class="sv-small sv-quiet">${esc(T.termLoading)}</p>` : rows ? `<ol class="tl-list">${rows}</ol>` : `<p class="sv-small sv-quiet">${esc(T.tlEmpty)}</p>`}
      ${a.observe === 'off' ? `<p class="sv-small sv-quiet">${esc(T.svNotObserved)}</p>` : `<p class="tl-kept">${esc(T.tlKept)}</p>`}</section>`
  }
}

export const refreshTimelines = () => { for (const t of timelines) t.soon() }

// The panel folds to a thin edge (and back); the choice is kept per company.
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-tvfold]')
  const tv = b?.closest('.tv')
  if (!tv) return
  const folded = tv.classList.toggle('folded')
  store.set(companyPref('squadraTlFolded'), folded ? '1' : '0')
  b.setAttribute('aria-expanded', String(!folded))
  b.setAttribute('aria-label', folded ? T.tlShow : T.tlHide)
  b.title = folded ? T.tlShow : T.tlHide
  b.querySelector('.ic')?.classList.toggle('flip', folded)
})
