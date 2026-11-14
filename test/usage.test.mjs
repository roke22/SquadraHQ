// Token usage: what each agent spent read from its own record (Claude Code's
// transcript, Codex CLI's rollout, Grok CLI's usage.json), what started each
// turn, and the server keeping it added up by the hour and showing it by team,
// session, cause, task, model and date.
//
// Run: node --test test/usage.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './tempdirs.mjs'
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { claudeTokens, codexTokens, grokTokens, promptCause, createObserver } from '../plugins/pisha/observe.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Claude Code: one response, its four counts and model', () => {
  const e = { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 33738, cache_creation_input_tokens: 4677, output_tokens: 176 } } }
  assert.deepEqual(claudeTokens(e), { id: 'msg_1', model: 'claude-opus-5-5', input: 2, cache_read: 33738, cache_write: 4677, output: 176 })
  assert.equal(claudeTokens({ type: 'user', message: { usage: { input_tokens: 5 } } }), null)
  assert.equal(claudeTokens({ type: 'assistant', message: { id: 'm', usage: { input_tokens: 0, output_tokens: 0 } } }), null)
})

test('Codex CLI: each model call once, its cached input apart, with the model of the turn', () => {
  const state = {}
  const count = (total, last) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } })
  assert.equal(codexTokens({ type: 'turn_context', payload: { model: 'gpt-5.5-codex' } }, state), null)
  assert.deepEqual(codexTokens(count(29739, { input_tokens: 29713, cached_input_tokens: 29312, cache_write_input_tokens: 0, output_tokens: 26 }), state), { model: 'gpt-5.5-codex', input: 401, cache_read: 29312, cache_write: 0, output: 26 })
  // (The same event again, or an older one: the running total didn't move.)
  assert.equal(codexTokens(count(29739, { input_tokens: 29713, cached_input_tokens: 29312, output_tokens: 26 }), state), null)
  assert.deepEqual(codexTokens(count(31000, { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 61 }), state), { model: 'gpt-5.5-codex', input: 200, cache_read: 1000, cache_write: 0, output: 61 })
})

test('Grok CLI: the turns ended since the observer started, by model, each once', () => {
  const since = Date.parse('2026-11-08T11:00:00Z')
  const turn = (n, at, models) => ({ turnNumber: n, endedAt: at, modelUsage: models })
  const usage = turns => ({ turns })
  const state = { since, turn: 0 }
  const old = turn(1, '2026-11-08T10:59:00Z', { 'grok-4.7': { inputTokens: 100, cachedReadTokens: 0, outputTokens: 5, modelCalls: 1 } })
  const t2 = turn(2, '2026-11-08T11:08:25Z', { 'grok-4.7': { inputTokens: 57904, cachedReadTokens: 39552, cacheCreationTokens: 0, outputTokens: 774, modelCalls: 3 } })
  assert.deepEqual(grokTokens(usage([old, t2]), state), [{ model: 'grok-4.7', input: 18352, cache_read: 39552, cache_write: 0, output: 774, calls: 3, ts: Date.parse('2026-11-08T11:08:25Z') }])
  assert.deepEqual(grokTokens(usage([old, t2]), state), []) // (read again: nothing new)
  const t3 = turn(3, '2026-11-08T11:10:00Z', { 'grok-4.7': { inputTokens: 10, outputTokens: 2 }, 'grok-mini': { inputTokens: 7, cachedReadTokens: 4, outputTokens: 1 } })
  assert.deepEqual(grokTokens(usage([old, t2, t3]), state).map(t => [t.model, t.input, t.cache_read, t.output]), [['grok-4.7', 10, 0, 2], ['grok-mini', 3, 4, 1]])
})

test('what started a turn: a message, a notice, the inbox or the user; and the task it names', () => {
  assert.deepEqual(promptCause('<channel source="pisha" chat_id="lead" message_id="42" user="lead">\nDo SQ-12 now\n</channel>'), { cause: 'message', msg: 42, task: 'SQ-12' })
  assert.deepEqual(promptCause('<channel source="pisha" kind="pisha_board" user="pisha:board">\nSQ-3 reached your column\n</channel>'), { cause: 'board', task: 'SQ-3' })
  assert.deepEqual(promptCause('<channel source="pisha" kind="pisha_notice">\nworker1 is down\n</channel>'), { cause: 'notice' })
  assert.deepEqual(promptCause('Inbox #7 ("Stack the discounts?"), the user answers from their inbox: Stack'), { cause: 'inbox' })
  assert.deepEqual(promptCause('fix the failing test'), { cause: 'user' })
})

