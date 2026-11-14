// Upgrading a server: from 0.0.1, the one-time cleaning of what that version
// stored goes through every row (more than one batch); from 0.0.7, the last
// release, machines, sessions and what it held go on working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { totpCode, totpStep } from '../server/accounts/totp.js'
import { tempDir } from './tempdirs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'upgrade-admin-token-0123456789'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function serverOf(tag) {
  try {
    const dir = tempDir('pisha-old-')
    execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${tag} server | tar -x -C "${dir}"`], { stdio: 'ignore' })
    // (Without the tag — a shallow clone, as in CI — nothing is extracted; macOS's
    // tar doesn't fail on the empty input.)
    return existsSync(join(dir, 'server', 'server.js')) ? dir : null
  } catch { return null }
}
// (Releases before the name Pisha kept their data under another name, and the
// rename was a clean break: their data isn't carried over. These come back
// with the first Pisha release as the one to upgrade from.)
const BEFORE_PISHA = 'releases before Pisha are not upgraded: a clean break'
const oldServerDir = null
const lastRelease = null

async function run(script, dataDir, port) {
  const proc = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PISHA_SERVER_TOKEN: ADMIN },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  proc.stderr.on('data', d => { err += d })
  const exited = new Promise(r => proc.on('exit', code => r(code)))
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { proc, exited } } catch {}
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}: ${err.slice(-2000)}`)
    await sleep(50)
  }
  throw new Error(`server did not start: ${err.slice(-2000)}`)
}
const stop = async s => { s.proc.kill('SIGTERM'); await s.exited }

