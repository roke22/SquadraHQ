import { now, cleanText, bad, ApiError } from '../platform/index.js'
import { createGithubSync } from './sync.js'

// Task boards: the company's, each seen by one or more teams. People and
// agents work on the same tasks; a task is someone's, a person's or a
// session's. Assigning never sets anyone to work by itself: the coordinator of
// the team hears of it only when a person says so (now, or later with the
// others: "notify the teams"), and always hears when it stops being its team's.
//
// Who asks:
//   people   the dashboard, with their role in the company (see dashboard.js)
//   agents   the plugin's board tool: a coordinator sees the boards of its team
//            and changes what is its team's or nobody's; a worker sees only
//            its own tasks, moves them as its column's step says (or, with no
//            step, up to review) and comments on them.
//
// A column can be a step of the board's flow, as the people set it: who
// handles it (a person, a team's coordinator or one agent), what to do there,
// and where a task goes once done there, or back to if it isn't acceptable.
// A task moved into it is that one's: told at once when an agent moved it
// (the flow is the people's word), asked first when a person did.
//
// A task can have subtasks, as GitHub's sub-issues: each a task of its own on
// the same board (its card, status and who has it), up to 8 levels deep.

// Sent by the server itself: no session can have this name (see NAME_RE).
export const BOARD_SENDER = 'squadra:board'
export const CATEGORIES = ['backlog', 'unstarted', 'started', 'review', 'done', 'closed']
export const COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink']
// Where a task waits to be worked on: notifying a team of it makes sense.
const ACTIVE = new Set(['unstarted', 'started', 'review'])
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['To do', 'unstarted'], ['In progress', 'started'], ['In review', 'review'], ['Done', 'done'], ['Cancelled', 'closed']]
const DEFAULT_TYPES = [['Task', 'blue'], ['Bug', 'red']]
const PREFIX_RE = /^[A-Z][A-Z0-9]{0,5}$/
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX = {
  boards: 100, statuses: 20, labels: 60, types: 20, teams: 50, tasks: 5000, name: 60, boardDescription: 1000,
  title: 200, description: 20_000, comment: 8000, instructions: 4000, comments: 500, events: 200, labelsPerTask: 20,
  subtasks: 100, depth: 8, // (as GitHub: 100 sub-issues on an issue, 8 levels)
  people: 10, // (as GitHub: 10 assignees on an issue)
}
const AGENT_CHANGES_PER_HOUR = 300