test('the observer: each response once, with what started its turn, a subagent too, Codex and Grok from their files', async () => {
  const dir = tempDir('pisha-tokens-')
  const run = async (transcript, steps) => {
    const sent = []
    const o = createObserver({ level: 'activity', send: async batch => { sent.push(...batch) } })
    o._onHook({ ts: Date.now(), input: { hook_event_name: 'SessionStart', transcript_path: transcript, cwd: '/x' } })
    await steps(o)
    await o.stop()
    return sent.filter(e => e.kind === 'tokens')
  }
  // Claude Code: a response on three lines, then one more; a subagent's file at its end.
  const claude = join(dir, 'c.jsonl'), sub = join(dir, 'agent-1.jsonl')
  writeFileSync(claude, '')
  const reply = (id, out) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: out } } }) + '\n'
  writeFileSync(sub, reply('msg_s1', 7) + reply('msg_s1', 7))
  const c = await run(claude, async o => {
    o._onHook({ ts: Date.now(), input: { hook_event_name: 'UserPromptSubmit', prompt: '<channel source="pisha" message_id="9" user="lead">\nSQ-4 please\n</channel>' } })
    appendFileSync(claude, reply('msg_a', 30) + reply('msg_a', 30) + reply('msg_a', 30))
    o.sync()
    o._onHook({ ts: Date.now(), input: { hook_event_name: 'UserPromptSubmit', prompt: 'and add a test' } })
    appendFileSync(claude, reply('msg_b', 12))
    o.sync()
    o._onHook({ ts: Date.now(), input: { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_transcript_path: sub } })
  })
  assert.deepEqual(c.map(t => [t.output, t.cause, t.msg ?? null, t.task ?? null, !!t.sub]), [[30, 'message', 9, 'SQ-4', false], [12, 'user', null, null, false], [7, 'user', null, null, true]])
  assert.deepEqual([c[0].input, c[0].cache_read, c[0].cache_write, c[0].model], [2, 900, 50, 'claude-opus-5-5'])

  // Codex CLI: its rollout.
  const codex = join(dir, 'rollout-2026-11-08T11-06-31-x.jsonl')
  writeFileSync(codex, '')
  const x = await run(codex, async o => {
    appendFileSync(codex, [{ type: 'turn_context', payload: { model: 'gpt-5.5-codex' } }, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 500 }, last_token_usage: { input_tokens: 480, cached_input_tokens: 400, output_tokens: 20 } } } }].map(l => JSON.stringify(l) + '\n').join(''))
    o.sync()
  })
  assert.deepEqual(x.map(t => [t.model, t.input, t.cache_read, t.output, t.cause]), [['gpt-5.5-codex', 80, 400, 20, 'self']])

  // Grok CLI: usage.json beside updates.jsonl, written after the turn.
  const g = join(dir, 'grok', '01a1bad7')
  mkdirSync(g, { recursive: true })
  writeFileSync(join(g, 'updates.jsonl'), '')
  const gr = await run(join(g, 'updates.jsonl'), async o => {
    o._onHook({ ts: Date.now(), input: { hook_event_name: 'UserPromptSubmit', prompt: 'Inbox #3 ("Ship it?"), the user answers from their inbox: yes' } })
    writeFileSync(join(g, 'usage.json'), JSON.stringify({ turns: [{ turnNumber: 1, endedAt: new Date(Date.now() + 1000).toISOString(), modelUsage: { 'grok-4.7': { inputTokens: 600, cachedReadTokens: 500, outputTokens: 9, modelCalls: 2 } } }] }))
    o.sync()
  })
  assert.deepEqual(gr.map(t => [t.model, t.input, t.cache_read, t.output, t.calls, t.cause]), [['grok-4.7', 100, 500, 9, 2, 'inbox']])

  // With observation off, the tokens are still counted, and nothing else is sent.
  const off = join(dir, 'off.jsonl')
  writeFileSync(off, '')
  const sentOff = []
  const o = createObserver({ level: 'off', send: async batch => { sentOff.push(...batch) } })
  o._onHook({ ts: Date.now(), input: { hook_event_name: 'SessionStart', transcript_path: off, cwd: '/x' } })
  o._onHook({ ts: Date.now(), input: { hook_event_name: 'UserPromptSubmit', prompt: 'secret plans' } })
  appendFileSync(off, reply('msg_off', 3))
  o.sync()
  await o.stop()
  assert.deepEqual(sentOff.map(e => [e.kind, e.output, e.cause]), [['tokens', 3, 'user']])
})

// --- the server ------------------------------------------------------------------

