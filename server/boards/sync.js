import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { githubClient, parseProjectUrl, parseRepo, GithubError } from './github.js'

// A board kept in step with a GitHub project, both ways. GitHub is asked only
// while the board is in use: see «when GitHub is asked» below.
//
//   columns    GitHub's: the project's Status options are the board's columns
//              (their category and step are set here). A column added or
//              renamed here changes the field there; changed on both sides,
//              GitHub's changes are kept and ours go over them.
//   a task     an issue in the project (a draft item, if it is one there). A
//              task made here becomes an issue in the board's repository.
//   agents     a single-select field «Agent» of the project, with the agents
//              of the board's teams. Its people, the issue's assignees: by the
//              GitHub user in each one's profile (other assignees left alone).
//   type       a single-select field «Type»; labels, the issue's.
//   subtasks   sub-issues; comments, both ways (ours signed with the author);
//              one edited there is edited here, one deleted there no longer shown.
//   closed     done closes the issue as completed, cancelled as not planned;
//              reopened there, it goes back to the first column where work waits.
//   PRs        the repository's pull requests that name a task (SQ-12 in their
//              title, branch or text) or close its issue: shown on the task.
//              One merged takes it to the first done column (unless the board
//              says not to); the ones merged before the board first read them, not.
//
// Each field of a task keeps the value both sides last agreed on: whichever
// side differs from it changed; if both did, the later change wins. Nothing
// that comes from GitHub tells an agent: it waits for a person to say so.

const FRESH = Number(process.env.SQUADRA_GITHUB_FRESH_MS) || 180_000 // (a board or task in use is read again after this; tests make it short)
const SLACK = FRESH / 9  // (so that a dashboard asking every 3 minutes is never just too early)
const OPENED = FRESH / 6 // (just opened: read, unless someone did a moment ago; a task, half that)
const SOON = 3_000    // (a change here goes there this soon, with the others made meanwhile)
const WAIT = 10_000   // (an agent reading the board waits this long for GitHub, at most)
const NO_COMMENTS = { content: { comments: { nodes: [] } } }
const FROM = { kind: 'github', id: 'github', name: 'GitHub' }
const ACTIVE = ['unstarted', 'started', 'review']
const OPTION_COLOR = { backlog: 'GRAY', unstarted: 'BLUE', started: 'YELLOW', review: 'PURPLE', done: 'GREEN', closed: 'RED' }
const LABEL_HEX = { gray: '8c959f', blue: '0969da', green: '1a7f37', yellow: 'bf8700', orange: 'bc4c00', red: 'cf222e', purple: '8250df', pink: 'bf3989' }
// (Found by any of these names; made with the first GitHub takes: it keeps «Type» for its own issue types.)
const AGENT_FIELD = ['Agent', 'Agente', 'Squadra agent'], TYPE_FIELD = ['Task type', 'Tipo de tarea', 'Tipo', 'Squadra type']

// What a column of GitHub's is, by its name, until a person says otherwise.
export function guessCategory(name) {
  const n = String(name).toLowerCase()
  if (/backlog|ideas?|icebox/.test(n)) return 'backlog'
  if (/cancel|won.?t|descart|closed|cerrad/.test(n)) return 'closed'
  if (/done|hecho|complet|terminad|finish|shipped|merged/.test(n)) return 'done'
  if (/review|revis|qa|test/.test(n)) return 'review'
  if (/progress|curso|doing|working|haciendo/.test(n)) return 'started'
  if (/todo|to do|hacer|pendiente|ready|next|new|nuev/.test(n)) return 'unstarted'
  return 'started'
}

