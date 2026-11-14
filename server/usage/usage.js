import { now, bad } from '../platform/index.js'

// What the agents spend, in tokens: each session's plugin reports its model
// calls (observation events of kind "tokens", see plugins/pisha/observe.js),
// and they are kept added up by the hour, with what each one was spent on:
// the session, its team and role then, its agent and model, what started the
// turn (the user, its coordinator, a linked team, the board…) and the board
// task it was about. Only counts, never what was said.
export const CAUSES = ['user', 'inbox', 'coordinator', 'worker', 'link', 'board', 'system', 'other', 'self']
const KINDS = ['input', 'cache_read', 'cache_write', 'output']
const HOUR = 3600_000
const DAY = 24 * HOUR

export function createUsage(platform, { sessions, boards }) {
  const { db, bus, quota, log } = platform
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      hour INTEGER NOT NULL, session TEXT NOT NULL, team TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL DEFAULT '', cause TEXT NOT NULL DEFAULT 'self',
      task TEXT NOT NULL DEFAULT '', sub INTEGER NOT NULL DEFAULT 0,
      input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, session, team, role, agent, model, cause, task, sub)
    );
    CREATE INDEX IF NOT EXISTS token_usage_hour ON token_usage(hour);
  `)
  const keptMs = () => quota('usage_days', 400) * DAY

  // Who a session is now: its role, team (a coordinator's own name, a
  // worker's coordinator) and agent. (Until it first logs in, what it was opened as.)
  function whoIs(name) {
    const r = db.prepare('SELECT role, coordinator, agent, opened_role, opened_coordinator, host_id FROM identities WHERE name = ?').get(name)
    if (!r) return { role: '', team: '', agent: 'claude' }
    const role = r.role ?? (r.host_id ? r.opened_role : null) ?? ''
    const team = role === 'coordinator' ? name : role === 'worker' ? (r.role ? r.coordinator : r.opened_coordinator) ?? '' : ''
    return { role, team, agent: r.agent ?? 'claude' }
  }

  // What started a turn, from the message it began with: its sender as seen
  // from this session (its coordinator, one of its workers, a linked team).
  function causeOf(name, ev) {
    if (ev.cause === 'user' || ev.cause === 'inbox' || ev.cause === 'self') return ev.cause
    if (ev.cause === 'board') return 'board'
    if (ev.cause === 'notice') return 'system'
    if (ev.cause !== 'message' || !Number.isSafeInteger(ev.msg)) return 'other'
    const m = db.prepare('SELECT from_name, target, system FROM messages WHERE id = ?').get(ev.msg)
    if (!m) return 'other'
    if (m.from_name === boards.BOARD_SENDER) return 'board'
    if (m.system) return 'system'
    const me = whoIs(name), them = whoIs(m.from_name)
    if (me.role === 'worker' && me.team === m.from_name) return 'coordinator'
    if (them.role === 'worker' && them.team === name) return 'worker'
    if (me.role === 'coordinator' && them.role === 'coordinator' && sessions.linked(name, m.from_name)) return 'link'
    return 'other'
  }

  const add = db.prepare(`INSERT INTO token_usage (hour, session, team, role, agent, model, cause, task, sub, input, cache_read, cache_write, output, calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hour, session, team, role, agent, model, cause, task, sub) DO UPDATE SET
      input = input + excluded.input, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
      output = output + excluded.output, calls = calls + excluded.calls`)

  // A batch of model calls from one session (already checked by observation).
  function record(name, list) {
    const who = whoIs(name)
    for (const ev of list) {
      const counts = KINDS.map(k => ev[k] ?? 0)
      if (!counts.some(n => n > 0)) continue
      const task = typeof ev.task === 'string' ? boards.taskIn(ev.task) ?? '' : ''
      try {
        add.run(Math.floor(ev.ts / HOUR) * HOUR, name, who.team, who.role, who.agent, ev.model ?? '', causeOf(name, ev), task, ev.sub ? 1 : 0, ...counts, ev.calls || 1)
      } catch (err) { log(`token usage of "${name}" not kept: ${err.message}`) }
    }
  }
  bus.on('tokens', record)

  function cleanupUsage() {
    db.prepare('DELETE FROM token_usage WHERE hour < ?').run(now() - keptMs())
  }

  // --- the dashboard's read ------------------------------------------------------

  const sum = (a, r) => { for (const k of [...KINDS, 'calls']) a[k] = (a[k] ?? 0) + r[k]; return a }
  const zero = () => ({ input: 0, cache_read: 0, cache_write: 0, output: 0, calls: 0 })
  const DIMENSIONS = ['team', 'session', 'cause', 'task', 'model', 'agent', 'role']

  // From/to in ms (to excluded), by hour or by day in the viewer's time zone
  // (tz: minutes east of UTC), filtered by team, session, agent or model.
  // Totals, the series, and the totals by each dimension.
  function usage(q) {
    const to = Number(q.get('to')) || now()
    const from = Number(q.get('from')) || to - 7 * DAY
    if (!(from < to) || to - from > 400 * DAY) throw bad('from must be before to, at most 400 days apart')
    const bucket = q.get('bucket') === 'hour' ? 'hour' : 'day'
    const tz = Math.max(-840, Math.min(840, Number(q.get('tz')) || 0)) * 60_000
    const where = ['hour >= ?', 'hour < ?'], args = [Math.floor(from / HOUR) * HOUR, to]
    for (const k of ['team', 'session', 'agent', 'model', 'cause']) {
      const v = q.get(k)
      if (v != null && v !== '') { where.push(`${k} = ?`); args.push(String(v).slice(0, 200)) }
    }
    const rows = db.prepare(`SELECT * FROM token_usage WHERE ${where.join(' AND ')}`).all(...args)
    const totals = zero(), series = new Map(), by = Object.fromEntries(DIMENSIONS.map(d => [d, new Map()]))
    for (const r of rows) {
      sum(totals, r)
      const t = bucket === 'hour' ? r.hour : Math.floor((r.hour + tz) / DAY) * DAY - tz
      sum(series.get(t) ?? series.set(t, zero()).get(t), r)
      for (const d of DIMENSIONS) {
        const key = d === 'session' ? `${r.session}\u0000${r.team}\u0000${r.role}\u0000${r.agent}` : String(r[d] ?? '')
        const m = by[d]
        sum(m.get(key) ?? m.set(key, zero()).get(key), r)
      }
    }
    const total = r => r.input + r.cache_read + r.cache_write + r.output
    const list = (d, m) => [...m].map(([key, v]) => {
      if (d !== 'session') return { [d]: key, ...v }
      const [session, team, role, agent] = key.split('\u0000')
      return { session, team, role, agent, ...v }
    }).sort((a, b) => total(b) - total(a))
    return {
      from, to, bucket, totals,
      series: [...series].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v })),
      by: Object.fromEntries(DIMENSIONS.map(d => [d, list(d, by[d])])),
    }
  }

  return { usageReads: { usage }, cleanupUsage, record }
}