const TOKEN = 'test-server-token-usage-0123456789'
const PORT = 28000 + Math.floor(Math.random() * 400) // (a range no other test file uses: they run at once)
const URL_ = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
let server
before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tempDir('pisha-usage-'), PISHA_SERVER_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d) })
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${URL_}/health`)).ok) break } catch {}
    if (i > 160) throw new Error('server did not start')
    await sleep(50)
  }
})
after(() => server?.kill('SIGTERM'))

const api = async (method, params, secret, instance) => (await fetch(`${URL_}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...(instance ? { 'X-Pisha-Instance': instance } : {}) },
  body: JSON.stringify(params),
})).json()
const get = async path => (await fetch(`${URL_}/api/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
const post = async (path, body) => (await fetch(`${URL_}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json()
async function session(name, role, coordinator) {
  const secret = (await api('register', { name }, TOKEN)).result.secret
  const instance = `inst-${name}-000001`
  await api('claimSession', { instance, role, ...(coordinator ? { coordinator } : {}), ...(name.startsWith('cx') ? { agent: 'codex' } : {}) }, secret, instance)
  return {
    send: async (chat_id, text) => (await api('sendMessage', { chat_id, text }, secret, instance)).result,
    spend: async events => api('observe', { events: events.map(e => ({ kind: 'tokens', ts: Date.now(), model: 'claude-opus-5-5', input: 10, cache_read: 100, cache_write: 20, output: 5, ...e })) }, secret, instance),
  }
}

test('the server keeps what each session spent, on what, and shows it by team, cause, task and date', async () => {
  const lead = await session('ulead', 'coordinator')
  const w1 = await session('uw1', 'worker', 'ulead')
  const other = await session('cxother', 'coordinator')
  assert.ok((await post('links/add', { a: 'ulead', b: 'cxother' })).ok)
  const board = (await post('boards/create', { name: 'Factory', teams: ['ulead'] })).result
  const task = (await post('tasks/create', { board: board.id, title: 'Website', assignee: { kind: 'session', id: 'uw1' } })).result

  const order = await lead.send('uw1', `Build SQ-${task.seq}, the website`)
  const report = await w1.send('ulead', 'done')
  const ask = await other.send('ulead', 'the copy is ready')
  // A worker on its coordinator's order, about a task; then the user in its
  // terminal, naming something that is no task (UTF-8).
  assert.equal((await w1.spend([{ cause: 'message', msg: order.message_id, task: `SQ-${task.seq}` }, { cause: 'message', msg: order.message_id, task: `SQ-${task.seq}`, output: 15 }, { cause: 'user', task: 'UTF-8', input: 1000, sub: true }])).result.stored, 3)
  // A coordinator on its worker's report, on a linked team's message, on the board.
  await lead.spend([{ cause: 'message', msg: report.message_id }, { cause: 'message', msg: ask.message_id, model: 'claude-sonnet-5-5' }, { cause: 'board', task: `SQ-${task.seq}` }])
  await other.spend([{ cause: 'inbox', model: 'gpt-5.5-codex', cache_write: 0 }])
  // (Kept as counts, not as events: nothing of it in the session's activity.)
  assert.ok(!(await get('events?session=uw1')).result.some(e => e.kind === 'tokens'))

  const u = (await get('usage')).result
  const total = r => r.input + r.cache_read + r.cache_write + r.output
  assert.equal(u.totals.calls, 7)
  assert.deepEqual([u.totals.input, u.totals.output], [10 * 6 + 1000, 5 * 6 + 15])
  const by = (d, key) => u.by[d].find(r => r[d] === key)
  assert.equal(by('cause', 'coordinator').calls, 2)
  assert.equal(by('cause', 'worker').calls, 1)
  assert.equal(by('cause', 'link').calls, 1)
  assert.equal(by('cause', 'board').calls, 1)
  assert.equal(by('cause', 'user').calls, 1)
  assert.equal(by('cause', 'inbox').calls, 1)
  assert.equal(by('task', `SQ-${task.seq}`).calls, 3)
  assert.ok(!by('task', 'UTF-8'))
  assert.equal(by('team', 'ulead').calls, 6) // (the coordinator and its worker)
  assert.equal(by('agent', 'codex').calls, 1)
  assert.equal(by('model', 'claude-sonnet-5-5').calls, 1)
  assert.deepEqual(u.by.session.find(r => r.session === 'uw1'), { session: 'uw1', team: 'ulead', role: 'worker', agent: 'claude', input: 1020, cache_read: 300, cache_write: 60, output: 25, calls: 3 })
  assert.equal(u.series.length, 1)
  assert.equal(total(u.series[0]), total(u.totals))
  // Filtered: one team; by the hour.
  const f = (await get('usage?team=cxother&bucket=hour')).result
  assert.deepEqual([f.totals.calls, f.bucket, f.series.length], [1, 'hour', 1])
  // A range with nothing in it.
  assert.equal((await get(`usage?from=${Date.now() - 3 * 86400_000}&to=${Date.now() - 2 * 86400_000}`)).result.totals.calls, 0)
  assert.match((await get('usage?from=10&to=5')).description, /from must be before to/)
})