export function createGithubSync(ctx) {
  const { db, log, dataDir, inTx, MAX, cleanText } = ctx

  db.exec(`
    CREATE TABLE IF NOT EXISTS board_github (
      board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL, owner TEXT NOT NULL, number INTEGER NOT NULL, project_id TEXT NOT NULL, title TEXT, url TEXT,
      repo TEXT NOT NULL, repo_id TEXT NOT NULL, token TEXT NOT NULL,
      status_field TEXT NOT NULL, agent_field TEXT, type_field TEXT, columns_dirty INTEGER NOT NULL DEFAULT 1,
      connected_by TEXT, connected_at INTEGER NOT NULL, synced_at INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS task_github (
      task_seq INTEGER PRIMARY KEY REFERENCES tasks(seq) ON DELETE CASCADE, board_id INTEGER NOT NULL,
      item_id TEXT NOT NULL UNIQUE, issue_id TEXT, draft_id TEXT, number INTEGER, repo TEXT, url TEXT, synced TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_prs (
      task_seq INTEGER NOT NULL REFERENCES tasks(seq) ON DELETE CASCADE, pr_id TEXT NOT NULL, board_id INTEGER NOT NULL,
      number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL, review TEXT, author TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_seq, pr_id)
    );
    CREATE TABLE IF NOT EXISTS github_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE, item_id TEXT NOT NULL, issue_id TEXT);
  `)
  ctx.addColumn('github_outbox', 'task_seq', 'INTEGER')
  ctx.addColumn('board_github', 'prs_at', 'TEXT')       // (the last change to a pull request read: those after it are read next)
  ctx.addColumn('board_github', 'prs_from', 'INTEGER')  // (when they were first read: merged before, a task isn't moved)
  ctx.addColumn('board_github', 'merge_moves', 'INTEGER NOT NULL DEFAULT 1')
  ctx.addColumn('board_github', 'columns_seen', 'TEXT') // (GitHub's columns when both sides last agreed: what changed there since)
  ctx.addColumn('board_statuses', 'gh_option', 'TEXT')
  ctx.addColumn('task_comments', 'gh_id', 'TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS task_comments_gh ON task_comments(gh_id) WHERE gh_id IS NOT NULL')

  // --- the token at rest: encrypted with a key that is not in the database --------
  const key = (() => {
    const file = join(dataDir, 'secrets-key')
    try { const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url'); if (k.length === 32) return k } catch {}
    const k = randomBytes(32)
    writeFileSync(file, `${k.toString('base64url')}\n`, { mode: 0o600 })
    return k
  })()
  const seal = (boardId, secret) => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(`github:${boardId}`))
    const body = Buffer.concat([c.update(secret, 'utf8'), c.final()])
    return [iv, c.getAuthTag(), body].map(x => x.toString('base64url')).join('.')
  }
  const unseal = (boardId, sealed) => {
    const [iv, tag, body] = String(sealed).split('.').map(x => Buffer.from(x, 'base64url'))
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAAD(Buffer.from(`github:${boardId}`))
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()]).toString('utf8')
  }

  const conn = boardId => db.prepare('SELECT * FROM board_github WHERE board_id = ?').get(boardId)
  const clientOf = c => {
    try { return githubClient(unseal(c.board_id, c.token)) } catch { throw new GithubError('the saved token can no longer be read: connect the board again', { auth: true }) }
  }
  // (A task in the trash keeps its link, to be put back as it was: it isn't one of the board's here.)
  const links = boardId => db.prepare('SELECT g.* FROM task_github g JOIN tasks t ON t.seq = g.task_seq WHERE g.board_id = ? AND t.deleted_at IS NULL').all(boardId)
  const linkOf = seq => db.prepare('SELECT * FROM task_github WHERE task_seq = ?').get(seq)

  // What the dashboard shows of the connection (never the token): when it was
  // last read whole, whether it is being read now, and how many changes made
  // here haven't reached GitHub yet.
  function view(boardId) {
    const c = conn(boardId)
    if (!c) return null
    return {
      owner_kind: c.owner_kind, owner: c.owner, number: c.number, title: c.title, url: c.url, repo: c.repo, synced_at: c.synced_at ?? null, error: c.error ?? null, linked: links(boardId).length,
      syncing: busy.has(boardId) || queued.has(boardId), pending: notSent(boardId), merge_moves: !!c.merge_moves,
    }
  }
  function notSent(boardId) {
    const seqs = new Set([...(soonTimers.get(boardId)?.seqs ?? []), ...(sending.get(boardId) ?? [])])
    const board = seqs.delete(null) ? 1 : 0 // (a change to the board itself: its columns)
    const rows = db.prepare(`SELECT t.seq FROM tasks t LEFT JOIN task_github g ON g.task_seq = t.seq WHERE t.board_id = @b AND t.deleted_at IS NULL AND (g.task_seq IS NULL OR g.item_id LIKE 'pending:%')
      UNION SELECT c.task_seq FROM task_comments c JOIN task_github g ON g.task_seq = c.task_seq JOIN tasks t ON t.seq = c.task_seq
        WHERE g.board_id = @b AND g.issue_id IS NOT NULL AND t.deleted_at IS NULL AND c.gh_id IS NULL AND c.author NOT LIKE '{"kind":"github"%'`).all({ b: boardId })
    for (const r of rows) seqs.add(r.seq)
    return seqs.size + board + db.prepare('SELECT COUNT(*) n FROM github_outbox WHERE board_id = ?').get(boardId).n
  }

  // --- connecting -------------------------------------------------------------------
  async function connect(board, p, actor) {
    const where = parseProjectUrl(p.url)
    if (!where) throw ctx.bad('the project is its address on GitHub, such as https://github.com/orgs/acme/projects/3')
    const repo = parseRepo(p.repo)
    if (!repo) throw ctx.bad('the repository is owner/name, such as acme/web: new tasks become issues there')
    const token = String(p.token ?? '').trim()
    if (!token && !conn(board.id)) throw ctx.bad('a token is needed to reach GitHub')
    const secret = token || unseal(board.id, conn(board.id).token)
    if (secret.length > 400 || /\s/.test(secret)) throw ctx.bad('that is not a GitHub token')
    const gh = githubClient(secret)
    let project, repository
    try {
      project = await gh.project(where)
      repository = await gh.repository(repo)
    } catch (err) { throw ctx.bad(err.message) }
    const status = project.fields.find(f => f.name === 'Status' && Array.isArray(f.options))
    if (!status) throw ctx.bad('the project has no Status field: its columns come from there')
    const old = conn(board.id)
    inTx(() => {
      // (Another project: the old links mean nothing there.)
      if (old && old.project_id !== project.id) {
        db.prepare('DELETE FROM task_github WHERE board_id = ?').run(board.id)
        db.prepare('UPDATE board_statuses SET gh_option = NULL WHERE board_id = ?').run(board.id)
      }
      // (Another repository: its pull requests, read afresh.)
      if (old && old.repo !== repository.name) {
        db.prepare('DELETE FROM task_prs WHERE board_id = ?').run(board.id)
        db.prepare('UPDATE board_github SET prs_at = NULL, prs_from = NULL WHERE board_id = ?').run(board.id)
      }
      db.prepare(`INSERT INTO board_github (board_id, owner_kind, owner, number, project_id, title, url, repo, repo_id, token, status_field, connected_by, connected_at, columns_dirty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(board_id) DO UPDATE SET owner_kind = excluded.owner_kind, owner = excluded.owner, number = excluded.number, project_id = excluded.project_id, title = excluded.title, url = excluded.url,
          repo = excluded.repo, repo_id = excluded.repo_id, token = excluded.token, status_field = excluded.status_field, columns_dirty = 1, error = NULL`)
        .run(board.id, where.ownerKind, where.owner, where.number, project.id, project.title, project.url, repository.name, repository.id, seal(board.id, secret), status.id, JSON.stringify(actor), Date.now())
      adoptColumns(board.id, status)
    })
    ctx.changedBoard()
    void syncBoard(board.id) // (the first one may take a while: it shows on the board)
    return view(board.id)
  }

  function disconnect(boardId) {
    lastBoard.delete(boardId)
    inTx(() => {
      db.prepare('DELETE FROM board_github WHERE board_id = ?').run(boardId)
      db.prepare('DELETE FROM task_github WHERE board_id = ?').run(boardId)
      db.prepare('DELETE FROM github_outbox WHERE board_id = ?').run(boardId)
      db.prepare('DELETE FROM task_prs WHERE board_id = ?').run(boardId)
      db.prepare('UPDATE board_statuses SET gh_option = NULL WHERE board_id = ?').run(boardId)
    })
    ctx.changedBoard()
  }
  // Whether a merged pull request takes its tasks to done.
  function setMergeMoves(boardId, on) {
    db.prepare('UPDATE board_github SET merge_moves = ? WHERE board_id = ?').run(on ? 1 : 0, boardId)
    ctx.changedBoard()
  }

  // GitHub's columns become the board's: matched by name (or by the option
  // they were), the missing ones added here; the board's own that GitHub
  // lacks stay, and are added there on the next sync. GitHub's order first.
  function adoptColumns(boardId, field) {
    const mine = ctx.statusRows(boardId)
    const used = new Set()
    let position = 0
    for (const o of field.options) {
      const s = mine.find(x => x.gh_option === o.id && !used.has(x.id)) ?? mine.find(x => !used.has(x.id) && x.name.toLowerCase() === o.name.toLowerCase())
      if (s) {
        used.add(s.id)
        db.prepare('UPDATE board_statuses SET gh_option = ?, name = ?, position = ? WHERE id = ?').run(o.id, o.name.slice(0, MAX.name), position++, s.id)
      } else if (mine.length + 1 <= MAX.statuses) {
        const id = Number(db.prepare('INSERT INTO board_statuses (board_id, name, category, position, gh_option) VALUES (?, ?, ?, ?, ?)').run(boardId, o.name.slice(0, MAX.name), guessCategory(o.name), position++, o.id).lastInsertRowid)
        used.add(id)
        mine.push({ id, name: o.name, gh_option: o.id })
      }
    }
    for (const s of mine.filter(x => !used.has(x.id))) {
      const tasks = db.prepare('SELECT COUNT(*) n FROM tasks WHERE status_id = ? AND deleted_at IS NULL').get(s.id).n
      // (Deleted in GitHub, and empty here: gone here too. With tasks: kept, and given back to GitHub.)
      if (s.gh_option && !tasks) {
        for (const col of ['next_id', 'back_id']) db.prepare(`UPDATE board_statuses SET ${col} = NULL WHERE ${col} = ?`).run(s.id)
        db.prepare('DELETE FROM board_statuses WHERE id = ?').run(s.id)
        continue
      }
      db.prepare('UPDATE board_statuses SET gh_option = NULL, position = ? WHERE id = ?').run(position++, s.id)
      db.prepare('UPDATE board_github SET columns_dirty = 1 WHERE board_id = ?').run(boardId)
    }
    seenColumns(boardId, field)
  }
  const seenColumns = (boardId, field) => db.prepare('UPDATE board_github SET columns_seen = ? WHERE board_id = ?').run(JSON.stringify(field.options.map(o => ({ id: o.id, name: o.name }))), boardId)

  // Changed here, on their way there: what GitHub changed meanwhile, kept.
  // Added there, a column here too (where GitHub has it); renamed there and
  // not here, its name; deleted there, untouched here and empty, gone here.
  function mergeColumns(boardId, field) {
    const seen = JSON.parse(conn(boardId)?.columns_seen ?? 'null')
    if (!seen) return
    const was = new Map(seen.map(o => [o.id, o.name]))
    const mine = () => ctx.statusRows(boardId)
    const named = (name, but) => mine().some(x => x.id !== but && x.name.toLowerCase() === name.toLowerCase())
    const byOption = () => new Map(mine().filter(s => s.gh_option).map(s => [s.gh_option, s]))
    for (const o of field.options) {
      const s = byOption().get(o.id)
      if (s && was.has(o.id) && o.name !== was.get(o.id) && s.name === was.get(o.id) && !named(o.name, s.id)) db.prepare('UPDATE board_statuses SET name = ? WHERE id = ?').run(o.name.slice(0, MAX.name), s.id)
    }
    field.options.forEach((o, i) => {
      if (was.has(o.id) || byOption().has(o.id) || named(o.name) || mine().length >= MAX.statuses) return
      const after = field.options.slice(0, i).reverse().map(x => byOption().get(x.id)).find(Boolean)
      const at = after ? after.position + 1 : 0
      db.prepare('UPDATE board_statuses SET position = position + 1 WHERE board_id = ? AND position >= ?').run(boardId, at)
      db.prepare('INSERT INTO board_statuses (board_id, name, category, position, gh_option) VALUES (?, ?, ?, ?, ?)').run(boardId, o.name.slice(0, MAX.name), guessCategory(o.name), at, o.id)
    })
    for (const [id, name] of was) {
      const s = byOption().get(id)
      if (!s || field.options.some(o => o.id === id) || s.name !== name) continue
      if (db.prepare('SELECT COUNT(*) n FROM tasks WHERE status_id = ?').get(s.id).n) continue
      for (const col of ['next_id', 'back_id']) db.prepare(`UPDATE board_statuses SET ${col} = NULL WHERE ${col} = ?`).run(s.id)
      db.prepare('DELETE FROM board_statuses WHERE id = ?').run(s.id)
    }
  }

  // --- what each side says of a task ---------------------------------------------------
  const norm = {
    title: v => cleanText(String(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX.title),
    body: v => cleanText(String(v ?? '')).replace(/\r\n?/g, '\n').trim().slice(0, MAX.description),
  }
  const categoryOf = s => s?.category ?? 'unstarted'
  // People, by their GitHub user (in lower case): only the company's who have one in their profile.
  const split = v => (v ? String(v).split('\n') : [])
  const loginsOf = () => new Map(ctx.members().filter(m => m.github).map(m => [m.id, m.github.toLowerCase()]))
  const peopleLogins = (seq, refused = []) => { const by = loginsOf(); return ctx.peopleOf(seq).map(id => by.get(id)).filter(l => l && !refused.includes(l)).sort().join('\n') }
  const userIds = new Map() // (a GitHub user's id, by login: it doesn't change)
  async function userIdOf(gh, login) {
    if (!userIds.has(login)) userIds.set(login, await gh.userId(login))
    return userIds.get(login)
  }
  function ours(t, parentIssue, refused = []) {
    const s = ctx.statusRow(t.status_id)
    const cat = categoryOf(s)
    return {
      title: t.title, body: t.description ?? '', status: s?.gh_option ?? null,
      closed: cat === 'done' ? 'COMPLETED' : cat === 'closed' ? 'NOT_PLANNED' : 'OPEN',
      agent: t.assignee_kind === 'session' ? t.assignee : null,
      type: t.type_id ? ctx.typeRows(t.board_id).find(x => x.id === t.type_id)?.name.toLowerCase() ?? null : null,
      labels: ctx.labelNames(t.seq).map(n => n.toLowerCase()).sort().join('\n'),
      parent: parentIssue,
      people: peopleLogins(t.seq, refused),
    }
  }
  function theirs(item, fields) {
    const pick = fieldId => item.fieldValues?.nodes?.find(v => v?.field?.id === fieldId)?.optionId ?? null
    const name = (field, id) => field?.options?.find(o => o.id === id)?.name ?? null
    const c = item.content
    const out = {
      title: norm.title(c.title), body: norm.body(c.body), status: pick(fields.status.id),
      agent: fields.agent ? name(fields.agent, pick(fields.agent.id)) : null, type: fields.type ? name(fields.type, pick(fields.type.id))?.toLowerCase() ?? null : null,
    }
    if (c.__typename === 'Issue') {
      out.closed = c.state === 'CLOSED' ? (c.stateReason === 'NOT_PLANNED' || c.stateReason === 'DUPLICATE' ? 'NOT_PLANNED' : 'COMPLETED') : 'OPEN'
      out.labels = (c.labels?.nodes ?? []).map(l => l.name.toLowerCase()).sort().join('\n')
      out.parent = c.parent?.id ?? null
      const known = new Set(loginsOf().values()) // (assignees who aren't the company's people: left as they are)
      out.people = (c.assignees?.nodes ?? []).filter(Boolean).map(n => n.login.toLowerCase()).filter(l => known.has(l)).sort().join('\n')
    }
    return out
  }

  // (Compared in lower case; made here as GitHub writes them.)
  const typeThere = (item, fields) => fields.type?.options.find(o => o.id === item.fieldValues?.nodes?.find(v => v?.field?.id === fields.type.id)?.optionId)?.name ?? null
  const labelsThere = item => (item.content.labels?.nodes ?? []).map(l => l.name)

  // --- when GitHub is asked -------------------------------------------------------------
  // Only while the board is in use: when someone opens it, and every few
  // minutes while it stays open (the dashboard says so); when an agent reads
  // it; and soon after a change here, for the tasks that changed. A task is
  // read with its comments when it is opened. A board nobody uses costs nothing.
  const chains = new Map()     // board id -> its work, one thing at a time
  const queued = new Map()     // board id -> a whole sync waiting its turn
  const lastBoard = new Map()  // board id -> when it was last read whole
  const lastTask = new Map()   // task seq -> when it was last read
  const lastAsked = new Map()  // task seq -> when the button last asked for it
  const soonTimers = new Map() // board id -> the changes waiting to go: { timer, seqs } (null: the whole board)
  const busy = new Map()       // board id -> whole syncs running
  const sending = new Map()    // board id -> Set of the tasks whose changes are on their way
  let applying = 0 // (changes made here from GitHub don't ask for another sync)

  function serial(boardId, fn) {
    const p = (chains.get(boardId) ?? Promise.resolve()).then(fn)
    const tail = p.catch(() => {})
    chains.set(boardId, tail)
    void tail.then(() => { if (chains.get(boardId) === tail) chains.delete(boardId) })
    return p
  }
  const within = (p, ms) => Promise.race([p, new Promise(r => { const t = setTimeout(r, ms); t.unref?.() })])
  const stale = (at, ms) => Date.now() - (at ?? 0) >= ms

  function touch(boardId, seq = null) {
    if (applying || !conn(boardId)) return
    let w = soonTimers.get(boardId)
    if (!w) {
      w = { seqs: new Set() }
      w.timer = setTimeout(() => {
        soonTimers.delete(boardId)
        if (w.seqs.has(null)) void syncBoard(boardId)
        else void syncTasks(boardId, [...w.seqs], { sending: true })
      }, SOON)
      w.timer.unref?.()
      soonTimers.set(boardId, w)
    }
    w.seqs.add(seq)
  }
  // (The dashboard sees it start and end: «syncing», «sending n changes».)
  async function tracked(boardId, mark, fn) {
    const undo = mark()
    ctx.changedBoard()
    try { return await fn() } finally { undo(); ctx.changedBoard() }
  }
  // The whole board (with the one already waiting its turn, if there is one).
  function syncBoard(boardId) {
    if (queued.has(boardId)) return queued.get(boardId)
    lastBoard.set(boardId, Date.now())
    const p = serial(boardId, () => {
      queued.delete(boardId)
      return tracked(boardId, () => { busy.set(boardId, (busy.get(boardId) ?? 0) + 1); return () => { const n = busy.get(boardId) - 1; if (n > 0) busy.set(boardId, n); else busy.delete(boardId) } }, () => attempt(boardId, run))
    })
    queued.set(boardId, p)
    return p
  }
  // These tasks only: what changed here goes there, and each comes back with its comments.
  function syncTasks(boardId, seqs, { sending: changes = false } = {}) {
    for (const seq of seqs) lastTask.set(seq, Date.now())
    const mark = () => {
      if (!changes) return () => {}
      const set = sending.get(boardId) ?? new Set()
      sending.set(boardId, set)
      for (const s of seqs) set.add(s)
      return () => { for (const s of seqs) set.delete(s); if (!set.size) sending.delete(boardId) }
    }
    if (changes) { const undo = mark(); const p = serial(boardId, () => tracked(boardId, () => undo, () => attempt(boardId, (c, board) => runTasks(c, board, seqs)))); return p }
    return serial(boardId, () => attempt(boardId, (c, board) => runTasks(c, board, seqs)))
  }
  async function attempt(boardId, fn) {
    const c = conn(boardId)
    const board = ctx.boardRow(boardId)
    if (!c || !board || board.archived_at) return
    try {
      const whole = (await fn(c, board)) !== 'part'
      if (whole) db.prepare('UPDATE board_github SET synced_at = ?, error = NULL WHERE board_id = ?').run(Date.now(), boardId)
      else db.prepare('UPDATE board_github SET error = NULL WHERE board_id = ?').run(boardId)
    } catch (err) {
      log(`GitHub sync of board ${boardId}: ${err.message}`)
      db.prepare('UPDATE board_github SET error = ? WHERE board_id = ?').run(String(err.message).slice(0, 500), boardId)
    }
    ctx.changedBoard()
  }

  // Someone has the board open, and maybe one of its tasks: what isn't fresh is read.
  // (Asked for with the button: the task now, if the button didn't ask a moment ago.)
  function watch(boardId, { task = null, opened = false, taskOpened = false, force = false } = {}) {
    if (!conn(boardId)) return Promise.resolve()
    const work = []
    if (stale(lastBoard.get(boardId), opened ? OPENED : FRESH - SLACK)) work.push(syncBoard(boardId))
    const t = task ? ctx.taskRow(task) : null
    const due = force ? stale(lastAsked.get(t?.seq), SOON) : stale(lastTask.get(t?.seq), taskOpened ? OPENED / 2 : FRESH - SLACK)
    if (t?.board_id === boardId && linkOf(t.seq) && due) { if (force) lastAsked.set(t.seq, Date.now()); work.push(syncTasks(boardId, [t.seq])) }
    return Promise.all(work)
  }
  // An agent reads the board, or a task of it: GitHub's first, if it isn't fresh (waiting a little at most).
  const fresh = boardId => (conn(boardId) && stale(lastBoard.get(boardId), FRESH - SLACK) ? within(syncBoard(boardId), WAIT) : Promise.resolve())
  const freshTask = t => (t && conn(t.board_id) && linkOf(t.seq) && stale(lastTask.get(t.seq), OPENED) ? within(syncTasks(t.board_id, [t.seq]), WAIT) : Promise.resolve())

  async function run(c, board) {
    const gh = clientOf(c)
    const where = { ownerKind: c.owner_kind, owner: c.owner, number: c.number }
    let project = await gh.project(where)
    const statusField = project.fields.find(f => f.id === c.status_field) ?? project.fields.find(f => f.name === 'Status' && f.options)
    if (!statusField) throw new GithubError('the project has no Status field any more')
    let items = await gh.items(project.id)

    // The columns: GitHub's, unless they were changed here (then ours, there).
    if (!conn(board.id).columns_dirty) inTx(() => adoptColumns(board.id, statusField))
    if (conn(board.id).columns_dirty) {
      inTx(() => mergeColumns(board.id, statusField))
      await pushColumns(gh, project, statusField, items, board.id)
      project = await gh.project(where)
      items = await gh.items(project.id)
    }
    const fields = { status: project.fields.find(f => f.id === statusField.id) ?? statusField }

    // The agent and type fields: with every agent and type of the board as an option.
    const agents = ctx.assignableSessions(board.id).map(s => s.name)
    const types = ctx.typeRows(board.id).map(t => t.name)
    let refetch = false
    for (const [key, names, wanted, column] of [['agent', AGENT_FIELD, agents, 'agent_field'], ['type', TYPE_FIELD, types, 'type_field']]) {
      const r = await ensureSelect(gh, project, items, { id: c[column], names, wanted })
      fields[key] = r.field
      if (r.field && r.field.id !== c[column]) db.prepare(`UPDATE board_github SET ${column} = ? WHERE board_id = ?`).run(r.field.id, board.id)
      refetch ||= r.changed
    }
    if (refetch) items = await gh.items(project.id)

    // (Before the items: a task a merged pull request moves goes there in this same sync.)
    try { await pullRequests(gh, conn(board.id), board) } catch (err) { log(`GitHub pull requests of board ${board.id}: ${err.message}`); if (err.auth && err.status === 401) throw err }

    const seen = new Set()
    const byIssue = new Map()
    for (const l of links(board.id)) if (l.issue_id) byIssue.set(l.issue_id, l.task_seq)
    // GitHub's items: new ones become tasks; the others, field by field.
    const imported = []
    const leaving = new Set(db.prepare('SELECT item_id FROM github_outbox WHERE board_id = ?').all(board.id).map(o => o.item_id)) // (deleted here, on their way out there)
    for (const item of items) {
      if (item.isArchived || !item.content || !['Issue', 'DraftIssue'].includes(item.content.__typename) || leaving.has(item.id)) continue
      seen.add(item.id)
      const link = db.prepare('SELECT * FROM task_github WHERE item_id = ?').get(item.id) ?? itemOfPending(item) ?? backFromTrash(item)
      try {
        if (!link) { const seq = importItem(board, item, fields); if (seq) { imported.push([seq, item]); if (item.content.__typename === 'Issue') byIssue.set(item.content.id, seq) } } else await reconcile(gh, c, board, link, item, fields, byIssue)
      } catch (err) { log(`GitHub item ${item.id} of board ${board.id}: ${err.message}`) }
    }
    // (Parents once every task is there.)
    for (const [seq, item] of imported) {
      const parent = item.content.parent?.id && byIssue.get(item.content.parent.id)
      if (parent) applyHere(seq, { parent }, item)
    }
    // Linked tasks whose item left the project: no longer linked. (Made, but not yet in it: into it.)
    for (const l of links(board.id)) {
      if (l.item_id.startsWith('pending:')) { await intoProject(gh, project, l); continue }
      if (!seen.has(l.item_id)) removedThere(l)
    }
    await sendOutbox(gh, project, board.id)
    // Ours not yet there: issues in the board's repository, parents first.
    const linked = new Set(links(board.id).map(l => l.task_seq))
    const missing = db.prepare('SELECT * FROM tasks WHERE board_id = ? AND deleted_at IS NULL ORDER BY seq').all(board.id).filter(t => !linked.has(t.seq))
    const depth = t => { let n = 0; for (let x = t; x?.parent_seq && n < 10; x = ctx.taskRow(x.parent_seq)) n++; return n }
    missing.sort((a, b) => depth(a) - depth(b) || a.seq - b.seq)
    let repoLabels = null
    for (const t of missing) {
      try {
        repoLabels ??= (await gh.repository(parseRepo(c.repo))).labels
        await publish(gh, c, project, fields, ctx.taskRow(t.seq), repoLabels)
      } catch (err) { log(`GitHub: task ${t.seq} could not be published: ${err.message}`); if (err.auth) throw err }
    }
    // Comments of ours that didn't get there (GitHub's come when a task is opened).
    for (const l of links(board.id)) if (l.issue_id && !l.item_id.startsWith('pending:') && unsent(l.task_seq).length) await comments(gh, l, NO_COMMENTS)
  }

  // Some tasks, without reading the whole board: each item by itself. A whole
  // sync instead if the board needs one (its columns changed here, or GitHub
  // lacks an agent or type).
  async function runTasks(c, board, seqs) {
    if (c.columns_dirty) return run(c, board)
    const gh = clientOf(c)
    const project = await gh.project({ ownerKind: c.owner_kind, owner: c.owner, number: c.number })
    const fields = fieldsOf(c, project, board.id)
    if (!fields) return run(c, board)
    await sendOutbox(gh, project, board.id)
    // (A subtask's parents first, if they aren't on GitHub yet.)
    const todo = new Set()
    for (const seq of seqs) {
      const up = []
      const row = s => (s ? ctx.taskRow(s) : null)
      for (let p = row(row(seq)?.parent_seq), n = 0; p && !linkOf(p.seq) && n < MAX.depth; p = row(p.parent_seq), n++) up.unshift(p.seq)
      for (const x of [...up, seq]) todo.add(x)
    }
    const byIssue = new Map(links(board.id).filter(l => l.issue_id).map(l => [l.issue_id, l.task_seq]))
    let repoLabels = null
    for (const seq of todo) {
      const t = ctx.taskRow(seq)
      if (!t || t.board_id !== board.id) continue
      try {
        let link = linkOf(seq)
        if (link?.item_id.startsWith('pending:')) { await intoProject(gh, project, link); link = linkOf(seq) }
        if (link?.item_id.startsWith('pending:')) continue // (not in the project yet: next time)
        if (!link) {
          repoLabels ??= (await gh.repository(parseRepo(c.repo))).labels
          await publish(gh, c, project, fields, t, repoLabels)
          const made = linkOf(seq)
          if (made && unsent(seq).length) await comments(gh, made, NO_COMMENTS)
          continue
        }
        const item = await gh.item(link.item_id)
        if (!item || item.isArchived || !item.content) { removedThere(link); continue }
        if (item.content.__typename === 'Issue' && item.content.id) byIssue.set(item.content.id, seq)
        await reconcile(gh, c, board, link, item, fields, byIssue)
        if (item.content.__typename === 'Issue') await comments(gh, linkOf(seq), item)
      } catch (err) { log(`GitHub: task ${seq}: ${err.message}`); if (err.auth) throw err }
    }
    return 'part'
  }

  // The project's fields as the last whole sync left them; null if the board
  // needs a whole one first (a column, agent or type GitHub hasn't).
  function fieldsOf(c, project, boardId) {
    const status = project.fields.find(f => f.id === c.status_field && Array.isArray(f.options))
    if (!status || ctx.statusRows(boardId).some(s => !status.options.some(o => o.id === s.gh_option))) return null
    const out = { status }
    for (const [key, wanted, column] of [['agent', ctx.assignableSessions(boardId).map(s => s.name), 'agent_field'], ['type', ctx.typeRows(boardId).map(t => t.name), 'type_field']]) {
      const f = c[column] ? project.fields.find(x => x.id === c[column] && Array.isArray(x.options)) : null
      if (!f && wanted.length) return null
      if (f && wanted.some(n => !f.options.some(o => o.name.toLowerCase() === n.toLowerCase()))) return null
      out[key] = f ?? null
    }
    return out
  }
  // Its issue into the project. The issue gone (deleted on GitHub): no longer linked, so the task is published again, as a new issue.
  async function intoProject(gh, project, l) {
    try { db.prepare('UPDATE task_github SET item_id = ? WHERE task_seq = ?').run(await gh.addItem(project.id, l.issue_id), l.task_seq) } catch (err) {
      if (err.auth) throw err
      if (err.notFound) { db.prepare('DELETE FROM task_github WHERE task_seq = ?').run(l.task_seq); return }
      log(`GitHub: adding issue of task ${l.task_seq} to the project: ${err.message}`)
    }
  }
  // Taken out of the project there: into the trash here (its subtasks stay, with
  // no parent, as when deleted here). Its issue stays as it was.
  function removedThere(l) {
    const t = ctx.taskRow(l.task_seq)
    if (!t) return
    for (const c of ctx.childrenOf(t.seq)) {
      const cl = linkOf(c.seq)
      if (cl) db.prepare('UPDATE task_github SET synced = ? WHERE task_seq = ?').run(JSON.stringify({ ...JSON.parse(cl.synced), parent: null }), c.seq) // (not taken off its parent there)
    }
    if (l.issue_id) db.prepare("UPDATE task_github SET item_id = 'trashed:' || task_seq WHERE task_seq = ?").run(t.seq)
    else db.prepare('DELETE FROM task_github WHERE task_seq = ?').run(t.seq) // (a draft: gone there)
    applying++
    try { ctx.trash(t, { github: 'taken out of the project' }) } finally { applying-- }
  }
  // An item of an issue made here that wasn't in the project yet (GitHub put it there by itself): its task's.
  function itemOfPending(item) {
    if (item.content.__typename !== 'Issue') return null
    const l = db.prepare('SELECT * FROM task_github WHERE item_id = ?').get(`pending:${item.content.id}`)
    if (!l) return null
    db.prepare('UPDATE task_github SET item_id = ? WHERE task_seq = ?').run(item.id, l.task_seq)
    return linkOf(l.task_seq)
  }
  // An item of an issue whose task is in the trash: put in the project again there, so back here (GitHub's, as it is there).
  function backFromTrash(item) {
    if (item.content.__typename !== 'Issue') return null
    const l = db.prepare('SELECT g.* FROM task_github g JOIN tasks t ON t.seq = g.task_seq WHERE g.issue_id = ? AND t.deleted_at IS NOT NULL').get(item.content.id)
    if (!l || db.prepare('SELECT 1 FROM github_outbox WHERE task_seq = ?').get(l.task_seq)) return null
    applying++
    try { ctx.restore(ctx.anyTask(l.task_seq)) } catch (err) { log(`GitHub: task ${l.task_seq} back from the trash: ${err.message}`); return null } finally { applying-- }
    db.prepare('UPDATE task_github SET item_id = ?, synced = ? WHERE task_seq = ?').run(item.id, JSON.stringify({ prefer: 'there' }), l.task_seq)
    return linkOf(l.task_seq)
  }
  // Deleted here: closed there and out of the project.
  async function sendOutbox(gh, project, boardId) {
    for (const o of db.prepare('SELECT * FROM github_outbox WHERE board_id = ?').all(boardId)) {
      try {
        if (!o.item_id.startsWith('pending:')) await gh.removeItem(project.id, o.item_id)
        if (o.issue_id) await gh.closeIssue(o.issue_id, 'NOT_PLANNED')
      } catch (err) {
        log(`GitHub: closing a deleted task's issue: ${err.message}`)
        if (err.auth) throw err
        if (err.transient) continue // (tried again next time)
      }
      db.prepare('DELETE FROM github_outbox WHERE id = ?').run(o.id)
    }
  }
  const unsent = seq => db.prepare('SELECT * FROM task_comments WHERE task_seq = ? AND gh_id IS NULL ORDER BY id').all(seq).filter(cm => JSON.parse(cm.author).kind !== 'github')

  // A single-select field with these names as options (made if missing). Its
  // options replaced, the items get back the value they had, by its name.
  async function ensureSelect(gh, project, items, { id, names, wanted }) {
    let field = project.fields.find(f => f.id === id && f.options) ?? project.fields.find(f => names.includes(f.name) && Array.isArray(f.options))
    if (!field) {
      if (!wanted.length) return { field: null, changed: false }
      for (const name of names) {
        if (project.fields.some(f => f.name.toLowerCase() === name.toLowerCase())) continue
        try {
          field = await gh.createField(project.id, name, wanted.map(n => ({ name: n, color: 'GRAY', description: '' })))
        } catch (err) { if (/reserved|already been taken/i.test(err.message)) continue; throw err }
        return { field, changed: true }
      }
      return { field: null, changed: false }
    }
    const have = new Set(field.options.map(o => o.name.toLowerCase()))
    const add = wanted.filter(n => !have.has(n.toLowerCase()))
    if (!add.length) return { field, changed: false }
    const before = valuesOf(items, field)
    const next = await gh.setOptions(field.id, [...field.options.map(o => ({ name: o.name, color: o.color, description: '' })), ...add.map(n => ({ name: n, color: 'GRAY', description: '' }))])
    await putBack(gh, project.id, next, before)
    return { field: next, changed: true }
  }
  const valuesOf = (items, field) => items.map(it => [it.id, field.options.find(o => o.id === it.fieldValues?.nodes?.find(v => v?.field?.id === field.id)?.optionId)?.name ?? null]).filter(x => x[1])
  async function putBack(gh, projectId, field, before, rename = new Map()) {
    for (const [itemId, name] of before) {
      const o = field.options.find(x => x.name === (rename.get(name) ?? name))
      if (o) await gh.setSelect(projectId, itemId, field.id, o.id)
    }
  }

  // The board's columns, as GitHub's Status options; every item keeps its column.
  async function pushColumns(gh, project, field, items, boardId) {
    const mine = ctx.statusRows(boardId)
    const byOption = new Map(mine.filter(s => s.gh_option).map(s => [s.gh_option, s]))
    const colorOf = s => field.options.find(o => o.id === s.gh_option)?.color ?? OPTION_COLOR[s.category] ?? 'GRAY'
    const next = await gh.setOptions(field.id, mine.map(s => ({ name: s.name, color: colorOf(s), description: '' })))
    // (Renamed here: its old name there is its new one.)
    const rename = new Map(field.options.filter(o => byOption.has(o.id)).map(o => [o.name, byOption.get(o.id).name]))
    inTx(() => {
      for (const s of mine) db.prepare('UPDATE board_statuses SET gh_option = ? WHERE id = ?').run(next.options.find(o => o.name === s.name)?.id ?? null, s.id)
      db.prepare('UPDATE board_github SET columns_dirty = 0 WHERE board_id = ?').run(boardId)
      seenColumns(boardId, next)
    })
    await putBack(gh, project.id, next, valuesOf(items, field), rename)
    // (What agreed before still does: the option ids changed, not the columns.)
    for (const l of links(boardId)) {
      const synced = JSON.parse(l.synced)
      const s = mine.find(x => x.gh_option === synced.status)
      if (s) { synced.status = next.options.find(o => o.name === s.name)?.id ?? null; db.prepare('UPDATE task_github SET synced = ? WHERE task_seq = ?').run(JSON.stringify(synced), l.task_seq) }
    }
  }

  // An item of GitHub's that has no task yet: a task now (nobody told).
  function importItem(board, item, fields) {
    const g = theirs(item, fields)
    const p = { title: g.title || '(untitled)', description: g.body || null }
    const s = ctx.statusRows(board.id).find(x => x.gh_option && x.gh_option === g.status)
    if (s) p.status = s.id
    if (g.type) p.type = typeId(board.id, typeThere(item, fields))
    if (g.labels) p.labels = labelsThere(item).map(n => labelId(board.id, n)).filter(Boolean)
    let assignee = null
    if (g.agent) { try { assignee = ctx.checkAssignee(board.id, { kind: 'session', id: g.agent }) } catch {} }
    applying++
    try {
      const seq = inTx(() => {
        const seq = ctx.createTask(board, p, FROM, { assignee })
        const t = ctx.taskRow(seq)
        // (Closed there, but in a column that isn't: in one that is.)
        if (g.closed && g.closed !== 'OPEN' && !['done', 'closed'].includes(categoryOf(ctx.statusRow(t.status_id)))) {
          const to = columnFor(board.id, g.closed)
          if (to) db.prepare('UPDATE tasks SET status_id = ? WHERE seq = ?').run(to, seq)
        }
        const c = item.content
        db.prepare('INSERT INTO task_github (task_seq, board_id, item_id, issue_id, draft_id, number, repo, url, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(seq, board.id, item.id, c.__typename === 'Issue' ? c.id : null, c.__typename === 'DraftIssue' ? c.id : null, c.number ?? null, c.repository?.nameWithOwner ?? null, c.url ?? null, JSON.stringify(g))
        return seq
      })
      ctx.changedTask(seq)
      return seq
    } finally { applying-- }
  }
  function columnFor(boardId, closed) {
    const all = ctx.statusRows(boardId)
    const cat = closed === 'NOT_PLANNED' ? 'closed' : closed === 'COMPLETED' ? 'done' : null
    return (cat ? all.find(s => s.category === cat) ?? all.find(s => s.category === 'done') : all.find(s => ACTIVE.includes(s.category)))?.id ?? null
  }
  function typeId(boardId, name) {
    const hit = ctx.typeRows(boardId).find(t => t.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    if (ctx.typeRows(boardId).length >= MAX.types) return null
    return Number(db.prepare("INSERT INTO board_types (board_id, name, color, position) VALUES (?, ?, 'gray', (SELECT COALESCE(MAX(position), 0) + 1 FROM board_types WHERE board_id = ?))").run(boardId, name.slice(0, MAX.name), boardId).lastInsertRowid)
  }
  function labelId(boardId, name) {
    const hit = ctx.labelRows(boardId).find(l => l.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    if (ctx.labelRows(boardId).length >= MAX.labels) return null
    return Number(db.prepare("INSERT INTO board_labels (board_id, name, color, position) VALUES (?, ?, 'gray', (SELECT COALESCE(MAX(position), 0) + 1 FROM board_labels WHERE board_id = ?))").run(boardId, name.slice(0, MAX.name), boardId).lastInsertRowid)
  }

  // A change from GitHub, made here as GitHub's (pending for any agent it gives the task to).
  function applyHere(seq, p, item, assignee) {
    applying++
    try {
      inTx(() => ctx.updateTask(seq, p, FROM, { assignee, human: true }))
      ctx.changedTask(seq)
    } catch (err) { log(`GitHub change to task ${seq} not applied: ${err.message}`) } finally { applying-- }
  }

  async function reconcile(gh, c, board, link, item, fields, byIssue) {
    let t = ctx.taskRow(link.task_seq)
    if (!t) return
    const parentLink = t.parent_seq ? linkOf(t.parent_seq) : null
    const synced = JSON.parse(link.synced)
    const prefer = synced.prefer // (back from the trash: one side's word, whatever the other says)
    delete synced.prefer
    // (People GitHub wouldn't assign to it: not its business. Taken off the task, forgotten.)
    const refused = (synced.refused ?? []).filter(l => split(peopleLogins(t.seq)).includes(l))
    if (refused.length) synced.refused = refused; else delete synced.refused
    const here = ours(t, t.parent_seq ? parentLink?.issue_id ?? 'unpublished' : null, refused)
    const there = theirs(item, fields)
    const keys = Object.keys(there) // (a draft has no state, labels or parent)
    const theirsAt = Math.max(Date.parse(item.updatedAt) || 0, Date.parse(item.content.updatedAt) || 0)
    const toHere = [], toThere = []
    for (const k of keys) {
      if (here[k] === there[k]) { synced[k] = there[k]; continue }
      if (k === 'parent' && here[k] === 'unpublished') continue // (its parent isn't on GitHub yet)
      if (prefer) { (prefer === 'there' ? toHere : toThere).push(k); continue }
      const hereChanged = here[k] !== synced[k], thereChanged = there[k] !== synced[k]
      if (thereChanged && (!hereChanged || theirsAt > t.updated_at)) toHere.push(k)
      else toThere.push(k)
    }
    // GitHub's changes, here.
    if (toHere.length) {
      const p = {}
      let assignee
      for (const k of toHere) {
        if (k === 'title') p.title = there.title || t.title
        if (k === 'body') p.description = there.body
        if (k === 'status') { const s = ctx.statusRows(board.id).find(x => x.gh_option && x.gh_option === there.status); if (s) p.status = s.id }
        if (k === 'type') p.type = there.type ? typeId(board.id, typeThere(item, fields)) : null
        if (k === 'labels') p.labels = labelsThere(item).map(n => labelId(board.id, n)).filter(Boolean)
        if (k === 'parent') p.parent = there.parent ? byIssue.get(there.parent) ?? null : null
        if (k === 'people') {
          // (Those GitHub can't have stay: people without a GitHub user, or one it wouldn't assign.)
          const by = loginsOf()
          const ids = new Map([...by].map(([id, l]) => [l, id]))
          const keep = ctx.peopleOf(t.seq).filter(id => !by.has(id) || refused.includes(by.get(id)))
          p.people = [...new Set([...keep, ...split(there.people).map(l => ids.get(l)).filter(Boolean)])].slice(0, MAX.people ?? 10)
        }
        if (k === 'agent') {
          if (!there.agent) assignee = t.assignee_kind === 'session' ? null : undefined
          else { try { assignee = ctx.checkAssignee(board.id, { kind: 'session', id: there.agent }) } catch {} }
        }
      }
      // (Closed or opened there: a column that says so, unless its column came too.)
      if (toHere.includes('closed')) {
        const target = ctx.statusRow(p.status ?? t.status_id)
        const fits = there.closed === 'OPEN' ? !['done', 'closed'].includes(target?.category) : target?.category === (there.closed === 'NOT_PLANNED' ? 'closed' : 'done')
        if (!fits) p.status = columnFor(board.id, there.closed) ?? p.status
      }
      applyHere(t.seq, p, item, assignee)
      t = ctx.taskRow(t.seq)
      for (const k of toHere) synced[k] = there[k]
      // (What that changed besides, such as the column a closed issue took here: there too.)
      const after = ours(t, t.parent_seq ? linkOf(t.parent_seq)?.issue_id ?? 'unpublished' : null, refused)
      for (const k of keys) if (!toHere.includes(k) && !toThere.includes(k) && after[k] !== there[k] && after[k] !== 'unpublished') toThere.push(k)
    }
    // Ours, there.
    if (toThere.length) {
      const now = ours(t, t.parent_seq ? linkOf(t.parent_seq)?.issue_id ?? null : null, refused)
      const issue = link.issue_id
      if (link.draft_id && (toThere.includes('title') || toThere.includes('body'))) await gh.updateDraft(link.draft_id, { title: now.title, body: now.body })
      if (issue && (toThere.includes('title') || toThere.includes('body'))) await gh.updateIssue(issue, { title: now.title, body: now.body })
      if (toThere.includes('status') && now.status) await gh.setSelect(c.project_id, link.item_id, fields.status.id, now.status)
      for (const [k, f] of [['agent', fields.agent], ['type', fields.type]]) {
        if (!toThere.includes(k) || !f) continue
        await gh.setSelect(c.project_id, link.item_id, f.id, now[k] ? f.options.find(o => o.name.toLowerCase() === now[k].toLowerCase())?.id ?? null : null)
      }
      if (issue && toThere.includes('closed')) {
        if (now.closed === 'OPEN') await gh.reopenIssue(issue)
        else { if (there.closed !== 'OPEN') await gh.reopenIssue(issue); await gh.closeIssue(issue, now.closed) }
      }
      if (issue && toThere.includes('labels') && link.repo === c.repo) {
        const repoLabels = (await gh.repository(parseRepo(c.repo))).labels
        await gh.updateIssue(issue, { labelIds: await labelIdsThere(gh, c, repoLabels, now.labels) })
      }
      if (issue && toThere.includes('parent')) {
        if (now.parent) await gh.setParent(now.parent, issue)
        else if (there.parent) await gh.removeParent(there.parent, issue)
      }
      if (issue && toThere.includes('people')) {
        const want = split(now.people), have = split(there.people)
        const add = want.filter(l => !have.includes(l)), remove = have.filter(l => !want.includes(l))
        if (remove.length) await gh.removeAssignees(issue, (item.content.assignees?.nodes ?? []).filter(n => remove.includes(n.login.toLowerCase())).map(n => n.id))
        if (add.length) synced.refused = [...new Set([...refused, ...await assign(gh, issue, add)])]
      }
      for (const k of toThere) synced[k] = now[k]
      if (synced.refused?.length) synced.people = split(synced.people).filter(l => !synced.refused.includes(l)).join('\n')
    }
    db.prepare('UPDATE task_github SET synced = ? WHERE task_seq = ?').run(JSON.stringify(synced), t.seq)
  }

  // People onto an issue; who GitHub wouldn't take (no such user, or no access to the repository).
  async function assign(gh, issue, logins) {
    const ids = []
    for (const l of logins) { const id = await userIdOf(gh, l); if (id) ids.push(id) }
    const after = ids.length ? new Set((await gh.addAssignees(issue, ids)).map(l => l.toLowerCase())) : new Set()
    const refused = logins.filter(l => !after.has(l))
    if (refused.length) log(`GitHub wouldn't assign ${refused.join(', ')}: they need access to the repository`)
    return refused
  }

  async function labelIdsThere(gh, c, repoLabels, names) {
    const ids = []
    for (const name of names ? names.split('\n') : []) {
      let l = repoLabels.find(x => x.name.toLowerCase() === name.toLowerCase())
      if (!l) {
        const mine = ctx.labelRows(c.board_id).find(x => x.name.toLowerCase() === name.toLowerCase())
        l = await gh.createLabel(c.repo_id, mine?.name ?? name, LABEL_HEX[mine?.color] ?? LABEL_HEX.gray)
        repoLabels.push(l)
      }
      ids.push(l.id)
    }
    return ids
  }

  // A task of ours, as an issue of the board's repository in the project.
  async function publish(gh, c, project, fields, t, repoLabels) {
    if (!t || linkOf(t.seq)) return
    const parentIssue = t.parent_seq ? linkOf(t.parent_seq)?.issue_id ?? null : null
    const now = ours(t, parentIssue)
    const want = split(now.people)
    const ids = []
    for (const l of want) { const id = await userIdOf(gh, l); if (id) ids.push(id) }
    const issue = await gh.createIssue({ repositoryId: c.repo_id, title: now.title, body: now.body, labelIds: await labelIdsThere(gh, c, repoLabels, now.labels), parentIssueId: parentIssue ?? undefined, assigneeIds: ids })
    // (Linked at once, before it is in the project: a failure from here on is put right on the next sync, never made twice.)
    const got = new Set(issue.assignees.map(l => l.toLowerCase()))
    const refused = want.filter(l => !got.has(l))
    const synced = { ...now, status: null, agent: null, type: null, closed: 'OPEN', people: want.filter(l => got.has(l)).join('\n'), ...(refused.length ? { refused } : {}) }
    if (refused.length) log(`GitHub wouldn't assign ${refused.join(', ')} to ${c.repo}#${issue.number}: they need access to the repository`)
    db.prepare('INSERT INTO task_github (task_seq, board_id, item_id, issue_id, number, repo, url, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.seq, c.board_id, `pending:${issue.id}`, issue.id, issue.number, c.repo, issue.url, JSON.stringify(synced))
    const itemId = await gh.addItem(project.id, issue.id)
    db.prepare('UPDATE task_github SET item_id = ? WHERE task_seq = ?').run(itemId, t.seq)
    ctx.event(t.seq, FROM, 'changed', { github: `${c.repo}#${issue.number}` })
    ctx.changedTask(t.seq)
    if (now.status) { await gh.setSelect(project.id, itemId, fields.status.id, now.status); synced.status = now.status }
    for (const [k, f] of [['agent', fields.agent], ['type', fields.type]]) {
      const o = now[k] && f?.options.find(x => x.name.toLowerCase() === now[k].toLowerCase())
      if (o) { await gh.setSelect(project.id, itemId, f.id, o.id); synced[k] = now[k] }
    }
    if (now.closed !== 'OPEN') { await gh.closeIssue(issue.id, now.closed); synced.closed = now.closed }
    db.prepare('UPDATE task_github SET synced = ? WHERE task_seq = ?').run(JSON.stringify(synced), t.seq)
  }

  // Comments: GitHub's that are new here, and ours that aren't there yet.
  // What a comment says, as GitHub has it (ours without the signature they were sent with).
  const SIGNED = /^\*\*[^*\n]{1,200}\*\* \(SquadraHQ\):\n\n/
  const textOf = cm => cleanText(String(cm.body ?? '').replace(/\r\n/g, '\n').replace(SIGNED, '')).trim().slice(0, MAX.comment)
  // GitHub's comments on the issue: new ones here, edited ones edited, deleted ones no longer shown.
  function commentsChanged(link, list) {
    const there = new Map(list.nodes.filter(cm => cm?.id).map(cm => [cm.id, cm]))
    // (Of the latest 50 only: one older than those is still there, as far as can be told.)
    const oldest = Math.min(...[...there.values()].map(cm => Date.parse(cm.createdAt) || 0))
    const whole = (list.totalCount ?? there.size) <= there.size
    let changed = false
    for (const c of db.prepare('SELECT * FROM task_comments WHERE task_seq = ? AND gh_id IS NOT NULL AND deleted_at IS NULL').all(link.task_seq)) {
      const cm = there.get(c.gh_id)
      if (!cm) {
        if (whole || c.created_at >= oldest) { db.prepare('UPDATE task_comments SET deleted_at = ? WHERE id = ?').run(Date.now(), c.id); changed = true }
        continue
      }
      const text = textOf(cm)
      if (text && text !== c.text) { db.prepare('UPDATE task_comments SET text = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), c.id); changed = true }
    }
    return changed
  }
  async function comments(gh, link, item) {
    const list = item.content.comments
    if (list?.nodes && item !== NO_COMMENTS && commentsChanged(link, list)) { applying++; try { ctx.changedTask(link.task_seq) } finally { applying-- } }
    for (const cm of list?.nodes ?? []) {
      if (!cm?.id || db.prepare('SELECT 1 FROM task_comments WHERE gh_id = ?').get(cm.id)) continue
      const login = cm.author?.login ?? 'ghost'
      const text = textOf(cm)
      if (!text) continue
      if (db.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_seq = ? AND deleted_at IS NULL').get(link.task_seq).n >= MAX.comments) break
      db.prepare('INSERT INTO task_comments (task_seq, author, text, created_at, gh_id) VALUES (?, ?, ?, ?, ?)')
        .run(link.task_seq, JSON.stringify({ kind: 'github', id: login, name: `@${login}` }), text, Date.parse(cm.createdAt) || Date.now(), cm.id)
      applying++
      try { ctx.changedTask(link.task_seq) } finally { applying-- }
    }
    for (const cm of unsent(link.task_seq)) {
      const author = JSON.parse(cm.author)
      const id = await gh.comment(link.issue_id, `**${author.kind === 'session' ? author.id : author.name}** (SquadraHQ):\n\n${cm.text}`)
      db.prepare('UPDATE task_comments SET gh_id = ? WHERE id = ?').run(id, cm.id)
    }
  }

  // --- what boards.js tells it -------------------------------------------------------------
  // Into the trash here: out of the project there, its issue closed as not planned.
  // --- pull requests -----------------------------------------------------------------
  const PR_STATE = pr => (pr.merged || pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open')
  const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' }
  const prsOf = seq => db.prepare('SELECT number, title, url, state, review, author FROM task_prs WHERE task_seq = ? ORDER BY number DESC').all(seq)
  // The tasks of this board a pull request names (SQ-12 in its title, branch or text), or whose issue it closes.
  function tasksOfPr(pr, boardId, byIssue) {
    const id = ctx.prefix().replace(/[^A-Za-z0-9]/g, '')
    const re = new RegExp(`(?<![A-Za-z0-9])${id}-(\\d{1,9})(?![0-9])`, 'gi')
    const seqs = new Set()
    for (const text of [pr.title, pr.headRefName, pr.body]) for (const m of String(text ?? '').matchAll(re)) seqs.add(Number(m[1]))
    for (const n of pr.closingIssuesReferences?.nodes ?? []) { const seq = n && byIssue.get(n.id); if (seq) seqs.add(seq) }
    return [...seqs].filter(seq => ctx.taskRow(seq)?.board_id === boardId)
  }
  // The pull requests changed since the last time (the latest ones, the first time).
  async function pullRequests(gh, c, board) {
    const first = !c.prs_at
    const prs = await gh.pullRequests(parseRepo(c.repo), c.prs_at)
    const from = c.prs_from ?? Date.now()
    const byIssue = new Map(links(board.id).filter(l => l.issue_id).map(l => [l.issue_id, l.task_seq]))
    const moves = new Map() // task -> the pull request that, merged, takes it to done
    const touched = new Set()
    for (const pr of prs.slice().reverse()) { // (the oldest first: the latest word last)
      const state = PR_STATE(pr), review = REVIEW[pr.reviewDecision] ?? null
      const seqs = tasksOfPr(pr, board.id, byIssue)
      const had = new Map(db.prepare('SELECT task_seq, state FROM task_prs WHERE pr_id = ? AND board_id = ?').all(pr.id, board.id).map(r => [r.task_seq, r.state]))
      inTx(() => {
        // (One that no longer names a task: off it.)
        for (const seq of had.keys()) if (!seqs.includes(seq)) { db.prepare('DELETE FROM task_prs WHERE pr_id = ? AND task_seq = ?').run(pr.id, seq); touched.add(seq) }
        for (const seq of seqs) {
          db.prepare(`INSERT INTO task_prs (task_seq, pr_id, board_id, number, title, url, state, review, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_seq, pr_id) DO UPDATE SET number = excluded.number, title = excluded.title, url = excluded.url, state = excluded.state, review = excluded.review, author = excluded.author, updated_at = excluded.updated_at`)
            .run(seq, pr.id, board.id, pr.number, String(pr.title ?? '').slice(0, 300), pr.url, state, review, pr.author?.login ?? null, Date.parse(pr.updatedAt) || Date.now())
          touched.add(seq)
          const before = had.get(seq)
          // (In the history: linked, and merged or closed; not the first time, for the old ones.)
          const news = !before ? (first ? null : 'linked') : before !== state && ['merged', 'closed'].includes(state) ? state : null
          if (news) ctx.event(seq, FROM, 'pr', { number: pr.number, title: String(pr.title ?? '').slice(0, 300), url: pr.url, state, ...(news === 'linked' ? { linked: true } : {}) })
          if (state === 'merged' && before !== 'merged' && (Date.parse(pr.mergedAt) || 0) >= from) moves.set(seq, pr.number)
        }
      })
    }
    const latest = prs.reduce((m, pr) => (Date.parse(pr.updatedAt) > Date.parse(m ?? 0) ? pr.updatedAt : m), c.prs_at)
    db.prepare('UPDATE board_github SET prs_at = ?, prs_from = ? WHERE board_id = ?').run(latest ?? new Date(from).toISOString(), from, board.id)
    // Merged: to the first done column, unless it is done or cancelled already (or the board says not to).
    if (conn(board.id)?.merge_moves) {
      const done = ctx.statusRows(board.id).find(s => s.category === 'done')
      for (const seq of moves.keys()) {
        const t = ctx.taskRow(seq)
        if (done && t && !['done', 'closed'].includes(categoryOf(ctx.statusRow(t.status_id)))) applyHere(seq, { status: done.id })
      }
    }
    for (const seq of touched) ctx.changedTask(seq)
  }

  function taskDeleted(t) {
    lastTask.delete(t.seq)
    const l = linkOf(t.seq)
    if (!l || l.item_id.startsWith('trashed:')) return
    db.prepare('INSERT INTO github_outbox (board_id, item_id, issue_id, task_seq) VALUES (?, ?, ?, ?)').run(t.board_id, l.item_id, l.issue_id, t.seq)
    if (l.issue_id) db.prepare("UPDATE task_github SET item_id = 'trashed:' || task_seq WHERE task_seq = ?").run(t.seq)
    else db.prepare('DELETE FROM task_github WHERE task_seq = ?').run(t.seq) // (a draft is gone with its item: restored, it is published again)
  }
  // Out of the trash here: there again as it was (if it never left, nothing to do), ours the word.
  function taskRestored(seq) {
    const l = linkOf(seq)
    if (!l) return
    const o = db.prepare('SELECT * FROM github_outbox WHERE task_seq = ?').get(seq)
    if (o) {
      db.prepare('DELETE FROM github_outbox WHERE id = ?').run(o.id)
      db.prepare('UPDATE task_github SET item_id = ? WHERE task_seq = ?').run(o.item_id, seq)
      return
    }
    db.prepare("UPDATE task_github SET item_id = 'pending:' || issue_id, synced = ? WHERE task_seq = ?").run(JSON.stringify({ prefer: 'here' }), seq)
  }
  function columnsChanged(boardId) {
    if (conn(boardId)) db.prepare('UPDATE board_github SET columns_dirty = 1 WHERE board_id = ?').run(boardId)
  }

  return { connect, disconnect, setMergeMoves, prsOf, view, touch, syncBoard, watch, fresh, freshTask, taskDeleted, taskRestored, columnsChanged, linkOf, FROM }
}
