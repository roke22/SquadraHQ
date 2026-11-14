import { now, cleanText, bad, ApiError } from '../platform/index.js'

// A coordinator's plan: the tasks it is working through, as it tells them,
// for the user and the team's page. The whole list each time (it replaces the
// last); Pisha checks its shape and keeps it, and says whose word it is.
const STATES = ['todo', 'doing', 'done', 'blocked', 'waiting']
const MAX_TASKS = 100
const MAX_TITLE = 160
const MAX_NOTE = 240
const MAX_REF = 500
const PER_HOUR = 120

export function createPlans(platform, { sessions }) {
  const { db, broadcast, allow, rateLimit, spendStorage } = platform
  const { roleOf, NAME_RE } = sessions

  db.exec('CREATE TABLE IF NOT EXISTS plans (coordinator TEXT PRIMARY KEY, title TEXT, tasks TEXT NOT NULL, updated_at INTEGER NOT NULL)')

  const view = r => ({ coordinator: r.coordinator, title: r.title, tasks: JSON.parse(r.tasks), updated_at: r.updated_at })
  const list = () => db.prepare('SELECT * FROM plans ORDER BY coordinator').all().map(view)

  const short = (value, max, what) => {
    const text = cleanText(String(value ?? '')).replace(/\s+/g, ' ').trim()
    if (text.length > max) throw bad(`${what} is too long (max ${max} chars)`)
    return text
  }

  function setPlan(name, p) {
    rateLimit(name)
    const row = db.prepare('SELECT needs_approval FROM identities WHERE name = ?').get(name)
    if (roleOf(name) !== 'coordinator' || row?.needs_approval) throw new ApiError(403, 'Forbidden: only an approved coordinator keeps a plan')
    if (!Array.isArray(p.tasks)) throw bad('tasks must be the whole list: an array, empty to clear it')
    if (p.tasks.length > MAX_TASKS) throw bad(`at most ${MAX_TASKS} tasks: put the small ones together`)
    const tasks = p.tasks.map((t, i) => {
      const where = `task ${i + 1}`
      if (!t || typeof t !== 'object') throw bad(`${where} must be an object with title and state`)
      const title = short(t.title, MAX_TITLE, `${where}'s title`)
      if (!title) throw bad(`${where} needs a title`)
      if (!STATES.includes(t.state)) throw bad(`${where}'s state must be one of: ${STATES.join(', ')} (waiting: it waits on the user's decision)`)
      const who = t.who == null || t.who === '' ? null : String(t.who)
      if (who && !NAME_RE.test(who)) throw bad(`${where}'s who must be a session's name`)
      return { title, state: t.state, ...(who ? { who } : {}), ...(t.ref ? { ref: short(t.ref, MAX_REF, `${where}'s ref`) } : {}), ...(t.note ? { note: short(t.note, MAX_NOTE, `${where}'s note`) } : {}) }
    })
    // (Since when each task has been under way: kept while it stays so, under
    // the same title and person, so the dashboard can say how long it has taken.)
    const before = JSON.parse(db.prepare('SELECT tasks FROM plans WHERE coordinator = ?').get(name)?.tasks ?? '[]')
    const key = t => `${t.who ?? ''}\u0000${t.title}`
    const was = new Map(before.filter(t => t.state === 'doing' && t.since).map(t => [key(t), t.since]))
    for (const t of tasks) if (t.state === 'doing') t.since = was.get(key(t)) ?? now()
    const title = short(p.title, MAX_TITLE, 'title') || null
    if (!allow('plan', name, PER_HOUR, 3600_000)) throw new ApiError(429, `Too Many Requests: at most ${PER_HOUR} changes an hour: send it when a task changes, not on every step`)
    const json = JSON.stringify(tasks)
    spendStorage('text', name, json.length)
    if (tasks.length || title) db.prepare('INSERT INTO plans (coordinator, title, tasks, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(coordinator) DO UPDATE SET title = excluded.title, tasks = excluded.tasks, updated_at = excluded.updated_at').run(name, title, json, now())
    else db.prepare('DELETE FROM plans WHERE coordinator = ?').run(name)
    broadcast('plans', list())
    const count = s => tasks.filter(t => t.state === s).length
    return { tasks: tasks.length, done: count('done'), doing: count('doing'), blocked: count('blocked'), waiting: count('waiting'), todo: count('todo') }
  }

  // (A coordinator deleted: its plan goes with it.)
  function forget(name) {
    if (db.prepare('DELETE FROM plans WHERE coordinator = ?').run(name).changes) broadcast('plans', list())
  }

  return { planMethods: { setPlan }, list, forget }
}
