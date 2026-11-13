// A board kept in step with a GitHub project, both ways, against a GitHub
// that answers from memory (fake-github.mjs): columns, issues, drafts,
// agents, types, labels, sub-issues, comments, closing and deleting.
//
// Run: node --test test/github-sync.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGithub } from './fake-github.mjs'
import { startServer, SERVER_TOKEN as TOKEN } from './ui/harness.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

let server, gh, URL_
before(async () => {
  gh = await startFakeGithub()
  server = await startServer({ env: { SQUADRA_GITHUB_API: gh.url, SQUADRA_GITHUB_FRESH_MS: '6000' } })
  URL_ = server.url
})
after(async () => { if (process.env.DEBUG) process.stderr.write(server?.log() ?? ''); await server?.stop(); await gh?.stop() })

const api = async (method, params, secret, instance) => (await fetch(`${URL_}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...(instance ? { 'X-Squadra-Instance': instance } : {}) },
  body: JSON.stringify(params),
})).json()
const get = async path => (await fetch(`${URL_}/api/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
const post = async (path, body) => (await fetch(`${URL_}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json()

async function session(name, role, coordinator) {
  const secret = (await api('register', { name }, TOKEN)).result.secret
  const instance = `inst-${name}-000001`
  await api('claimSession', { instance, role, ...(coordinator ? { coordinator } : {}) }, secret, instance)
  return {
    board: async params => (await api('board', params, secret, instance)).result,
    notices: async () => {
      const u = await api('getUpdates', { offset: 0, timeout: 0, instance }, secret, instance)
      return (u.result ?? []).map(x => x.message).filter(m => m?.from?.id === 'squadra:board')
    },
  }
}
const tasks = async board => (await get(`c/default/boards/tasks?board=${board}`)).result
const task = async seq => (await get(`c/default/boards/task?id=${seq}`)).result
const byTitle = async (board, title) => (await tasks(board)).find(t => t.title === title)
const watch = async body => assert.ok((await post('boards/github-watch', body)).ok)
const sync = async board => { const r = await post('boards/github-sync', { board }); assert.ok(r.ok, r.description); assert.equal(r.result.github.error, null); return r.result }

test('github: a board in step with a project, both ways, and nobody told by it', async () => {
  const coord = await session('gc1', 'coordinator')
  await session('gdev', 'worker', 'gc1')
  // On GitHub already: two issues and a draft.
  const login = gh.person.addIssue({ title: 'Login page', status: 'Todo', labels: ['bug'] })
  gh.person.comment(login.id, 'Seen on Safari')
  const signup = gh.person.addIssue({ title: 'Signup', status: 'In Progress' })
  gh.person.comment(signup.id, 'Use the new form component')
  gh.person.addDraft({ title: 'Idea: dark mode' })

  const board = (await post('boards/create', { name: 'Web', teams: ['gc1'] })).result
  // Wrong address, repository or token: said so, nothing saved.
  assert.match((await post('boards/github', { board: board.id, url: 'https://example.com/x', repo: 'acme/web', token: gh.token })).description, /its address on GitHub/)
  assert.match((await post('boards/github', { board: board.id, url: 'https://github.com/orgs/acme/projects/3', repo: 'acme/web', token: 'ghp_wrong' })).description, /refused the token/)
  assert.match((await post('boards/github', { board: board.id, url: 'https://github.com/orgs/acme/projects/9', repo: 'acme/web', token: gh.token })).description, /no project 9/)

  let r = await post('boards/github', { board: board.id, url: 'https://github.com/orgs/acme/projects/3', repo: 'acme/web', token: gh.token })
  assert.ok(r.ok, r.description)
  assert.deepEqual([r.result.title, r.result.repo], ['Web launch', 'acme/web'])
  assert.ok(!JSON.stringify(r.result).includes(gh.token))
  let b = await sync(board.id)

  // The columns are GitHub's (theirs first), and ours GitHub lacked are there now; every card kept its column.
  assert.deepEqual(b.statuses.slice(0, 3).map(s => s.name), ['Todo', 'In Progress', 'Done'])
  assert.deepEqual(gh.look.options(), b.statuses.map(s => s.name))
  assert.equal(gh.look.statusOf(login.id), 'Todo')
  assert.equal(gh.look.statusOf(signup.id), 'In Progress')
  // GitHub's items are tasks, in their column, with their labels and comments.
  const st = name => b.statuses.find(s => s.name === name).id
  const tLogin = await byTitle(board.id, 'Login page')
  assert.equal(tLogin.status, st('Todo'))
  assert.deepEqual(tLogin.labels.map(id => b.labels.find(l => l.id === id).name), ['bug'])
  // (A task's comments come when it is opened.)
  const tSignup = await task((await byTitle(board.id, 'Signup')).seq)
  assert.deepEqual(tSignup.comments, [])
  let before = gh.calls.length
  await watch({ board: board.id, task: tSignup.seq, taskOpened: true })
  assert.deepEqual(gh.calls.slice(before), ['Project', 'Item'])
  assert.deepEqual((await task(tSignup.seq)).comments.map(c => [c.author.name, c.text]), [['@octocat', 'Use the new form component']])
  // Opened again by someone else at once, or the board just read: GitHub isn't asked again.
  before = gh.calls.length
  await watch({ board: board.id, task: tSignup.seq, opened: true, taskOpened: true })
  assert.equal(gh.calls.length, before)
  // An agent reading a task: GitHub's comments first.
  const seen = await coord.board({ action: 'get', id: tLogin.id })
  assert.match(seen.comments.at(-1), /^@octocat, .*: Seen on Safari$/)
  assert.ok(await byTitle(board.id, 'Idea: dark mode'))
  // The project has an Agent field with the board's agents, and a Type field with its types.
  assert.deepEqual(gh.look.field('Agent').options.map(o => o.name).sort(), ['gc1', 'gdev'])
  assert.deepEqual(gh.look.field('Task type').options.map(o => o.name), ['Task', 'Bug'])

  // Made here: an issue in the repository, in the project, with its column, agent and type.
  const pricing = (await post('tasks/create', { board: board.id, title: 'Pricing table', status: st('In Progress'), assignee: { kind: 'session', id: 'gdev' }, type: 'Bug' })).result
  await sync(board.id)
  const iPricing = gh.look.issue('Pricing table')
  assert.ok(iPricing && gh.look.inProject(iPricing.id))
  assert.deepEqual([gh.look.statusOf(iPricing.id), gh.look.fieldOf(iPricing.id, 'Agent'), gh.look.fieldOf(iPricing.id, 'Task type')], ['In Progress', 'gdev', 'Bug'])
  assert.match((await task(pricing.seq)).events.at(-1).data.github, /^acme\/web#\d+$/)
  // A subtask of it: a sub-issue. A comment: on the issue, signed.
  const sub = (await post('tasks/create', { board: board.id, title: 'Pricing: annual plan', parent: pricing.seq })).result
  await post('tasks/comment', { id: pricing.seq, text: 'Prices are in the sheet' })
  await sync(board.id)
  assert.equal(gh.look.issue('Pricing: annual plan').parent, iPricing.id)
  assert.ok(gh.calls.includes('ItemOf')) // (GitHub had put it in the project by itself)
  assert.deepEqual((await task(sub.seq)).github?.number, gh.look.issue('Pricing: annual plan').number)
  assert.match(iPricing.comments.at(-1).body, /^\*\*.+\*\* \(SquadraHQ\):\n\nPrices are in the sheet$/)
  // Done here: closed there, as completed, in its column.
  await post('tasks/update', { id: tLogin.seq, status: st('Done') })
  await sync(board.id)
  assert.deepEqual([gh.look.issue('Login page').state, gh.look.issue('Login page').stateReason, gh.look.statusOf(login.id)], ['CLOSED', 'COMPLETED', 'Done'])

  // Changed there: here, as GitHub's, and an agent given a task there isn't told.
  gh.person.edit(signup.id, { title: 'Signup with Google' })
  gh.person.close(signup.id, 'NOT_PLANNED')
  gh.person.comment(signup.id, 'Not this quarter')
  gh.person.setField(gh.look.issue('Pricing: annual plan').id, 'Agent', 'gdev')
  b = await sync(board.id)
  await sleep(600) // (opened again a moment later: read again, with its comments)
  await watch({ board: board.id, task: tSignup.seq, taskOpened: true })
  const signupNow = await task(tSignup.seq)
  assert.equal(signupNow.title, 'Signup with Google')
  assert.equal(b.statuses.find(s => s.id === signupNow.status).category, 'closed')
  assert.deepEqual(signupNow.comments.map(c => c.text), ['Use the new form component', 'Not this quarter'])
  assert.deepEqual(signupNow.events.at(-1).who, { kind: 'github', id: 'github', name: 'GitHub' })
  const subNow = await task(sub.seq)
  assert.deepEqual([subNow.assignee?.id, subNow.notify], ['gdev', 'pending'])
  assert.deepEqual(await coord.notices(), [])
  // (Nothing changed: nothing written there.)
  before = gh.calls.length
  await sync(board.id)
  assert.deepEqual(gh.calls.slice(before).filter(c => !['Project', 'Items', 'Repository', 'Item'].includes(c)), [])

  // A change here goes on its own, soon, without reading the whole board.
  before = gh.calls.length
  const ghState = async () => (await get('c/default/boards')).result.boards.find(x => x.id === board.id).github
  await post('tasks/update', { id: pricing.seq, title: 'Pricing table v2' })
  assert.ok((await ghState()).pending >= 1) // (the dashboard says it is on its way)
  for (let i = 0; i < 100 && gh.look.issue('Pricing table v2') == null; i++) await sleep(100)
  for (let i = 0; i < 50 && (await ghState()).pending; i++) await sleep(100)
  assert.deepEqual([(await ghState()).pending, (await ghState()).syncing], [0, false])
  assert.ok(gh.look.issue('Pricing table v2'))
  // (Other changes from a moment ago may go too, each by itself: never the whole board.)
  assert.ok(!gh.calls.slice(before).includes('Items'), gh.calls.slice(before).join())
  assert.deepEqual(gh.calls.slice(before).filter(c => !['Project', 'Item'].includes(c)), ['UpdateIssue'])
  assert.equal((await get('c/default/boards')).result.boards.find(x => x.id === board.id).github.error, null)

  // A column renamed here: renamed there, every card where it was.
  const statuses = b.statuses.map(({ id, name, category }) => ({ id, name: name === 'In Progress' ? 'Doing' : name, category }))
  assert.ok((await post('boards/update', { id: board.id, statuses })).ok)
  await sync(board.id)
  assert.ok(gh.look.options().includes('Doing') && !gh.look.options().includes('In Progress'))
  assert.equal(gh.look.statusOf(iPricing.id), 'Doing')
  assert.equal(gh.look.statusOf(login.id), 'Done')
  // A column added there: a column here.
  gh.person.addOption('Blocked')
  b = await sync(board.id)
  assert.equal(b.statuses.at(-1).name, 'Blocked')

  // Deleted here: out of the project, closed as not planned.
  assert.ok((await post('tasks/delete', { id: tLogin.seq })).ok)
  await sync(board.id)
  assert.equal(gh.look.inProject(login.id), false)
  assert.equal(gh.look.issue('Login page').stateReason, 'NOT_PLANNED')

  // Restored here: in the project again, as it was here (done: closed as completed).
  assert.ok((await post('tasks/restore', { id: tLogin.seq })).ok)
  await sync(board.id) // (into the project)
  await sync(board.id) // (its fields there)
  assert.deepEqual([gh.look.inProject(login.id), gh.look.issue('Login page').stateReason, gh.look.statusOf(login.id)], [true, 'COMPLETED', 'Done'])

  // Taken out of the project there: in the trash here; its subtask stays, with no parent here and its parent there.
  gh.person.removeFromProject(iPricing.id)
  before = gh.calls.length
  await sync(board.id)
  assert.equal(await byTitle(board.id, 'Pricing table v2'), undefined)
  const trashed = (await get(`c/default/boards/trash?board=${board.id}`)).result.find(t => t.seq === pricing.seq)
  assert.deepEqual(trashed.deleted_by, { kind: 'github', id: 'github', name: 'GitHub' })
  assert.equal((await task(sub.seq)).parent, null)
  await sync(board.id)
  assert.equal(gh.look.issue('Pricing: annual plan').parent, iPricing.id)
  assert.ok(!gh.calls.slice(before).some(c => ['RemoveSubIssue', 'CloseIssue', 'CreateIssue'].includes(c)), gh.calls.slice(before).join())
  // Put back in the project there: back here.
  gh.person.addToProject(iPricing.id)
  await sync(board.id)
  assert.ok(await byTitle(board.id, 'Pricing table v2'))

  // Its issue deleted on GitHub: in the trash here. Restored here: what was said here wins, as a new issue.
  const doomed = (await post('tasks/create', { board: board.id, title: 'Doomed', parent: pricing.seq })).result
  await sync(board.id)
  const gone = gh.look.issue('Doomed')
  assert.ok(gone && gh.look.inProject(gone.id))
  gh.person.deleteIssue(gone.id)
  await sync(board.id)
  assert.equal(await byTitle(board.id, 'Doomed'), undefined)
  assert.ok((await post('tasks/restore', { id: doomed.seq })).ok)
  await sync(board.id)
  await sync(board.id)
  await sleep(3500) // (and the push of the restore, by itself)
  await sync(board.id)
  assert.ok(await byTitle(board.id, 'Doomed'))
  const reborn = gh.look.issue('Doomed')
  assert.ok(reborn.id !== gone.id && gh.look.inProject(reborn.id))
  assert.equal(reborn.parent, iPricing.id)
  assert.equal(gh.look.issues().filter(i => i.title === 'Doomed').length, 1)

  // Disconnected: no more GitHub, the tasks stay.
  b = (await post('boards/github-off', { board: board.id })).result
  assert.equal(b.github, null)
  assert.ok(await byTitle(board.id, 'Pricing table v2'))
})

test('github: a task\'s people are the issue\'s assignees, by the GitHub user in their profile', async () => {
  // A person says who they are on GitHub, in their profile.
  const cookie = await server.ownerCookie()
  const profile = async github => (await fetch(`${URL_}/auth/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: URL_, Cookie: cookie }, body: JSON.stringify({ github }) })).json()
  assert.match((await profile('not a login!')).description, /not a GitHub user/)
  assert.equal((await profile('@Ana-Dev')).result.user.github, 'Ana-Dev')
  gh.person.addUser('ana-dev')
  const ana = (await get('c/default/boards')).result.members.find(m => m.github === 'Ana-Dev')
  assert.ok(ana)

  const board = (await post('boards/create', { name: 'People' })).result
  assert.ok((await post('boards/github', { board: board.id, url: 'https://github.com/orgs/acme/projects/3', repo: 'acme/web', token: gh.token })).ok)
  await sync(board.id)

  // Hers here: hers there.
  const footer = (await post('tasks/create', { board: board.id, title: 'Footer', people: [ana.id] })).result
  assert.deepEqual(footer.people.map(p => p.id), [ana.id])
  await sync(board.id)
  const issue = gh.look.issue('Footer')
  assert.deepEqual(gh.look.assigneesOf(issue.id), ['ana-dev'])
  // There, octocat instead of her: here, nobody (octocat isn't one of ours).
  gh.person.assign(issue.id, ['octocat'])
  await sync(board.id)
  assert.deepEqual((await task(footer.seq)).people, [])
  // Hers again here: there too, and octocat stays.
  await post('tasks/update', { id: footer.seq, people: [ana.id] })
  await sync(board.id)
  assert.deepEqual(gh.look.assigneesOf(issue.id).sort(), ['ana-dev', 'octocat'])

  // Someone GitHub can't assign in the repository: still theirs here, and not asked again.
  gh.person.addUser('outsider', { collaborator: false })
  assert.ok((await profile('outsider')).ok)
  const header = (await post('tasks/create', { board: board.id, title: 'Header', people: [ana.id] })).result
  await sync(board.id)
  assert.deepEqual(gh.look.assigneesOf(gh.look.issue('Header').id), [])
  await sleep(3500)
  const before = gh.calls.length
  await sync(board.id)
  assert.deepEqual((await task(header.seq)).people.map(p => p.id), [ana.id])
  assert.ok(!gh.calls.slice(before).includes('AddAssignees'), gh.calls.slice(before).join())
})