test('a 0.0.1 database: the new server starts and cleans every old row', { skip: !oldServerDir && BEFORE_PISHA }, async () => {
  const dataDir = tempDir('pisha-up-')
  mkdirSync(dataDir, { recursive: true })
  const port = 23000 + Math.floor(Math.random() * 2000)

  // The old server creates its database.
  const old = await run(join(oldServerDir, 'server/server.js'), dataDir, port)
  for (const name of ['alice', 'bob']) {
    const r = await fetch(`http://127.0.0.1:${port}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ name }) }).then(x => x.json())
    assert.ok(r.ok, r.description)
  }
  await stop(old)

  // What 0.0.1 could leave behind: more than one batch of uncleaned rows,
  // fractional event times.
  const db = new DatabaseSync(join(dataDir, 'pisha.db'))
  const t = Date.now()
  const ev = db.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)')
  const msg = db.prepare('INSERT INTO messages (from_name, target, text, created_at) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < 2500; i++) ev.run('alice', t - 60_000 + i + 0.5, 'text', JSON.stringify({ text: `step ${i} ‮evil` }))
  for (let i = 0; i < 1500; i++) msg.run('alice', 'bob', `hello ${i} ‮deploy`, t - 60_000 + i)
  db.exec('COMMIT')
  db.close()

  // The new server starts on it.
  const now = await run(join(ROOT, 'server/server.js'), dataDir, port)
  await stop(now)

  const after = new DatabaseSync(join(dataDir, 'pisha.db'))
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM events WHERE data LIKE '%' || char(8238) || '%'").get().n, 0, 'every event cleaned')
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM events WHERE ts != CAST(ts AS INTEGER)').get().n, 0, 'whole-millisecond times')
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%' || char(8238) || '%'").get().n, 0, 'every message cleaned')
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2500)
  after.close()

  // And it starts again (nothing left half done).
  await stop(await run(join(ROOT, 'server/server.js'), dataDir, port))
})

test('a 0.0.7 server: machines, sessions and tokens go on working, with nothing to do on them', { skip: !lastRelease && BEFORE_PISHA }, async () => {
  const dataDir = tempDir('pisha-up7-')
  const port = 23000 + Math.floor(Math.random() * 2000)
  const at = path => `http://127.0.0.1:${port}/${path}`
  const post = (path, body, auth) => fetch(at(path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body ?? {}) }).then(x => x.json())
  const ok = r => { assert.ok(r.ok, r.description); return r.result }

  const old = await run(join(lastRelease, 'server/server.js'), dataDir, port)
  let join_, key, session, host
  try {
    join_ = readFileSync(join(dataDir, 'join-token'), 'utf8').trim()
    key = ok(await fetch(at('server-identity?nonce=0123456789abcdef')).then(x => x.json())).key
    session = ok(await post('register', { name: 'veteran' }, join_)).secret
    const en = ok(await post('api/hosts/enroll', { name: 'old-machine' }, ADMIN))
    host = ok(await post('host/enroll', { code: en.code, info: { hostname: 'old-machine' } }))
  } finally { await stop(old) }

  const now = await run(join(ROOT, 'server/server.js'), dataDir, port)
  try {
    assert.equal(ok(await fetch(at('server-identity?nonce=0123456789abcdef')).then(x => x.json())).key, key)
    assert.equal(ok(await post('getMe', {}, session)).id, 'veteran')
    assert.ok(ok(await post('host/ticket', {}, host.secret)).ticket)
    ok(await post('register', { name: 'newcomer' }, join_))
    const state = ok(await fetch(at('api/state'), { headers: { Authorization: `Bearer ${ADMIN}` } }).then(x => x.json()))
    assert.deepEqual(state.sessions.map(s => s.name).sort(), ['newcomer', 'veteran'])
    assert.deepEqual(state.hosts.map(h => h.name), ['old-machine'])
    // What was there is the first company, and a new one starts empty.
    const fresh = ok(await post('admin/createCompany', { name: 'Compañía nueva' }, ADMIN))
    assert.deepEqual(ok(await fetch(at(`api/c/${fresh.id}/state`), { headers: { Authorization: `Bearer ${ADMIN}` } }).then(x => x.json())).sessions, [])
    assert.ok(existsSync(join(dataDir, 'pisha-before-companies.db')))
  } finally { await stop(now) }
})

test('a 0.0.7 server: what it held is all there for its first owner, and its coordinators use the inbox', { skip: !lastRelease && BEFORE_PISHA }, async () => {
  const dataDir = tempDir('pisha-up7b-')
  const port = 23000 + Math.floor(Math.random() * 2000)
  const at = path => `http://127.0.0.1:${port}/${path}`
  const post = (path, body, auth, instance) => fetch(at(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(instance ? { 'X-Pisha-Instance': instance } : {}) },
    body: JSON.stringify(body ?? {}),
  }).then(x => x.json())
  const get = (path, auth) => fetch(at(path), { headers: { Authorization: `Bearer ${auth}` } }).then(x => x.json())
  const ok = r => { assert.ok(r.ok, r.description); return r.result }
  // A session as the plugin is: its secret and the instance it claimed.
  const session = async (name, role, coordinator) => {
    const secret = ok(await post('register', { name }, ADMIN)).secret
    const instance = `inst-${name}-000001`
    const call = (method, body) => post(method, body, secret, instance)
    ok(await call('claimSession', { instance, role, ...(coordinator ? { coordinator } : {}) }))
    return call
  }

  const old = await run(join(lastRelease, 'server/server.js'), dataDir, port)
  let boss
  try {
    boss = await session('boss', 'coordinator')
    await session('hand', 'worker', 'boss')
    ok(await boss('sendMessage', { chat_id: 'hand', text: 'a task from the 0.0.7 days' }))
    ok(await post('api/org/squad', { coordinator: 'boss', title: 'Shop', goal: 'Sell more' }, ADMIN))
    ok(await post('api/templates/save', { name: 'Shop team', coordinator: { name: 'boss', folder: '/srv/shop' }, workers: [{ name: 'hand', folder: '/srv/shop' }] }, ADMIN))
  } finally { await stop(old) }

  const now = await run(join(ROOT, 'server/server.js'), dataDir, port)
  try {
    // Its coordinator goes on where it was, and the inbox is there for it.
    ok(await boss('claimSession', { instance: 'inst-boss-000001', role: 'coordinator' }))
    const asked = ok(await boss('askUser', { text: 'Stack the discounts?', options: ['Stack', 'Biggest'] }))
    assert.ok(asked.id)

    // The token makes the first owner, who sees all of it in the first company.
    const origin = `http://127.0.0.1:${port}`
    let cookie = ''
    const browser = async (method, path, body, headers = {}) => {
      const r = await fetch(at(path), {
        method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      })
      const set = r.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]
      return r.json()
    }
    assert.equal(ok(await browser('GET', 'auth/status')).needs_owner, true)
    ok(await browser('POST', 'bootstrap', { email: 'owner@example.com', name: 'Owner', password: 'a long enough password 1' }, { Authorization: `Bearer ${ADMIN}` }))
    const { secret } = ok(await browser('POST', 'auth/totp/setup'))
    assert.equal(ok(await browser('POST', 'auth/totp/enable', { code: totpCode(secret, totpStep()) })).stage, 'ok')
    const state = ok(await browser('GET', 'api/c/default/state'))
    assert.deepEqual(state.sessions.map(s => s.name).sort(), ['boss', 'hand'])
    assert.deepEqual(state.squads.map(q => [q.coordinator, q.title, q.goal]), [['boss', 'Shop', 'Sell more']])
    assert.deepEqual(state.templates.map(t => t.name), ['Shop team'])
    assert.deepEqual(state.inbox.map(i => [i.id, i.text, i.version]), [[asked.id, 'Stack the discounts?', 1]])
    const messages = ok(await browser('GET', 'api/c/default/messages?session=hand'))
    assert.ok(messages.some(m => m.text === 'a task from the 0.0.7 days'))
    // From then on the token no longer opens the dashboard.
    assert.equal((await get('api/state', ADMIN)).error_code, 401)
  } finally { await stop(now) }
})