export function createBoards(platform, { sessions, messaging, members }) {
  const { db, broadcast, allow, rateLimit, spendStorage, inTx, log } = platform
  let sync = null // (a board kept in step with GitHub: see sync.js)
  const { NAME_RE, identityExists } = sessions

  db.exec(`
    CREATE TABLE IF NOT EXISTS board_settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS board_teams (board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE, coordinator TEXT NOT NULL, PRIMARY KEY (board_id, coordinator));
    CREATE TABLE IF NOT EXISTS board_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT NOT NULL, position INTEGER NOT NULL,
      handler_kind TEXT, handler TEXT, instructions TEXT, next_id INTEGER, back_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS board_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS board_types (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT,
      status_id INTEGER NOT NULL, type_id INTEGER, priority INTEGER NOT NULL DEFAULT 0, due TEXT, rank REAL NOT NULL,
      assignee_kind TEXT, assignee TEXT,
      notify_state TEXT NOT NULL DEFAULT 'none', notified_to TEXT,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      parent_seq INTEGER REFERENCES tasks(seq) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_board ON tasks(board_id, rank);
    CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_kind, assignee);
    CREATE TABLE IF NOT EXISTS task_labels (task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES board_labels(id) ON DELETE CASCADE, PRIMARY KEY (task_seq, label_id));
    CREATE TABLE IF NOT EXISTS task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE, author TEXT NOT NULL, text TEXT NOT NULL, notified TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments(task_seq, id);
    CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE, at INTEGER NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, data TEXT);
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_seq, id);
  `)
  // (Columns added since the first boards.)
  const addColumn = (table, column, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`) }
  addColumn('tasks', 'parent_seq', 'INTEGER REFERENCES tasks(seq) ON DELETE SET NULL')
  db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_seq)')
  // (Deleting a task puts it in the board's trash: it can be restored, it is never gone for good.)
  addColumn('tasks', 'deleted_at', 'INTEGER')
  addColumn('tasks', 'deleted_by', 'TEXT')
  // (A comment edited or deleted on GitHub: edited here too; deleted, kept but no longer shown.)
  addColumn('task_comments', 'edited_at', 'INTEGER')
  addColumn('task_comments', 'deleted_at', 'INTEGER')
  addColumn('tasks', 'trash_batch', 'INTEGER') // (the task whose deletion took it: its subtasks go back with it)
  // A task has at most one agent (the session that works on it, and is told),
  // and any people besides, up to 10: as GitHub's Agent field and assignees.
  // (Tasks given to a person before: that person is one of its people now.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_people (task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE, user_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (task_seq, user_id));
    INSERT OR IGNORE INTO task_people (task_seq, user_id, position) SELECT seq, assignee, 0 FROM tasks WHERE assignee_kind = 'user';
    UPDATE tasks SET assignee_kind = NULL, assignee = NULL, notify_state = 'none', notified_to = NULL WHERE assignee_kind = 'user';
  `)

  // --- who is who ---------------------------------------------------------------
  // Someone is kept as JSON {kind, id, name}: a person (kind user, by their id)
  // or a session (kind session, by its name). The name is how they were called
  // then: a person who left still reads as they were.
  const person = actor => ({ kind: 'user', id: actor?.id ?? 'server', name: actor?.name ?? 'server token' })
  const agent = name => ({ kind: 'session', id: name, name })
  const who = text => { try { return JSON.parse(text) } catch { return null } }

  const prefix = () => db.prepare("SELECT v FROM board_settings WHERE k = 'prefix'").get()?.v ?? 'SQ'
  const taskId = seq => `${prefix()}-${seq}`
  // "SQ-12", "sq-12", "#12" or 12.
  function seqOf(id) {
    const m = /^(?:[A-Za-z][A-Za-z0-9]{0,5}-|#)?(\d{1,9})$/.exec(String(id ?? '').trim())
    if (!m) throw bad(`"${String(id ?? '').slice(0, 40)}" is not a task id (such as ${prefix()}-12)`)
    return Number(m[1])
  }

  // The team a session is in: a coordinator's own name, a worker's coordinator.
  // (Until it first logs in, what it was opened as.)
  function teamOf(name) {
    const r = db.prepare('SELECT role, coordinator, opened_role, opened_coordinator, host_id FROM identities WHERE name = ?').get(name)
    if (!r) return null
    const role = r.role ?? (r.host_id ? r.opened_role : null)
    if (role === 'coordinator') return name
    if (role === 'worker') return (r.role ? r.coordinator : r.opened_coordinator) ?? null
    return null
  }
  const teamsOf = boardId => db.prepare('SELECT coordinator FROM board_teams WHERE board_id = ? ORDER BY coordinator').all(boardId).map(r => r.coordinator)
  const memberList = () => { try { return members() } catch (err) { log(`members of the company could not be read: ${err.message}`); return [] } }
  const memberName = id => memberList().find(m => m.id === id)?.name ?? null

  // Who a board's tasks can be given to: the company's people, and the
  // sessions of the teams that see it.
  function assignableSessions(boardId) {
    const teams = new Set(teamsOf(boardId))
    return db.prepare('SELECT name FROM identities ORDER BY name').all().map(r => r.name)
      .map(name => ({ name, team: teamOf(name) })).filter(s => s.team && teams.has(s.team))
  }
  function checkAssignee(boardId, a) {
    if (a == null) return null
    if (typeof a !== 'object') throw bad('assignee must be {kind: "user" | "session", id} or null')
    const id = String(a.id ?? '')
    if (a.kind === 'user') {
      const m = memberList().find(x => x.id === id)
      if (!m) throw bad('that person is not in this company')
      return { kind: 'user', id, name: m.name }
    }
    if (a.kind === 'session') {
      if (!NAME_RE.test(id) || !identityExists(id)) throw bad(`there is no session "${id.slice(0, 40)}"`)
      const team = teamOf(id)
      if (!team || !teamsOf(boardId).includes(team)) throw bad(`"${id}" is not in a team that sees this board`)
      return { kind: 'session', id, name: id }
    }
    throw bad('assignee must be {kind: "user" | "session", id} or null')
  }

  const peopleOf = seq => db.prepare('SELECT user_id FROM task_people WHERE task_seq = ? ORDER BY position, user_id').all(seq).map(r => r.user_id)
  // A list of the company's people (their ids), checked.
  function checkPeople(list) {
    if (list === null) return []
    if (!Array.isArray(list)) throw bad('people must be a list of the company\'s people (their ids)')
    const ids = [...new Set(list.map(x => String(typeof x === 'object' && x ? x.id : x)))]
    if (ids.length > MAX.people) throw bad(`at most ${MAX.people} people on a task`)
    const all = memberList()
    for (const id of ids) if (!all.some(m => m.id === id)) throw bad('that person is not in this company')
    return ids
  }
  // What the dashboard says of who has it: the agent (assignee), and the people.
  // (An assignee that is a person, as before: that person, and no agent.)
  function agentParam(board, p) {
    if (p.assignee?.kind === 'user') { if (p.people === undefined) p.people = [p.assignee.id]; return null }
    return p.assignee === undefined ? undefined : checkAssignee(board.id, p.assignee)
  }
  const withPerson = (list, id) => (list.includes(id) ? list : [...list, id].slice(0, MAX.people))

  // --- reading ------------------------------------------------------------------
  const short = (value, max, what, { lines = false } = {}) => {
    let text = cleanText(String(value ?? ''))
    text = lines ? text.replace(/\r\n?/g, '\n').trim() : text.replace(/\s+/g, ' ').trim()
    if (text.length > max) throw bad(`${what} is too long (max ${max} chars)`)
    return text
  }

  // A column, with its step when it has one: who handles it, what to do, where next.
  const statusView = r => ({
    id: r.id, name: r.name, category: r.category,
    handler: r.handler_kind ? { kind: r.handler_kind, id: r.handler, name: r.handler_kind === 'user' ? memberName(r.handler) ?? '?' : r.handler } : null,
    instructions: r.instructions ?? '', next: r.next_id ?? null, back: r.back_id ?? null,
  })
  const statusesOf = boardId => db.prepare('SELECT * FROM board_statuses WHERE board_id = ? ORDER BY position, id').all(boardId).map(statusView)
  const labelsOf = boardId => db.prepare('SELECT id, name, color FROM board_labels WHERE board_id = ? ORDER BY position, id').all(boardId)
  const typesOf = boardId => db.prepare('SELECT id, name, color FROM board_types WHERE board_id = ? ORDER BY position, id').all(boardId)
  const boardRow = id => db.prepare('SELECT * FROM boards WHERE id = ?').get(Number(id))

  function boardView(b) {
    const counts = Object.fromEntries(db.prepare('SELECT status_id, COUNT(*) n FROM tasks WHERE board_id = ? AND deleted_at IS NULL GROUP BY status_id').all(b.id).map(r => [r.status_id, r.n]))
    return {
      id: b.id, name: b.name, description: b.description ?? '', created_at: b.created_at, updated_at: b.updated_at, archived_at: b.archived_at ?? null,
      teams: teamsOf(b.id), statuses: statusesOf(b.id).map(s => ({ ...s, tasks: counts[s.id] ?? 0 })), labels: labelsOf(b.id), types: typesOf(b.id),
      pending: pendingOf(b.id).length, github: sync?.view(b.id) ?? null,
      trash: db.prepare('SELECT COUNT(*) n FROM tasks WHERE board_id = ? AND deleted_at IS NOT NULL').get(b.id).n,
    }
  }
  const boardList = () => db.prepare('SELECT * FROM boards ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id').all().map(boardView)

  function taskView(t, { full = false } = {}) {
    const labels = db.prepare('SELECT label_id FROM task_labels WHERE task_seq = ? ORDER BY label_id').all(t.seq).map(r => r.label_id)
    const assignee = t.assignee_kind ? { kind: t.assignee_kind, id: t.assignee, name: t.assignee_kind === 'user' ? memberName(t.assignee) ?? '?' : t.assignee } : null
    const people = peopleOf(t.seq).map(id => ({ id, name: memberName(id) })).filter(x => x.name) // (one who left the company: no longer shown)
    const view = {
      id: taskId(t.seq), seq: t.seq, board: t.board_id, title: t.title, status: t.status_id, type: t.type_id ?? null, labels,
      priority: t.priority, due: t.due ?? null, rank: t.rank, assignee, people, notify: t.notify_state, notified_to: t.notified_to ?? null,
      created_by: who(t.created_by), created_at: t.created_at, updated_by: who(t.updated_by), updated_at: t.updated_at, version: t.version,
      comments: db.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_seq = ? AND deleted_at IS NULL').get(t.seq).n,
      parent: t.parent_seq ?? null, subtasks: progressOf(t.seq), prs: sync?.prsOf(t.seq) ?? [],
    }
    if (!full) return view
    return {
      ...view,
      description: t.description ?? '',
      comments: db.prepare('SELECT id, author, text, notified, created_at, edited_at FROM task_comments WHERE task_seq = ? AND deleted_at IS NULL ORDER BY id').all(t.seq)
        .map(c => ({ id: c.id, author: who(c.author), text: c.text, notified: c.notified ?? null, created_at: c.created_at, edited_at: c.edited_at ?? null })),
      events: db.prepare('SELECT at, who, what, data FROM task_events WHERE task_seq = ? ORDER BY id DESC LIMIT 100').all(t.seq).reverse()
        .map(e => ({ at: e.at, who: who(e.who), what: e.what, data: e.data ? JSON.parse(e.data) : null })),
      parent_title: t.parent_seq ? taskRow(t.parent_seq)?.title ?? null : null,
      github: (l => (l?.url ? { url: l.url, number: l.number, repo: l.repo } : l ? { draft: true } : null))(sync?.linkOf(t.seq)),
      children: childrenOf(t.seq).map(c => ({ seq: c.seq, id: taskId(c.seq), title: c.title, status: c.status_id, assignee: c.assignee_kind ? { kind: c.assignee_kind, id: c.assignee, name: c.assignee_kind === 'user' ? memberName(c.assignee) ?? '?' : c.assignee } : null, people: peopleOf(c.seq).map(id => ({ id, name: memberName(id) })).filter(x => x.name), subtasks: progressOf(c.seq) })),
    }
  }
  // --- subtasks -------------------------------------------------------------------
  const childrenOf = seq => db.prepare('SELECT * FROM tasks WHERE parent_seq = ? AND deleted_at IS NULL ORDER BY rank, seq').all(seq)
  // How many it has, and how many of those are finished (done or cancelled, as GitHub counts closed ones).
  function progressOf(seq) {
    const r = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(s.category IN ('done', 'closed')), 0) done FROM tasks c JOIN board_statuses s ON s.id = c.status_id WHERE c.parent_seq = ? AND c.deleted_at IS NULL").get(seq)
    return r.total ? { done: r.done, total: r.total } : null
  }
  // Levels above a task (0: it has no parent), and levels from it down (1: no subtasks).
  const above = seq => { let n = 0; for (let t = taskRow(seq); t?.parent_seq && n <= MAX.depth; t = taskRow(t.parent_seq)) n++; return n }
  const below = (seq, n = 1) => (n > MAX.depth ? n : Math.max(n, ...childrenOf(seq).map(c => below(c.seq, n + 1))))
  // A parent for a task (seq, or null for a new one), checked: same board, no loop, not too deep.
  function checkParent(board, value, seq) {
    if (value === null || value === '') return null
    const parent = taskRow(seqOf(value))
    if (!parent || parent.board_id !== board.id) throw bad(`no task ${String(value).slice(0, 40)} on this board to be its parent`)
    if (seq != null) for (let t = parent; t; t = t.parent_seq ? taskRow(t.parent_seq) : null) if (t.seq === seq) throw bad('a task can\'t be a subtask of itself or of its own subtasks')
    if (parent.seq !== taskRow(seq ?? -1)?.parent_seq && childrenOf(parent.seq).length >= MAX.subtasks) throw bad(`at most ${MAX.subtasks} subtasks on a task`)
    if (above(parent.seq) + 1 + (seq != null ? below(seq) : 1) > MAX.depth) throw bad(`subtasks go ${MAX.depth} levels deep at most`)
    return parent.seq
  }

  const taskRow = seq => db.prepare('SELECT * FROM tasks WHERE seq = ? AND deleted_at IS NULL').get(seq) // (not one in the trash)
  const anyTask = seq => db.prepare('SELECT * FROM tasks WHERE seq = ?').get(seq)
  const statusRow = id => db.prepare('SELECT * FROM board_statuses WHERE id = ?').get(id)
  const categoryOf = t => statusRow(t.status_id)?.category ?? 'unstarted'

  // Tasks given to a session of a team, not yet told to its coordinator, where
  // they wait to be worked on.
  function pendingOf(boardId) {
    return db.prepare(`SELECT t.* FROM tasks t JOIN board_statuses s ON s.id = t.status_id
      WHERE t.board_id = ? AND t.deleted_at IS NULL AND t.notify_state = 'pending' AND t.assignee_kind = 'session' AND s.category IN ('unstarted', 'started', 'review') ORDER BY t.rank, t.seq`).all(boardId)
  }

  // --- what changed, and who is told --------------------------------------------
  function event(seq, by, what, data = null) {
    db.prepare('INSERT INTO task_events (task_seq, at, who, what, data) VALUES (?, ?, ?, ?, ?)').run(seq, now(), JSON.stringify(by), what, data == null ? null : JSON.stringify(data))
    db.prepare('DELETE FROM task_events WHERE task_seq = ? AND id <= (SELECT id FROM task_events WHERE task_seq = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(seq, seq, MAX.events)
  }
  const changedBoard = boardId => broadcast('boards', boardList()) // (counts and what waits to be told)
  // (A parent's progress changes with its subtasks: it is sent too, and the one it had before.)
  const changedTask = (seq, ...more) => {
    const t = taskRow(seq)
    if (!t) return
    for (const s of new Set([seq, t.parent_seq, ...more].filter(Boolean))) { const x = taskRow(s); if (x) broadcast('task', taskView(x)) }
    sync?.touch(t.board_id, seq) // (first: the board sent below counts it as on its way to GitHub)
    changedBoard(t.board_id)
  }

  // A message from the board to a coordinator: the server's, signed as such,
  // and taken by the plugin as an order (only what a person did sends one).
  function tell(coordinator, text) {
    try {
      messaging.boardNotice(coordinator, text)
      return true
    } catch (err) {
      log(`board notice for ${coordinator} failed: ${err.message}`)
      return false
    }
  }
  const quoted = t => `${taskId(t.seq)} «${t.title}»`
  const forWhom = (t, coordinator) => (t.assignee === coordinator ? 'you' : `your worker ${t.assignee}`)
  const READ_IT = 'Read each with board (action "get") before starting; when you hand one to a worker, tell the worker yourself.'

  // Told now: the tasks a person gave this team and said to tell it about.
  function notifyTeam(coordinator, tasks, by) {
    const lines = tasks.map(t => { const s = statusRow(t.status_id); const next = s?.next_id ? statusRow(s.next_id)?.name : null; return `- ${quoted(t)} → ${forWhom(t, coordinator)} [${s?.name ?? '?'}${next ? `; when done: «${next}»` : ''}]` })
    const text = `From the task board, the user's order (${by.name}): ${tasks.length === 1 ? 'this task is' : 'these tasks are'} now your team's.\n${lines.join('\n')}\n${READ_IT}`
    if (!tell(coordinator, text)) return false
    for (const t of tasks) {
      db.prepare("UPDATE tasks SET notify_state = 'sent', notified_to = ? WHERE seq = ?").run(coordinator, t.seq)
      event(t.seq, by, 'notified', { to: coordinator })
    }
    return true
  }

  // Once a team was told, it is told too when that stops being so.
  function correct(before, after, by) {
    const told = before.notify_state === 'sent' ? before.notified_to : null
    if (!told) return
    const sameAssignee = after && after.assignee_kind === before.assignee_kind && after.assignee === before.assignee
    let text = null
    if (!after) text = `From the task board: the user (${by.name}) deleted ${quoted(before)}. Stop working on it and don't hand it out.`
    else if (!sameAssignee) {
      const now = after.assignee_kind === 'session' && teamOf(after.assignee) === told ? `it now goes to ${forWhom(after, told)}, who will be told when the user says so` : 'it is no longer your team\'s'
      text = `From the task board: the user (${by.name}) changed who has ${quoted(before)}: ${now}. Stop working on it until then.`
    } else if (categoryOf(after) === 'closed' && categoryOf(before) !== 'closed') text = `From the task board: the user (${by.name}) cancelled ${quoted(before)}. Stop working on it.`
    if (!text) return
    tell(told, text)
    if (after && !sameAssignee) db.prepare("UPDATE tasks SET notify_state = CASE WHEN assignee_kind = 'session' THEN 'pending' ELSE 'none' END, notified_to = NULL WHERE seq = ?").run(after.seq)
    if (after && sameAssignee) db.prepare("UPDATE tasks SET notify_state = 'pending', notified_to = NULL WHERE seq = ?").run(after.seq)
  }

  // --- the flow: a column as a step ----------------------------------------------
  // Who a task moved into this column goes to (if they still can have it).
  function handlerOf(s, boardId) {
    if (!s?.handler_kind) return null
    try { return checkAssignee(boardId, { kind: s.handler_kind, id: s.handler }) } catch { return null }
  }
  const nameOf = id => (id ? statusRow(id)?.name ?? null : null)
  // What a step asks, said to whoever does it.
  function stepText(s) {
    const next = nameOf(s.next_id), back = nameOf(s.back_id)
    return [
      s.instructions ? `The step: ${s.instructions}` : '',
      next ? `When done, move it to «${next}»${back ? `; if it isn't acceptable, back to «${back}»` : ''}.` : back ? `If it isn't acceptable, move it back to «${back}».` : '',
    ].filter(Boolean).join(' ')
  }
  // Moved along the flow by an agent: the team that has it now hears at once
  // (the flow is the people's word). Its own coordinator moving it there knows.
  function handOn(t, by) {
    const team = teamOf(t.assignee)
    if (!team) return
    const s = statusRow(t.status_id)
    const sent = () => db.prepare("UPDATE tasks SET notify_state = 'sent', notified_to = ? WHERE seq = ?").run(team, t.seq)
    if (by.kind === 'session' && by.id === team) return sent()
    const text = `From the task board, the user's flow: ${by.name} moved ${quoted(t)} to «${s.name}», a step now for ${forWhom(t, team)}. ${stepText(s)} ${READ_IT}`.replace(/ {2,}/g, ' ')
    if (!tell(team, text)) return
    sent()
    event(t.seq, by, 'notified', { to: team })
  }

  // --- changing a task ----------------------------------------------------------
  // What can be set on a task, checked against its board.
  function fields(board, p, { creating, seq = null }) {
    const out = {}
    if (creating || p.title !== undefined) {
      out.title = short(p.title, MAX.title, 'title')
      if (!out.title) throw bad('a task needs a title')
    }
    if (p.description !== undefined) out.description = short(p.description, MAX.description, 'description', { lines: true }) || null
    if (p.status !== undefined && p.status !== null) {
      const s = findIn(statusesOf(board.id), p.status, 'status')
      out.status_id = s.id
    } else if (creating) {
      const list = statusesOf(board.id)
      out.status_id = (list.find(s => s.category === 'unstarted') ?? list[0])?.id
      if (!out.status_id) throw bad('this board has no statuses')
    }
    if (p.type !== undefined) out.type_id = p.type === null || p.type === '' ? null : findIn(typesOf(board.id), p.type, 'type').id
    if (p.labels !== undefined) {
      if (!Array.isArray(p.labels)) throw bad('labels must be a list')
      if (p.labels.length > MAX.labelsPerTask) throw bad(`at most ${MAX.labelsPerTask} labels on a task`)
      const all = labelsOf(board.id)
      out.labels = [...new Set(p.labels.map(l => findIn(all, l, 'label').id))]
    }
    if (p.priority !== undefined) {
      const n = Number(p.priority ?? 0)
      if (!Number.isInteger(n) || n < 0 || n > 4) throw bad('priority is 0 (none) to 4 (urgent)')
      out.priority = n
    }
    if (p.due !== undefined) {
      if (p.due === null || p.due === '') out.due = null
      else if (!DUE_RE.test(String(p.due)) || Number.isNaN(Date.parse(String(p.due)))) throw bad('due is a date: YYYY-MM-DD')
      else out.due = String(p.due)
    }
    if (p.parent !== undefined) out.parent_seq = checkParent(board, p.parent, seq)
    if (p.people !== undefined) out.people = checkPeople(p.people)
    if (p.rank !== undefined) {
      const r = Number(p.rank)
      if (!Number.isFinite(r)) throw bad('rank must be a number')
      out.rank = r
    }
    return out
  }
  // By its id, or by its name (any case): what an agent says.
  function findIn(list, value, what) {
    const hit = list.find(x => x.id === Number(value)) ?? list.find(x => x.name.toLowerCase() === String(value).trim().toLowerCase())
    if (!hit) throw bad(`no ${what} "${String(value).slice(0, 40)}" on this board: ${list.map(x => x.name).join(', ') || 'none'}`)
    return hit
  }

  function setPeople(seq, ids) {
    db.prepare('DELETE FROM task_people WHERE task_seq = ?').run(seq)
    ids.forEach((id, i) => db.prepare('INSERT INTO task_people (task_seq, user_id, position) VALUES (?, ?, ?)').run(seq, id, i))
  }
  function writeTask(seq, f, by) {
    const cols = Object.keys(f).filter(k => k !== 'labels' && k !== 'people')
    if (cols.length) db.prepare(`UPDATE tasks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE seq = ?`).run(...cols.map(c => f[c]), seq)
    if (f.labels) {
      db.prepare('DELETE FROM task_labels WHERE task_seq = ?').run(seq)
      for (const l of f.labels) db.prepare('INSERT INTO task_labels (task_seq, label_id) VALUES (?, ?)').run(seq, l)
    }
    if (f.people) setPeople(seq, f.people)
    db.prepare('UPDATE tasks SET updated_by = ?, updated_at = ?, version = version + 1 WHERE seq = ?').run(JSON.stringify(by), now(), seq)
  }

  // What the history says changed (not the description's text: only that it did).
  function changes(before, f) {
    const out = {}
    for (const [k, v] of Object.entries(f)) {
      if (k === 'rank' || k === 'notify_state' || k === 'notified_to') continue
      if (k === 'labels') { const old = db.prepare('SELECT label_id FROM task_labels WHERE task_seq = ? ORDER BY label_id').all(before.seq).map(r => r.label_id); if (old.join() !== [...v].sort((a, b) => a - b).join()) out.labels = v; continue }
      if (k === 'description') { if ((before.description ?? null) !== v) out.description = true; continue }
      if (k === 'people') { if ([...peopleOf(before.seq)].sort().join() !== [...v].sort().join()) out.people = v.map(id => ({ id, name: memberName(id) ?? '?' })); continue }
      if ((before[k] ?? null) !== v) out[k] = v
    }
    return out
  }

  function createTask(board, p, by, { assignee = null, notifyNow = false, byAgentTeam = null } = {}) {
    if (board.archived_at) throw bad('this board is archived')
    if (liveCount(board.id) >= MAX.tasks) throw bad(`at most ${MAX.tasks} tasks on a board: archive this one and start another`)
    const f = fields(board, p, { creating: true })
    // (Nobody given, in a column someone handles: theirs.)
    let viaFlow = false
    const h = handlerOf(statusRow(f.status_id), board.id)
    if (h?.kind === 'session' && !assignee) { assignee = h; viaFlow = true }
    if (h?.kind === 'user') f.people = withPerson(f.people ?? [], h.id) // (a person's step: one of its people too)
    const rank = f.rank ?? (db.prepare('SELECT MAX(rank) r FROM tasks WHERE board_id = ?').get(board.id).r ?? 0) + 1
    const at = now(), json = JSON.stringify(by)
    // (Given by its own coordinator: that coordinator knows already.)
    const state = assignee?.kind === 'session' ? (byAgentTeam && !viaFlow ? 'sent' : 'pending') : 'none'
    const info = db.prepare(`INSERT INTO tasks (board_id, title, description, status_id, type_id, priority, due, rank, assignee_kind, assignee, notify_state, notified_to, created_by, created_at, updated_by, updated_at, parent_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(board.id, f.title, f.description ?? null, f.status_id, f.type_id ?? null, f.priority ?? 0, f.due ?? null, rank,
      assignee?.kind ?? null, assignee?.id ?? null, state, state === 'sent' ? byAgentTeam : null, json, at, json, at, f.parent_seq ?? null)
    const seq = Number(info.lastInsertRowid)
    for (const l of f.labels ?? []) db.prepare('INSERT INTO task_labels (task_seq, label_id) VALUES (?, ?)').run(seq, l)
    if (f.people?.length) setPeople(seq, f.people)
    const said = { ...(assignee ? { assignee } : {}), ...(f.people?.length ? { people: f.people.map(id => ({ id, name: memberName(id) ?? '?' })) } : {}), ...(f.parent_seq ? { parent: taskId(f.parent_seq) } : {}) }
    event(seq, by, 'created', Object.keys(said).length ? said : null)
    if (viaFlow && by.kind === 'session' && assignee.kind === 'session') handOn(taskRow(seq), by)
    if (notifyNow) notifyIfDue(seq, by)
    return seq
  }

  // A person said to tell the team now: if it is in a column where work waits.
  function notifyIfDue(seq, by) {
    const t = taskRow(seq)
    if (t?.notify_state !== 'pending' || t.assignee_kind !== 'session' || !ACTIVE.has(categoryOf(t))) return false
    const team = teamOf(t.assignee)
    return team ? notifyTeam(team, [t], by) : false
  }

  function updateTask(seq, p, by, { assignee, human }) {
    const before = taskRow(seq)
    const board = boardRow(before.board_id)
    if (board.archived_at) throw bad('this board is archived')
    const f = fields(board, p, { creating: false, seq })
    const sameAs = a => (a?.kind ?? null) === (before.assignee_kind ?? null) && (a?.id ?? null) === (before.assignee ?? null)
    // Moved into a column someone handles, with nobody else said: theirs now.
    let viaFlow = false
    if (f.status_id !== undefined && f.status_id !== before.status_id) {
      const h = handlerOf(statusRow(f.status_id), board.id)
      if (h?.kind === 'session' && (assignee === undefined || sameAs(assignee)) && !sameAs(h)) { assignee = h; viaFlow = true }
      if (h?.kind === 'user') f.people = withPerson(f.people ?? peopleOf(seq), h.id) // (a person's step: one of its people too)
    }
    if (assignee !== undefined && !sameAs(assignee)) {
      f.assignee_kind = assignee?.kind ?? null
      f.assignee = assignee?.id ?? null
      // (Given by an agent to its own team: it knows. Along the flow: told below.
      // By a person: pending until they say.)
      f.notify_state = assignee?.kind === 'session' ? (human || viaFlow ? 'pending' : 'sent') : 'none'
      f.notified_to = !human && !viaFlow && assignee?.kind === 'session' ? teamOf(assignee.id) : null
    }
    const diff = changes(before, f)
    // (Who has it, said once: as the history reads it.)
    if ('assignee' in diff || 'assignee_kind' in diff) { delete diff.assignee_kind; diff.assignee = assignee ?? null }
    if ('parent_seq' in diff) { diff.parent = diff.parent_seq ? taskId(diff.parent_seq) : null; delete diff.parent_seq }
    if (!Object.keys(diff).length && (f.rank === undefined || f.rank === before.rank)) return false
    writeTask(seq, f, by)
    if (Object.keys(diff).length) event(seq, by, 'changed', diff)
    if (human) correct(before, taskRow(seq), by)
    else if (viaFlow && assignee?.kind === 'session') handOn(taskRow(seq), by)
    return viaFlow ? 'flow' : true
  }

  function commentOn(seq, text, by) {
    const body = short(text, MAX.comment, 'comment', { lines: true })
    if (!body) throw bad('the comment is empty')
    if (db.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_seq = ? AND deleted_at IS NULL').get(seq).n >= MAX.comments) throw bad(`at most ${MAX.comments} comments on a task`)
    const id = Number(db.prepare('INSERT INTO task_comments (task_seq, author, text, created_at) VALUES (?, ?, ?, ?)').run(seq, JSON.stringify(by), body, now()).lastInsertRowid)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE seq = ?').run(now(), seq)
    return { id, body }
  }

  // --- people (the dashboard) ---------------------------------------------------
  function boardConfig(boardId, p, { creating }) {
    const out = {}
    if (creating || p.name !== undefined) {
      out.name = short(p.name, MAX.name, 'name')
      if (!out.name) throw bad('a board needs a name')
    }
    if (p.description !== undefined) out.description = short(p.description, MAX.boardDescription, 'description', { lines: true }) || null
    if (p.teams !== undefined) {
      if (!Array.isArray(p.teams) || p.teams.length > MAX.teams) throw bad(`teams must be a list of coordinators (at most ${MAX.teams})`)
      out.teams = [...new Set(p.teams.map(String))]
      for (const c of out.teams) if (!NAME_RE.test(c) || teamOf(c) !== c) throw bad(`"${c.slice(0, 40)}" is not the coordinator of a team`)
    }
    const listOf = (key, max, withCategory) => {
      if (p[key] === undefined) return
      if (!Array.isArray(p[key]) || !p[key].length && withCategory) throw bad(`${key} must be a list${withCategory ? ', with at least one' : ''}`)
      if (p[key].length > max) throw bad(`at most ${max} ${key}`)
      const names = new Set()
      out[key] = p[key].map((x, i) => {
        const name = short(x?.name, MAX.name, `${key} ${i + 1}'s name`)
        if (!name) throw bad(`${key} ${i + 1} needs a name`)
        if (names.has(name.toLowerCase())) throw bad(`two ${key} are called "${name}"`)
        names.add(name.toLowerCase())
        const id = x.id == null ? null : Number(x.id)
        if (withCategory) {
          if (!CATEGORIES.includes(x.category)) throw bad(`${key} ${i + 1}'s category must be one of: ${CATEGORIES.join(', ')}`)
          return { id, name, category: x.category }
        }
        return { id, name, color: COLORS.includes(x.color) ? x.color : 'gray' }
      })
    }
    listOf('statuses', MAX.statuses, true)
    listOf('labels', MAX.labels, false)
    listOf('types', MAX.types, false)
    for (const [key, table] of [['statuses', 'board_statuses'], ['labels', 'board_labels'], ['types', 'board_types']]) if (out[key]) checkList(boardId, table, out[key])
    return out
  }

  // A list of statuses, labels or types as it is now: ids kept, new ones added,
  // the ones left out deleted (a status only once no task is in it).
  // (Checked before anything is written: a list refused changes nothing.)
  function checkList(boardId, table, list) {
    const old = boardId == null ? [] : db.prepare(`SELECT * FROM ${table} WHERE board_id = ?`).all(boardId)
    const kept = new Set(list.filter(x => x.id != null).map(x => x.id))
    for (const x of list) if (x.id != null && !old.some(o => o.id === x.id)) throw bad(`there is no ${table.replace('board_', '').slice(0, -1)} ${x.id} on this board`)
    if (table !== 'board_statuses') return
    for (const o of old.filter(o => !kept.has(o.id))) {
      const n = db.prepare('SELECT COUNT(*) n FROM tasks WHERE status_id = ? AND deleted_at IS NULL').get(o.id).n // (one in the trash goes back to another column)
      if (n) throw bad(`the status "${o.name}" has ${n} task${n === 1 ? '' : 's'}: move ${n === 1 ? 'it' : 'them'} first`)
    }
  }
  function saveList(boardId, table, list, withCategory) {
    const old = db.prepare(`SELECT * FROM ${table} WHERE board_id = ?`).all(boardId)
    const kept = new Set(list.filter(x => x.id != null).map(x => x.id))
    for (const o of old.filter(o => !kept.has(o.id))) {
      if (table === 'board_types') db.prepare('UPDATE tasks SET type_id = NULL WHERE type_id = ?').run(o.id)
      if (table === 'board_statuses') for (const c of ['next_id', 'back_id']) db.prepare(`UPDATE board_statuses SET ${c} = NULL WHERE ${c} = ?`).run(o.id)
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(o.id)
    }
    list.forEach((x, i) => {
      const extra = withCategory ? x.category : x.color
      const col = withCategory ? 'category' : 'color'
      if (x.id == null) db.prepare(`INSERT INTO ${table} (board_id, name, ${col}, position) VALUES (?, ?, ?, ?)`).run(boardId, x.name, extra, i)
      else db.prepare(`UPDATE ${table} SET name = ?, ${col} = ?, position = ? WHERE id = ?`).run(x.name, extra, i, x.id)
    })
  }

  function saveTeams(boardId, teams) {
    const before = teamsOf(boardId)
    // (A team no longer on the board: its tasks there stay, but nobody of it has them.)
    for (const gone of before.filter(c => !teams.includes(c))) {
      for (const t of db.prepare("SELECT * FROM tasks WHERE board_id = ? AND deleted_at IS NULL AND assignee_kind = 'session'").all(boardId)) {
        if (teamOf(t.assignee) === gone) {
          const by = { kind: 'user', id: 'server', name: 'board settings' }
          updateTask(t.seq, {}, by, { assignee: null, human: true })
        }
      }
    }
    // (Nor does any session of it handle a step there.)
    for (const r of db.prepare("SELECT id, handler FROM board_statuses WHERE board_id = ? AND handler_kind = 'session'").all(boardId)) {
      if (!teams.includes(teamOf(r.handler))) db.prepare('UPDATE board_statuses SET handler_kind = NULL, handler = NULL WHERE id = ?').run(r.id)
    }
    db.prepare('DELETE FROM board_teams WHERE board_id = ?').run(boardId)
    for (const c of teams) db.prepare('INSERT INTO board_teams (board_id, coordinator) VALUES (?, ?)').run(boardId, c)
  }

  const humanBoard = id => {
    const b = boardRow(id)
    if (!b) throw new ApiError(404, 'Not Found: no such board')
    return b
  }
  const humanTask = id => {
    const t = taskRow(seqOf(id))
    if (!t) throw new ApiError(404, `Not Found: no task ${String(id).slice(0, 40)}`)
    return t
  }
  const versionCheck = (t, p) => {
    if (p.version != null && Number(p.version) !== t.version) {
      throw new ApiError(409, `Conflict: ${taskId(t.seq)} changed meanwhile`, { parameters: { reason: 'changed', task: taskView(t, { full: true }) } })
    }
  }
  // --- the trash -------------------------------------------------------------------
  const liveCount = boardId => db.prepare('SELECT COUNT(*) n FROM tasks WHERE board_id = ? AND deleted_at IS NULL').get(boardId).n
  // Its subtasks, all levels down, parents first.
  function subtasksOf(seq) {
    const out = []
    for (let level = childrenOf(seq), n = 0; level.length && n < MAX.depth; n++) { out.push(...level); level = level.flatMap(c => childrenOf(c.seq)) }
    return out
  }
  // The subtasks in the trash that were deleted with it, all levels down, parents first.
  function trashedWith(t) {
    const out = []
    const under = seq => db.prepare('SELECT * FROM tasks WHERE parent_seq = ? AND deleted_at IS NOT NULL AND trash_batch = ? ORDER BY rank, seq').all(seq, t.trash_batch)
    for (let level = under(t.seq), n = 0; level.length && n < MAX.depth; n++) { out.push(...level); level = level.flatMap(c => under(c.seq)) }
    return out
  }
  // (github: removed from the project there; nothing to do there about it.)
  function trashTasks(t, { subtasks = false, by, data = null, github = false }) {
    const gone = [t, ...(subtasks ? subtasksOf(t.seq) : [])]
    const loose = subtasks ? [] : childrenOf(t.seq).map(c => c.seq)
    const at = now()
    inTx(() => {
      for (const x of gone) {
        correct(x, null, by)
        if (!github) sync.taskDeleted(x)
        db.prepare('UPDATE tasks SET deleted_at = ?, deleted_by = ?, trash_batch = ?, version = version + 1 WHERE seq = ?').run(at, JSON.stringify(by), t.seq, x.seq)
        event(x.seq, by, 'deleted', x.seq === t.seq ? data : { with: taskId(t.seq) })
      }
      // (Its subtasks left on the board stay, with no parent: as GitHub does.)
      for (const c of loose) { db.prepare('UPDATE tasks SET parent_seq = NULL, version = version + 1 WHERE seq = ?').run(c); event(c, by, 'changed', { parent: null }) }
    })
    for (const x of gone) broadcast('task', { id: taskId(x.seq), seq: x.seq, board: x.board_id, deleted: true })
    for (const c of loose) changedTask(c)
    if (t.parent_seq) changedTask(t.parent_seq)
    changedBoard()
    return gone.map(x => x.seq)
  }
  function restoreTasks(t, { subtasks = false, by, github = false }) {
    const b = humanBoard(t.board_id)
    if (b.archived_at) throw bad('this board is archived')
    const back = [t, ...(subtasks ? trashedWith(t) : [])]
    if (liveCount(b.id) + back.length > MAX.tasks) throw bad(`at most ${MAX.tasks} tasks on a board`)
    const statuses = statusesOf(b.id)
    const home = statuses.find(s => ACTIVE.has(s.category))?.id ?? statuses[0]?.id
    let withoutParent = null
    inTx(() => {
      for (const x of back) {
        let parent = x.parent_seq
        if (x.seq === t.seq && parent) {
          // (Its parent on the board, and room under it: back under it. Otherwise with no parent.)
          let ok = !!taskRow(parent)
          if (ok) { try { checkParent(b, parent, null) } catch { ok = false } }
          if (!ok) { withoutParent = taskId(parent); parent = null }
        }
        // (Its column gone: the first where work waits. Who had it can't any more: nobody.)
        const status = statuses.some(s => s.id === x.status_id) ? x.status_id : home
        let assignee = x.assignee_kind ? { kind: x.assignee_kind, id: x.assignee } : null
        if (assignee) { try { assignee = checkAssignee(b.id, assignee) } catch { assignee = null } }
        db.prepare(`UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL, parent_seq = ?, status_id = ?, assignee_kind = ?, assignee = ?,
          notify_state = ?, notified_to = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE seq = ?`)
          .run(parent ?? null, status, assignee?.kind ?? null, assignee?.id ?? null, assignee?.kind === 'session' ? 'pending' : 'none', JSON.stringify(by), now(), x.seq)
        event(x.seq, by, 'restored', x.seq === t.seq ? (withoutParent ? { without_parent: withoutParent } : null) : { with: taskId(t.seq) })
        if (!github) sync.taskRestored(x.seq)
      }
    })
    for (const x of back) changedTask(x.seq)
    changedBoard()
    return { restored: back.map(x => taskId(x.seq)), without_parent: withoutParent }
  }


  const boardReads = {
    boards: () => ({ prefix: prefix(), boards: boardList(), members: memberList().map(m => ({ id: m.id, name: m.name, github: m.github ?? null })), sessions: Object.fromEntries(db.prepare('SELECT id FROM boards').all().map(b => [b.id, assignableSessions(b.id)])) }),
    tasks(q) {
      const b = humanBoard(q.get('board'))
      return db.prepare('SELECT * FROM tasks WHERE board_id = ? AND deleted_at IS NULL ORDER BY rank, seq').all(b.id).map(t => taskView(t))
    },
    // The board's trash: the latest deleted first, each with its parent (on the board or in the trash too) and the subtasks deleted with it.
    trash(q) {
      const b = humanBoard(q.get('board'))
      return db.prepare('SELECT * FROM tasks WHERE board_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, seq LIMIT 500').all(b.id).map(t => {
        const parent = t.parent_seq ? anyTask(t.parent_seq) : null
        return {
          id: taskId(t.seq), seq: t.seq, title: t.title, deleted_at: t.deleted_at, deleted_by: who(t.deleted_by),
          parent: parent ? { id: taskId(parent.seq), seq: parent.seq, title: parent.title, trashed: !!parent.deleted_at } : null,
          subtasks: trashedWith(t).length,
        }
      })
    },
    task: q => taskView(humanTask(q.get('id')), { full: true }),
  }

  const boardActions = {
    'boards/create'(p, actor) {
      if (db.prepare('SELECT COUNT(*) n FROM boards').get().n >= MAX.boards) throw bad(`at most ${MAX.boards} boards`)
      const c = boardConfig(null, { statuses: DEFAULT_STATUSES.map(([name, category]) => ({ name, category })), types: DEFAULT_TYPES.map(([name, color]) => ({ name, color })), ...p }, { creating: true })
      const id = inTx(() => {
        const at = now()
        const id = Number(db.prepare('INSERT INTO boards (name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(c.name, c.description ?? null, JSON.stringify(person(actor)), at, at).lastInsertRowid)
        saveList(id, 'board_statuses', c.statuses, true)
        saveList(id, 'board_types', c.types, false)
        if (c.labels) saveList(id, 'board_labels', c.labels, false)
        if (c.teams) saveTeams(id, c.teams)
        return id
      })
      changedBoard()
      return boardView(boardRow(id))
    },
    'boards/update'(p) {
      const b = humanBoard(p.id)
      const c = boardConfig(b.id, p, { creating: false })
      inTx(() => {
        if (c.name !== undefined || c.description !== undefined) db.prepare('UPDATE boards SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END WHERE id = ?').run(c.name ?? null, c.description !== undefined ? 1 : 0, c.description ?? null, b.id)
        if (c.statuses) {
          const was = statusesOf(b.id).map(s => `${s.id}:${s.name}`).join()
          saveList(b.id, 'board_statuses', c.statuses, true)
          if (statusesOf(b.id).map(s => `${s.id}:${s.name}`).join() !== was) sync.columnsChanged(b.id)
        }
        if (c.labels) saveList(b.id, 'board_labels', c.labels, false)
        if (c.types) saveList(b.id, 'board_types', c.types, false)
        if (c.teams) saveTeams(b.id, c.teams)
        if (p.archived !== undefined) db.prepare('UPDATE boards SET archived_at = ? WHERE id = ?').run(p.archived ? now() : null, b.id)
        db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(now(), b.id)
      })
      sync.touch(b.id)
      changedBoard()
      return boardView(boardRow(b.id))
    },
    // Kept in step with a GitHub project: its address, a repository for new issues, a token.
    async 'boards/github'(p, actor) {
      const b = humanBoard(p.board)
      if (b.archived_at) throw bad('this board is archived')
      return sync.connect(b, p, person(actor))
    },
    // Whether a merged pull request takes its tasks to done.
    'boards/github-merge'(p) {
      const b = humanBoard(p.board)
      if (!sync.view(b.id)) throw bad('this board is not connected to GitHub')
      sync.setMergeMoves(b.id, !!p.on)
      return boardView(boardRow(b.id))
    },
    'boards/github-off'(p) {
      const b = humanBoard(p.board)
      sync.disconnect(b.id)
      return boardView(boardRow(b.id))
    },
    // Someone has the board open (and maybe a task): GitHub is read if it isn't fresh.
    async 'boards/github-watch'(p) {
      const b = humanBoard(p.board)
      await sync.watch(b.id, { task: p.task == null ? null : Number(p.task), opened: p.opened === true, taskOpened: p.taskOpened === true, force: p.force === true })
      return true
    },
    async 'boards/github-sync'(p) {
      const b = humanBoard(p.board)
      if (!sync.view(b.id)) throw bad('this board is not connected to GitHub')
      await sync.syncBoard(b.id)
      return boardView(boardRow(b.id))
    },
    'boards/delete'(p) {
      const b = humanBoard(p.id)
      if (!b.archived_at) throw bad('archive the board first: deleting it deletes its tasks')
      db.prepare('DELETE FROM boards WHERE id = ?').run(b.id)
      broadcast('board-deleted', { id: b.id })
      changedBoard()
      return { id: b.id, deleted: true }
    },
    // One column's step: who handles it, what to do there, where it goes next.
    'boards/flow'(p) {
      const b = humanBoard(p.board)
      const s = statusesOf(b.id).find(x => x.id === Number(p.status))
      if (!s) throw bad('no such status on this board')
      const handler = p.handler == null || p.handler === '' ? null : checkAssignee(b.id, p.handler)
      const instructions = short(p.instructions ?? '', MAX.instructions, 'instructions', { lines: true }) || null
      const ref = (v, what) => {
        if (v == null || v === '') return null
        const to = findIn(statusesOf(b.id), v, 'status')
        if (to.id === s.id) throw bad(`${what} is another status, not this one`)
        return to.id
      }
      const next = ref(p.next, 'where it goes when done'), back = ref(p.back, 'where it goes back')
      db.prepare('UPDATE board_statuses SET handler_kind = ?, handler = ?, instructions = ?, next_id = ?, back_id = ? WHERE id = ?').run(handler?.kind ?? null, handler?.id ?? null, instructions, next, back, s.id)
      db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(now(), b.id)
      changedBoard()
      return boardView(boardRow(b.id))
    },
    'boards/prefix'(p) {
      const v = String(p.prefix ?? '').trim().toUpperCase()
      if (!PREFIX_RE.test(v)) throw bad('the prefix is 1 to 6 letters or digits, starting with a letter (such as SQ)')
      db.prepare("INSERT INTO board_settings (k, v) VALUES ('prefix', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(v)
      changedBoard()
      return { prefix: v }
    },
    'tasks/create'(p, actor) {
      const b = humanBoard(p.board)
      const by = person(actor)
      const seq = inTx(() => createTask(b, p, by, { assignee: agentParam(b, p) ?? null, notifyNow: p.notify === true }))
      changedTask(seq)
      return taskView(taskRow(seq), { full: true })
    },
    'tasks/update'(p, actor) {
      const t = humanTask(p.id)
      versionCheck(t, p)
      const by = person(actor)
      const assignee = agentParam(boardRow(t.board_id), p)
      inTx(() => {
        updateTask(t.seq, p, by, { assignee, human: true })
        if (p.notify === true) notifyIfDue(t.seq, by)
      })
      changedTask(t.seq, t.parent_seq)
      return taskView(taskRow(t.seq), { full: true })
    },
    // Into the trash, with its subtasks if asked; if not, they stay on the board with no parent.
    'tasks/delete'(p, actor) {
      const t = humanTask(p.id)
      const gone = trashTasks(t, { subtasks: p.subtasks === true, by: person(actor) })
      return { id: taskId(t.seq), deleted: true, trashed: gone.map(taskId) }
    },
    // Out of the trash, with the subtasks deleted with it if asked. Its parent
    // still in the trash (or gone): restored with no parent, and said so.
    'tasks/restore'(p, actor) {
      const t = anyTask(seqOf(p.id))
      if (!t?.deleted_at) throw new ApiError(404, `Not Found: no task ${String(p.id).slice(0, 40)} in the trash`)
      return restoreTasks(t, { subtasks: p.subtasks === true, by: person(actor) })
    },
    'tasks/comment'(p, actor) {
      const t = humanTask(p.id)
      const by = person(actor)
      const c = inTx(() => commentOn(t.seq, p.text, by))
      // Said to the coordinator too, if asked: the user's word on that task.
      let notified = null
      if (p.notify === true && t.assignee_kind === 'session') {
        const team = teamOf(t.assignee)
        if (team && tell(team, `From the task board, the user's order (${by.name}) on ${quoted(t)}, which ${forWhom(t, team)} ${t.assignee === team ? 'have' : 'has'}: ${c.body}`)) {
          notified = team
          db.prepare('UPDATE task_comments SET notified = ? WHERE id = ?').run(team, c.id)
        }
      }
      changedTask(t.seq)
      return { id: c.id, notified }
    },
    // Every task waiting to be told, each team in one message.
    'tasks/notify'(p, actor) {
      const b = humanBoard(p.board)
      const by = person(actor)
      const wanted = Array.isArray(p.ids) ? new Set(p.ids.map(seqOf)) : null
      const byTeam = new Map()
      for (const t of pendingOf(b.id)) {
        if (wanted && !wanted.has(t.seq)) continue
        const team = teamOf(t.assignee)
        if (!team || !teamsOf(b.id).includes(team)) continue
        if (!byTeam.has(team)) byTeam.set(team, [])
        byTeam.get(team).push(t)
      }
      const told = [], failed = []
      for (const [team, list] of byTeam) (inTx(() => notifyTeam(team, list, by)) ? told : failed).push({ team, tasks: list.map(t => taskId(t.seq)) })
      for (const list of byTeam.values()) for (const t of list) broadcast('task', taskView(taskRow(t.seq)))
      changedBoard()
      return { told, failed }
    },
  }

  // --- agents (the plugin's board tool) -------------------------------------------
  // A coordinator acts for its team; a worker for itself. (An unapproved
  // coordinator, or a session in no team, sees no board.)
  function agentOf(name) {
    const r = db.prepare('SELECT role, coordinator, needs_approval FROM identities WHERE name = ?').get(name)
    if (r?.role === 'coordinator' && !r.needs_approval) return { name, role: 'coordinator', team: name }
    if (r?.role === 'worker' && r.coordinator) return { name, role: 'worker', team: r.coordinator }
    throw new ApiError(403, r?.role === 'coordinator' ? 'Forbidden: an approved coordinator sees its team\'s boards: the user must approve this session first' : 'Forbidden: only the sessions of a team see its boards')
  }
  const agentBoards = me => db.prepare('SELECT b.* FROM boards b JOIN board_teams t ON t.board_id = b.id WHERE t.coordinator = ? AND b.archived_at IS NULL ORDER BY b.name COLLATE NOCASE, b.id').all(me.team)
  const mine = (me, t) => t.assignee_kind === 'session' && t.assignee === me.name
  // A coordinator changes what is its team's or nobody's.
  const ours = (me, t) => !t.assignee_kind || (t.assignee_kind === 'session' && teamOf(t.assignee) === me.team)
  const notFound = id => new ApiError(404, `Not Found: no task ${String(id ?? '').slice(0, 40)} on your boards`)
  function agentTask(me, id) {
    const t = taskRow(seqOf(id))
    if (!t || !teamsOf(t.board_id).includes(me.team) || boardRow(t.board_id).archived_at) throw notFound(id)
    if (me.role === 'worker' && !mine(me, t)) throw notFound(id)
    return t
  }
  function agentBoard(me, id) {
    const list = agentBoards(me)
    if (id == null || id === '') {
      if (list.length === 1) return list[0]
      throw bad(list.length ? `say which board: ${list.map(b => `${b.id} (${b.name})`).join(', ')}` : 'your team sees no board')
    }
    const hit = list.find(b => b.id === Number(id)) ?? list.find(b => b.name.toLowerCase() === String(id).trim().toLowerCase())
    if (!hit) throw bad(`your team sees no board "${String(id).slice(0, 40)}"${list.length ? `: ${list.map(b => `${b.id} (${b.name})`).join(', ')}` : ''}`)
    return hit
  }
  function agentAssignee(me, board, value) {
    if (value === undefined) return undefined
    if (value === null || value === '') return null
    const a = checkAssignee(board.id, { kind: 'session', id: String(value) })
    if (teamOf(a.id) !== me.team) throw bad(`"${a.id}" is not in your team: you give tasks to yourself or your workers. If a person must do it, ask_user`)
    return a
  }

  // How an agent reads a task: names, not ids.
  function agentView(t, { full = false } = {}) {
    const v = taskView(t, { full })
    const status = statusRow(t.status_id)
    const typeName = t.type_id ? typesOf(t.board_id).find(x => x.id === t.type_id)?.name ?? null : null
    const labels = labelsOf(t.board_id).filter(l => v.labels.includes(l.id)).map(l => l.name)
    const out = {
      id: v.id, title: v.title, status: status?.name ?? null, category: status?.category ?? null, type: typeName, labels,
      priority: v.priority || undefined, due: v.due ?? undefined,
      assignee: v.assignee ? (v.assignee.kind === 'user' ? `${v.assignee.name} (a person)` : v.assignee.id) : null,
      people: v.people.length ? v.people.map(x => x.name).join(', ') : undefined,
      board: boardRow(t.board_id)?.name,
      when_done: nameOf(status?.next_id) ?? undefined,
      parent: t.parent_seq ? quoted(taskRow(t.parent_seq)) : undefined,
      subtasks: v.subtasks ? `${v.subtasks.done} of ${v.subtasks.total} finished` : undefined,
      pull_requests: v.prs.length ? v.prs.map(p => `#${p.number} «${p.title}»: ${p.state}${p.review ? ` (review: ${p.review})` : ''}`) : undefined,
    }
    if (!full) return out
    const handler = status && handlerOf(status, t.board_id)
    if (status && (handler || status.instructions || status.next_id || status.back_id)) {
      out.step = {
        handled_by: handler ? (handler.kind === 'user' ? `${handler.name} (a person)` : handler.id) : undefined,
        instructions: status.instructions || undefined, when_done: nameOf(status.next_id) ?? undefined, if_rejected: nameOf(status.back_id) ?? undefined,
      }
    }
    if (v.children.length) out.subtasks = v.children.map(c => `${c.id} «${c.title}»: ${statusRow(c.status)?.name ?? '?'}${c.assignee ? `, ${c.assignee.kind === 'user' ? `${c.assignee.name} (a person)` : c.assignee.id}` : ''}${c.people.length ? `, people: ${c.people.map(x => x.name).join(', ')}` : ''}`)
    return {
      ...out, description: v.description || undefined,
      comments: v.comments.map(c => `${c.author?.name ?? '?'}${c.author?.kind === 'user' ? ' (a person)' : ''}, ${new Date(c.created_at).toISOString().slice(0, 16).replace('T', ' ')}: ${c.text}`),
    }
  }
  function boardForAgent(b) {
    return {
      id: b.id, name: b.name, description: b.description || undefined,
      statuses: statusesOf(b.id).map(s => `${s.name} (${s.category})${s.handler ? `, handled by ${s.handler.kind === 'user' ? `${s.handler.name} (a person)` : s.handler.id}` : ''}${s.next ? `, then «${nameOf(s.next)}»` : ''}`), labels: labelsOf(b.id).map(l => l.name), types: typesOf(b.id).map(t => t.name),
    }
  }

  // What an agent hears after the flow gave its task on: who has it, and who
  // tells them (its coordinator was told; a coordinator tells its own worker).
  function handedOn(me, t) {
    const s = statusRow(t.status_id)
    const step = stepText(s)
    if (t.assignee_kind === 'user') return `The board's flow gave it to ${memberName(t.assignee) ?? 'a person'} (a person), at the step «${s.name}».`
    const team = teamOf(t.assignee)
    if (t.assignee === me.name) return `The board's flow gave it to you, at the step «${s.name}». ${step}`.trim()
    if (me.role === 'coordinator' && team === me.team) return `The board's flow gave it to your worker ${t.assignee}, at the step «${s.name}»: tell ${t.assignee} yourself now, with the task id and the step. ${step}`.trim()
    return `The board's flow gave it to ${t.assignee}, at the step «${s.name}»; the board told ${team === me.team ? 'your coordinator' : `its coordinator (${team})`}. It is not yours any more.`
  }

  function agentChange(name) {
    rateLimit(name)
    if (!allow('board', name, AGENT_CHANGES_PER_HOUR, 3600_000)) throw new ApiError(429, `Too Many Requests: at most ${AGENT_CHANGES_PER_HOUR} board changes an hour`)
  }

  const boardMethods = {
    async board(name, p) {
      const me = agentOf(name)
      const action = String(p.action ?? '')
      const by = agent(name)
      switch (action) {
        case 'boards':
          rateLimit(name)
          return agentBoards(me).map(boardForAgent)
        case 'list': {
          rateLimit(name)
          const boards = p.board == null || p.board === '' ? agentBoards(me) : [agentBoard(me, p.board)]
          await Promise.all(boards.map(b => sync.fresh(b.id))) // (GitHub's changes first, if it wasn't read lately)
          const text = p.text == null ? '' : String(p.text).toLowerCase().slice(0, 100)
          const parentWanted = p.parent == null || p.parent === '' ? null : seqOf(p.parent)
          const out = []
          for (const b of boards) {
            const statuses = statusesOf(b.id)
            const want = p.status == null || p.status === '' ? null : findIn(statuses, p.status, 'status').id
            // (Done and cancelled ones only when asked for.)
            const shown = new Set(statuses.filter(s => want ? s.id === want : !['done', 'closed'].includes(s.category)).map(s => s.id))
            for (const t of db.prepare('SELECT * FROM tasks WHERE board_id = ? AND deleted_at IS NULL ORDER BY rank, seq').all(b.id)) {
              if (!shown.has(t.status_id) && (parentWanted == null || want != null)) continue
              if (me.role === 'worker' || p.mine === true ? !mine(me, t) : false) continue
              if (p.assignee != null && p.assignee !== '' && t.assignee !== String(p.assignee)) continue
              if (parentWanted != null && t.parent_seq !== parentWanted) continue
              if (text && !`${t.title}\n${t.description ?? ''}`.toLowerCase().includes(text)) continue
              out.push(agentView(t))
              if (out.length >= 200) return { tasks: out, more: 'only the first 200: narrow it with status, assignee or text' }
            }
          }
          return { tasks: out }
        }
        case 'get': {
          rateLimit(name)
          const t = agentTask(me, p.id)
          await sync.freshTask(t) // (with GitHub's comments)
          return agentView(taskRow(t.seq) ?? t, { full: true })
        }
        case 'create': {
          if (me.role !== 'coordinator') throw new ApiError(403, 'Forbidden: workers don\'t create tasks: ask your coordinator')
          agentChange(name)
          const b = agentBoard(me, p.board)
          spendStorage('text', name, String(p.title ?? '').length + String(p.description ?? '').length)
          const assignee = agentAssignee(me, b, p.assignee) ?? null
          const seq = inTx(() => createTask(b, p, by, { assignee, byAgentTeam: assignee ? me.team : null }))
          changedTask(seq)
          const made = taskRow(seq)
          return { created: agentView(made), ...(!assignee && made.assignee_kind ? { handed_on: handedOn(me, made) } : {}) }
        }
        case 'update': {
          agentChange(name)
          const t = agentTask(me, p.id)
          const b = boardRow(t.board_id)
          let assignee
          if (me.role === 'worker') {
            const extra = ['title', 'description', 'type', 'labels', 'priority', 'due', 'assignee', 'parent'].filter(k => p[k] !== undefined)
            if (extra.length) throw new ApiError(403, `Forbidden: a worker only moves its tasks (status) and comments on them; ${extra.join(', ')} is your coordinator's to change`)
            if (p.status != null) {
              const to = findIn(statusesOf(b.id), p.status, 'status')
              const here = statusRow(t.status_id)
              const ways = [here.next_id, here.back_id].filter(Boolean)
              if (to.id !== here.id && ways.length && !ways.includes(to.id)) {
                throw new ApiError(403, `Forbidden: the board's flow takes ${taskId(t.seq)} from «${here.name}» ${here.next_id ? `to «${nameOf(here.next_id)}» when done` : ''}${here.next_id && here.back_id ? ', or ' : ''}${here.back_id ? `back to «${nameOf(here.back_id)}» if it isn't acceptable` : ''}: anything else is your coordinator's to say`)
              }
              if (to.id !== here.id && !ways.length && ['done', 'closed'].includes(to.category)) throw new ApiError(403, 'Forbidden: a worker moves its tasks up to review at most: done or cancelled is your coordinator\'s to say')
            }
          } else {
            if (!ours(me, t)) throw new ApiError(403, `Forbidden: ${taskId(t.seq)} is not your team's${t.assignee_kind === 'user' ? ' (a person has it)' : ''}: comment on it instead`)
            assignee = agentAssignee(me, b, p.assignee)
          }
          spendStorage('text', name, String(p.title ?? '').length + String(p.description ?? '').length)
          const { version, rank, ...rest } = p
          const changed = inTx(() => updateTask(t.seq, rest, by, { assignee, human: false }))
          if (changed) changedTask(t.seq, t.parent_seq)
          const out = { [changed ? 'updated' : 'unchanged']: agentView(taskRow(t.seq)) }
          if (changed === 'flow') out.handed_on = handedOn(me, taskRow(t.seq))
          return out
        }
        case 'comment': {
          agentChange(name)
          const t = agentTask(me, p.id)
          spendStorage('text', name, String(p.text ?? '').length)
          const c = inTx(() => commentOn(t.seq, p.text, by))
          changedTask(t.seq)
          return { commented: taskId(t.seq), comment: c.id }
        }
        default:
          throw bad('action must be one of: boards, list, get, create, update, comment')
      }
    },
  }

  // A session deleted: its tasks are nobody's, and a coordinator's team no
  // longer sees its boards (a new session with that name won't either).
  function forget(name) {
    const by = { kind: 'user', id: 'server', name: 'session deleted' }
    const hit = db.prepare("SELECT seq, board_id FROM tasks WHERE assignee_kind = 'session' AND assignee = ?").all(name)
    for (const t of hit) {
      db.prepare("UPDATE tasks SET assignee_kind = NULL, assignee = NULL, notify_state = 'none', notified_to = NULL, version = version + 1, updated_at = ? WHERE seq = ?").run(now(), t.seq)
      event(t.seq, by, 'changed', { assignee: null, deleted_session: name })
      changedTask(t.seq)
    }
    db.prepare("UPDATE tasks SET notify_state = CASE WHEN assignee_kind = 'session' THEN 'pending' ELSE 'none' END, notified_to = NULL WHERE notified_to = ?").run(name)
    const steps = db.prepare("UPDATE board_statuses SET handler_kind = NULL, handler = NULL WHERE handler_kind = 'session' AND handler = ?").run(name).changes
    if (db.prepare('DELETE FROM board_teams WHERE coordinator = ?').run(name).changes || steps) changedBoard()
  }

  const FROM_GITHUB = () => sync.FROM
  sync = createGithubSync({
    db, inTx, log, MAX, cleanText, bad, addColumn, dataDir: platform.dataDir,
    statusRows: boardId => db.prepare('SELECT * FROM board_statuses WHERE board_id = ? ORDER BY position, id').all(boardId),
    statusRow, taskRow, boardRow, typeRows: typesOf, labelRows: labelsOf,
    labelNames: seq => db.prepare('SELECT l.name FROM task_labels x JOIN board_labels l ON l.id = x.label_id WHERE x.task_seq = ?').all(seq).map(r => r.name),
    createTask, updateTask, checkAssignee, assignableSessions, event, changedTask, changedBoard, childrenOf, anyTask, members: memberList, peopleOf, prefix,
    trash: (t, data) => trashTasks(t, { by: FROM_GITHUB(), data, github: true }),
    restore: t => restoreTasks(t, { by: FROM_GITHUB(), github: true }),
  })

  return { boardReads, boardActions, boardMethods, boardList, forget, BOARD_SENDER }
}
