// What the dashboard's tests run against: a real server, sessions that keep
// polling it as a plugin does, and a machine that answers like pisha-host.

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { totpCode, totpStep } from '../../server/accounts/totp.js'
import { tempDir } from '../tempdirs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export const SERVER_TOKEN = 'dashboard-test-server-token'

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

export const OWNER = { email: 'owner@example.com', name: 'The Owner', password: 'a long enough password' }

export async function startServer({ tokenApi = true, env = {} } = {}) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const dataDir = tempDir('pisha-ui-')
  let log = ''
  const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    // (The token keeps working on /api: what these tests set up isn't the page.)
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PISHA_SERVER_TOKEN: SERVER_TOKEN, PISHA_ALLOW_TOKEN_API: tokenApi ? '1' : '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break } catch {}
    if (i > 200) throw new Error(`the server did not start:\n${log}`)
    await sleep(50)
  }
  const closers = []
  let cookie = ''
  return {
    url,
    log: () => log, // (what the server wrote, to see why a test failed)
    async call(path, params = {}, { auth = SERVER_TOKEN, instance } = {}) {
      const res = await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...(instance ? { 'X-Pisha-Instance': instance } : {}) },
        body: JSON.stringify(params),
      })
      const body = await res.json()
      if (!body.ok) throw new Error(`${path}: ${body.description}`)
      return body.result
    },
    onClose(fn) { closers.push(fn) },
    // The first owner, signed in once, and the cookie that says so: a code
    // counts only once, so the tests share this sign-in.
    async ownerCookie() {
      if (cookie) return cookie
      const post = async (path, body, headers = {}) => {
        const res = await fetch(`${url}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) })
        const set = res.headers.get('set-cookie')
        if (set) cookie = set.split(';')[0]
        const j = await res.json()
        if (!j.ok) throw new Error(`${path}: ${j.description}`)
        return j.result
      }
      await post('bootstrap', OWNER, { Authorization: `Bearer ${SERVER_TOKEN}` })
      const { secret } = await post('auth/totp/setup', {})
      await post('auth/totp/enable', { code: totpCode(secret, totpStep()) })
      return cookie
    },
    async stop() {
      for (const fn of closers) await fn()
      proc.kill('SIGTERM')
      await new Promise(r => proc.once('exit', r))
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// A session as a plugin keeps it: logged in, long polling.
export async function startSession(server, name, role, coordinator, secret, { agent } = {}) {
  secret ??= (await server.call('register', { name })).secret
  const instance = `inst-${name}-0001`
  const opts = { auth: secret, instance }
  await server.call('claimSession', { instance, role, coordinator, ...(agent ? { agent } : {}) }, opts)
  let stopped = false
  // (One signal per request: reusing one piles a listener on it each time.)
  let stop = new AbortController()
  const polling = (async () => {
    let offset = 0
    while (!stopped) {
      stop = new AbortController()
      try {
        const res = await fetch(`${server.url}/getUpdates`, {
          method: 'POST',
          signal: stop.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'X-Pisha-Instance': instance },
          body: JSON.stringify({ instance, offset, timeout: 5 }),
        })
        const { result } = await res.json()
        for (const u of result ?? []) offset = u.update_id + 1
      } catch { if (!stopped) await sleep(100) }
    }
  })()
  server.onClose(async () => { stopped = true; stop.abort(); await polling })
  return {
    name,
    send: (to, text) => server.call('sendMessage', { chat_id: to, text }, opts),
    call: (method, params) => server.call(method, params, opts),
    observe: events => server.call('observe', { events }, opts),
  }
}

// A machine that shows one terminal, opens more when asked, and answers what is
// typed in a terminal the way a program there would: by writing it back.
// (screens: what a terminal shows when watched, by its name; the screenshots give it one.)
export async function startMachine(server, name, terminal, { screens = {}, code: given = null } = {}) {
  // (With a code the dashboard made, it joins as the machine that ran its command.)
  const { code } = given ? { code: given } : await server.call('api/hosts/enroll', { name })
  const { id, secret } = await server.call('host/enroll', { code, info: { hostname: name } })
  const typed = []
  const answers = [] // what the inbox had it type, as { term, text }
  const identities = new Map() // the sessions it opened -> their secret
  const opened = [] // what it was asked to open, as the server sent it
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/host/connect`, ['pisha', `auth.${secret}`])
  const send = m => ws.send(JSON.stringify(m))
  const b64 = text => Buffer.from(text).toString('base64')
  const info = {
    hostname: name, platform: 'linux', arch: 'x64', version: '0.0.7', folders: ['/srv/squad'], allow_input: true, answers: true, max_sessions: 8, permission_profiles: 'allow',
    terminals: [{ id: terminal.id, role: terminal.role, coordinator: terminal.coordinator, folder: '/srv/squad', created_at: Date.now() }],
  }
  await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('the machine could not connect'))
    ws.onopen = () => {
      send({ t: 'hello', info })
    }
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.t === 'welcome') resolve()
      if (m.t === 'answer') { answers.push({ term: m.term, text: m.text }); send({ t: 'reply', req: m.req, ok: true, result: { typed: true } }) }
      if (m.t === 'open') {
        identities.set(m.spec.name, m.spec.identity)
        opened.push(m.spec)
        info.terminals.push({ id: m.spec.name, role: m.spec.role, coordinator: m.spec.coordinator, folder: '/srv/squad', created_at: Date.now() })
        send({ t: 'info', info })
        send({ t: 'reply', req: m.req, ok: true, result: { id: m.spec.name } })
      }
      // (Its personas: a skill only in the payments subfolder, to tell the folders apart.)
      if (m.t === 'personas') send({ t: 'reply', req: m.req, ok: true, result: { personas: m.folder === '/srv/squad/payments' ? [{ id: 'skill:project:payments-lead', kind: 'skill', scope: 'project', name: 'payments-lead', description: 'Leads the payments team' }] : [] } })
      if (m.t === 'attach') send({ t: 'screen', term: m.term, data: b64(screens[m.term] ?? 'screen from the machine\r\n'), cols: m.cols, rows: m.rows })
      if (m.t === 'in') { typed.push(m.data); send({ t: 'out', term: m.term, data: b64(m.data) }) }
    }
  })
  server.onClose(() => ws.close())
  return { id, typed, answers, identities, opened }
}
