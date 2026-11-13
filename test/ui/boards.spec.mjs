// Task boards in the dashboard: a board for a team, tasks handed out without
// telling anyone until the person says so, moved, commented, as a list, and on
// a phone. (Selectors by data attributes and names, not by layout.)

import { test as base, expect } from '@playwright/test'
import { SERVER_TOKEN, startServer, startSession } from './harness.mjs'
import { startFakeGithub } from '../fake-github.mjs'

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    page.on('console', m => { if (m.type() === 'error' && !/status of 40[19]/.test(m.text())) errors.push(m.text()) })
    await use(page)
    expect(errors).toEqual([])
  },
})

let server, gh
const shot = name => (process.env.SHOTS ? { path: `${process.env.SHOTS}/${name}.png` } : undefined)

test.beforeAll(async () => {
  gh = await startFakeGithub()
  server = await startServer({ env: { SQUADRA_GITHUB_API: gh.url } })
  await startSession(server, 'lead', 'coordinator')
  await startSession(server, 'writer', 'worker', 'lead')
  await startSession(server, 'editor', 'worker', 'lead')
  await startSession(server, 'other', 'coordinator')
})
test.afterAll(async () => { await server?.stop(); await gh?.stop() })

async function signIn(page, hash = '') {
  const [name, value] = (await server.ownerCookie()).split('=')
  await page.context().addCookies([{ name, value, url: server.url }])
  await page.goto(`${server.url}/?company=default${hash}`)
  await expect(page.locator('#app')).toBeVisible()
}
// What the board told a coordinator (the server's messages to it).
async function boardNotices(name) {
  const r = await fetch(`${server.url}/api/messages?session=${name}`, { headers: { Authorization: `Bearer ${SERVER_TOKEN}` } }).then(x => x.json())
  return r.result.filter(m => m.from === 'squadra:board' || m.from_name === 'squadra:board' || m.from?.id === 'squadra:board').map(m => m.text)
}

test('a board: handed out quietly, the team told when the person says so, moved, commented', async ({ page }) => {
  await signIn(page, '#/boards')
  await expect(page.locator('#boards .empty')).toContainText('No boards yet')
  shot('boards-empty') && await page.screenshot(shot('boards-empty'))

  // A board for one team.
  await page.locator('#topRight [data-newboard]').click()
  const nb = page.locator('form[data-bnew]')
  await nb.locator('[name=name]').fill('Launch')
  await nb.locator('[name=description]').fill('Everything for the 0.0.11 launch')
  await nb.locator('[name=team][value=lead]').check()
  await nb.locator('[type=submit]').click()
  await expect(page).toHaveURL(/#\/b\/\d+$/)
  await expect(page.locator('.bd-col')).toHaveCount(6)
  await expect(page.locator('.bd-col h2').nth(1)).toHaveText('To do')

  // A task in "To do", given to a worker: asked whether to tell its coordinator, and "Not yet" is the default.
  await page.locator('.bd-col[data-cat=unstarted] [data-newtask]').click()
  const f = page.locator('form[data-bform]')
  await f.locator('[name=title]').fill('Write the launch post')
  await f.locator('[name=assignee]').selectOption('s:writer')
  await f.locator('[name=priority]').selectOption('3')
  await f.locator('[type=submit]').click()
  await expect(page.locator('.modal [data-notyet]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/b\/\d+\/SQ-1$/)
  const c1 = page.locator('.bd-card', { hasText: 'Write the launch post' })
  await expect(c1.locator('.bd-pending')).toHaveText('Not told')
  // A second one, for the coordinator itself, also not yet.
  await page.locator('.bd-col[data-cat=unstarted] [data-newtask]').click()
  await f.locator('[name=title]').fill('Record the demo')
  await f.locator('[name=assignee]').selectOption('s:lead')
  await f.locator('[type=submit]').click()
  await page.locator('.modal [data-notyet]').click()
  await expect(page.locator('.bd-card .bd-pending')).toHaveCount(2)
  expect(await boardNotices('lead')).toEqual([])
  shot('board-columns') && await page.screenshot(shot('board-columns'))

  // Notify the teams: one message with both.
  await page.locator('#topRight [data-bnotify]').click()
  await expect(page.locator('.modal .bd-notify-list')).toContainText('SQ-1')
  await page.locator('.modal [data-ok]').click()
  await expect(page.locator('.bd-card .bd-pending')).toHaveCount(0)
  await expect.poll(() => boardNotices('lead')).toHaveLength(1)
  const [notice] = await boardNotices('lead')
  expect(notice).toMatch(/SQ-1 «Write the launch post» → your worker writer/)
  expect(notice).toMatch(/SQ-2 «Record the demo» → you/)
  await expect(page.locator('#topRight [data-bnotify]')).toHaveCount(0)

  // Moved to "In progress" by dragging it (the task closed, the board whole).
  await page.locator('.bd-panel-h a.icon-btn').click()
  await expect(page.locator('.bd-panel')).toBeHidden()
  await c1.dragTo(page.locator('.bd-col[data-cat=started] .bd-col-body'))
  await expect(page.locator('.bd-col[data-cat=started] .bd-card')).toContainText('Write the launch post')

  // A comment, told to the coordinator only when asked.
  await page.locator('.bd-card', { hasText: 'Write the launch post' }).locator('.bd-title').click()
  const cf = page.locator('form[data-bcomment]')
  await cf.locator('[name=text]').fill('Keep it under 200 words')
  await cf.locator('[name=notify]').check()
  await cf.locator('[type=submit]').click()
  await expect(page.locator('.bd-com')).toContainText('Keep it under 200 words')
  await expect(page.locator('.bd-com .tag')).toHaveText('told lead')
  await expect.poll(() => boardNotices('lead')).toHaveLength(2)
  shot('board-task') && await page.screenshot(shot('board-task'))

  // Taken back from the worker: its coordinator hears at once.
  await page.locator('form[data-bform] [name=assignee]').selectOption('')
  await page.locator('form[data-bform] [type=submit]').click()
  await expect.poll(async () => (await boardNotices('lead')).at(-1)).toMatch(/no longer your team's/)

  // As a list, filtered.
  await page.locator('#topTabs [data-bmode=list]').click()
  await expect(page.locator('.bd-table tbody tr')).toHaveCount(2)
  await page.locator('[data-bf=text]').fill('demo')
  await expect(page.locator('.bd-table tbody tr')).toHaveCount(1)
  await page.locator('[data-bf=text]').fill('')
  shot('board-list') && await page.screenshot(shot('board-list'))
  await page.locator('#topTabs [data-bmode=cols]').click()

  // The settings: a label, used on a task.
  await page.locator('#topRight [data-bsettings]').click()
  const sf = page.locator('form[data-bset]')
  await sf.locator('[data-list=labels] [data-add]').click()
  await sf.locator('[data-list=labels] .bd-row input').fill('docs')
  await sf.locator('[data-list=labels] .bd-row select').selectOption('green')
  shot('board-settings') && await page.screenshot(shot('board-settings'))
  await sf.locator('[type=submit]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await page.locator('.bd-card', { hasText: 'Record the demo' }).locator('.bd-title').click()
  await page.locator('form[data-bform] .bd-lpick', { hasText: 'docs' }).locator('input').check()
  await page.locator('form[data-bform] [type=submit]').click()
  await expect(page.locator('.bd-card', { hasText: 'Record the demo' }).locator('.lbl[data-color=green]')).toHaveText('docs')
})

test('on a phone: one column at a time, the task over the whole screen, nothing wider than the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, '#/boards')
  await page.locator('.bl-card').first().click()
  await expect(page.locator('.bd-col').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  shot('board-phone') && await page.screenshot(shot('board-phone'))
  await page.locator('.bd-card .bd-title').first().click()
  await expect(page.locator('.bd-panel')).toBeVisible()
  const box = await page.locator('.bd-panel').boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(389)
  shot('board-phone-task') && await page.screenshot(shot('board-phone-task'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('a column as a step: who handles it, where next; a task moved there is theirs, asked before telling', async ({ page }) => {
  await signIn(page, '#/boards')
  await page.locator('.bl-card', { hasText: 'Launch' }).click()
  await page.locator('.bd-col[data-cat=review] [data-colflow]').click()
  const f = page.locator('form[data-bflow]')
  await f.locator('[name=handler]').selectOption('s:editor')
  await f.locator('[name=instructions]').fill('Check the post against the brief')
  await f.locator('[name=next]').selectOption({ label: 'Done' })
  await f.locator('[name=back]').selectOption({ label: 'In progress' })
  shot('board-step') && await page.screenshot(shot('board-step'))
  await f.locator('[type=submit]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(page.locator('.bd-col[data-cat=review] .bd-step')).toHaveText('→ editor · then Done')

  // Moved there by a person: the step shows its handler as who will have it, and asks first ("Not yet" the default).
  await page.locator('.bd-card', { hasText: 'Record the demo' }).locator('.bd-title').click()
  const tf = page.locator('form[data-bform]')
  await tf.locator('[name=status]').selectOption({ label: 'In review' })
  await expect(tf.locator('[name=assignee]')).toHaveValue('s:editor')
  await expect(tf.locator('.bd-step')).toHaveText('→ editor · then Done')
  await tf.locator('[type=submit]').click()
  await expect(page.locator('.modal [data-notyet]')).toBeFocused()
  await expect(page.locator('.modal')).toContainText('Record the demo')
  await page.keyboard.press('Enter')
  await expect(page.locator('.bd-col[data-cat=review] .bd-card', { hasText: 'Record the demo' }).locator('.bd-who')).toHaveText('editor')
  await expect(page.locator('.bd-col[data-cat=review] .bd-card', { hasText: 'Record the demo' }).locator('.bd-pending')).toHaveText('Not told')
  await expect(tf.locator('.bd-step')).toHaveText('→ editor · then Done')
})

test('subtasks: added from the task, shown on its card and listed in it, each a task of its own', async ({ page }) => {
  await signIn(page, '#/boards')
  await page.locator('.bl-card', { hasText: 'Launch' }).click()
  await page.locator('.bd-card', { hasText: 'Record the demo' }).locator('.bd-title').click()
  const parentId = (await page.locator('.bd-panel-h .bd-id').textContent()).trim()
  await page.locator('[data-addsub]').click()
  const f = page.locator('form[data-bform]')
  await expect(f.locator('[name=parent] option:checked')).toContainText(parentId)
  await f.locator('[name=title]').fill('Write the script')
  await f.locator('[name=assignee]').selectOption('') // (nobody: nothing to ask)
  await f.locator('[type=submit]').click()
  await expect(page.locator('.bd-up')).toContainText(parentId)

  // The parent's card counts it; the parent lists it, and it opens from there.
  const parentCard = page.locator('.bd-card', { hasText: 'Record the demo' })
  await expect(parentCard.locator('.bd-subs-n')).toHaveText('☑ 0/1')
  await expect(page.locator('.bd-card', { hasText: 'Write the script' }).locator('.bd-parent')).toHaveText(`↑ ${parentId}`)
  await page.locator('.bd-up').click()
  await expect(page.locator('.bd-subs li')).toHaveCount(1)
  shot('board-subtasks') && await page.screenshot(shot('board-subtasks'))
  await page.locator('.bd-subs li .bd-title').click()
  await expect(page.locator('form[data-bform] [name=title]')).toHaveValue('Write the script')
  await page.locator('form[data-bform] [name=status]').selectOption({ label: 'Done' })
  await page.locator('form[data-bform] [type=submit]').click()
  await expect(parentCard.locator('.bd-subs-n')).toHaveText('☑ 1/1')
})

test('a task\'s agent and people: an agent who works on it, and people besides, shown on its card', async ({ page }) => {
  await signIn(page, '#/boards')
  await page.locator('.bl-card', { hasText: 'Launch' }).click()
  await page.locator('.bd-card', { hasText: 'Write the launch post' }).locator('.bd-title').click()
  const f = page.locator('form[data-bform]')
  // The agent is chosen among the board's agents only; people are ticked.
  await expect(f.locator('[name=assignee] option[value^="u:"]')).toHaveCount(0)
  await f.locator('[name=person]').first().check()
  await f.locator('[type=submit]').click()
  const card = page.locator('.bd-card', { hasText: 'Write the launch post' })
  await expect(card.locator('.bd-ppl-tag')).toHaveAttribute('title', 'The Owner')
  await expect(card.locator('.bd-av')).toHaveText('TO')
  // Filtered by that person: there; by nobody: not.
  await page.locator('[data-bf=who]').selectOption({ label: 'The Owner' })
  await expect(card).toBeVisible()
  await page.locator('[data-bf=who]').selectOption('-')
  await expect(card).toHaveCount(0)
  await page.locator('[data-bf=who]').selectOption('')
})

test('the trash: a task deleted with its subtasks, and brought back with them', async ({ page }) => {
  await signIn(page, '#/boards')
  await page.locator('.bl-card', { hasText: 'Launch' }).click()
  const parentCard = page.locator('.bd-card', { hasText: 'Record the demo' })
  await expect(parentCard.locator('.bd-subs-n')).toBeVisible() // (it has its subtask, from the test before)
  await parentCard.locator('.bd-title').click()
  await page.locator('[data-bdelete]').click()
  // Asked about its subtasks: not ticked, unless the person ticks it.
  const option = page.locator('.modal [data-option]')
  await expect(option).not.toBeChecked()
  await option.check()
  await page.locator('.modal .btn.danger').click()
  await expect(parentCard).toHaveCount(0)
  await expect(page.locator('.bd-card', { hasText: 'Write the script' })).toHaveCount(0)

  // From the trash: back, with its subtask (ticked: it is asked).
  await page.locator('[data-btrash]').click()
  const row = page.locator('.bd-trash li', { hasText: 'Record the demo' })
  await expect(row).toContainText(/subtask/)
  shot('board-trash') && await page.screenshot(shot('board-trash'))
  await row.locator('[data-restore]').click()
  await expect(page.locator('.modal [data-option]')).toBeChecked()
  await page.locator('.modal .btn.ok').last().click()
  await expect(page.locator('.bd-trash')).toHaveCount(0)
  await expect(page.locator('.modal .dim-note')).toBeVisible()
  await page.locator('.modal [data-cancel]').click()
  await expect(parentCard.locator('.bd-subs-n')).toHaveText('☑ 1/1')
  await expect(page.locator('[data-btrash]')).toHaveCount(0)
})

test('GitHub: a board connected from its settings, its project\'s cards as tasks, each with its issue', async ({ page }) => {
  const footer = gh.person.addIssue({ title: 'From GitHub: fix the footer', status: 'Todo' })
  const note = gh.person.comment(footer.id, 'Only on mobile')
  await signIn(page, '#/boards')
  await page.locator('[data-newboard]').first().click()
  await page.locator('form[data-bnew] [name=name]').fill('Synced')
  await page.locator('form[data-bnew] [type=submit]').click()
  await expect(page.locator('.bd-cols')).toBeVisible()
  await page.locator('[data-bsettings]').click()
  await page.locator('[data-ghconnect]').click()
  const f = page.locator('form[data-bgh]')
  await f.locator('[name=url]').fill('https://github.com/orgs/acme/projects/3')
  await f.locator('[name=repo]').fill('acme/web')
  await f.locator('[name=token]').fill(gh.token)
  shot('board-github') && await page.screenshot(shot('board-github'))
  await f.locator('[type=submit]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  // The project's columns and card, here; the header says how it went.
  await expect(page.locator('.bd-col h2').first()).toHaveText('Todo')
  await expect(page.locator('.bd-card', { hasText: 'fix the footer' })).toBeVisible()
  // The header says it is synced, when (on hover), and syncs now on a click.
  const ghState = page.locator('[data-ghstat]')
  await expect(ghState).toContainText(/GitHub · synced/)
  await expect(ghState).toHaveAttribute('title', /^Last sync: today at \d\d:\d\d$/)
  await ghState.locator('[data-ghnow]').click()
  await expect(ghState).toContainText(/synced/)
  await expect(ghState.locator('[data-ghnow]')).toBeEnabled()
  await page.locator('.bd-card', { hasText: 'fix the footer' }).locator('.bd-title').click()
  await expect(page.locator('.bd-panel-h .bd-gh')).toHaveText(/^#\d+ on GitHub$/)
  // (Its comments come from GitHub once it is opened.)
  await expect(page.locator('.bd-comsec')).toContainText('Only on mobile')
  // Edited there: edited here, and it says so.
  gh.person.editComment(footer.id, note.id, 'Only on mobile, in Safari')
  await ghState.locator('[data-ghnow]').click()
  await expect(page.locator('.bd-com', { hasText: 'Only on mobile, in Safari' }).locator('.bd-edited')).toHaveText('edited')
  // A pull request naming it by its branch: in it and on its card, approved.
  const id = (await page.locator('.bd-panel-h .bd-id').textContent()).trim()
  const pr = gh.person.openPr({ title: 'Footer on mobile', branch: `${id.toLowerCase()}-footer` })
  gh.person.editPr(pr, { review: 'APPROVED' })
  await ghState.locator('[data-ghnow]').click()
  const prRow = page.locator('.bd-prs li')
  await expect(prRow).toContainText(`#${pr.number} Footer on mobile`)
  await expect(prRow).toContainText('Approved')
  await expect(prRow).toHaveAttribute('data-pr', 'open')
  const footerCard = page.locator('.bd-card', { hasText: 'fix the footer' })
  await expect(footerCard.locator('.bd-pr-tag')).toHaveText('1')
  shot('board-prs') && await page.screenshot(shot('board-prs'))
  // Merged: the task goes to Done by itself, and its history says why.
  gh.person.mergePr(pr)
  await ghState.locator('[data-ghnow]').click()
  await expect(prRow).toHaveAttribute('data-pr', 'merged')
  await expect(page.locator('.bd-col', { has: page.locator('h2', { hasText: 'Done' }) }).locator('.bd-card', { hasText: 'fix the footer' })).toBeVisible()
  await page.locator('.bd-hist summary').click()
  await expect(page.locator('.bd-hist')).toContainText(`merged pull request #${pr.number}`)
  // The settings show the connection (and whether a merge moves tasks), and it can be undone.
  await page.locator('[data-bsettings]').click()
  await expect(page.locator('.bd-ghstate')).toContainText('Web launch')
  await expect(page.locator('[data-ghmerge]')).toBeChecked()
  await page.locator('[data-ghmerge]').uncheck()
  await expect(page.locator('[data-ghmerge]')).toBeEnabled()
  expect((await (await fetch(`${server.url}/api/c/default/boards`, { headers: { Authorization: `Bearer ${SERVER_TOKEN}` } })).json()).result.boards.find(x => x.name === 'Synced').github.merge_moves).toBe(false)
  await page.locator('[data-ghoff]').click()
  await page.locator('.modal .btn.danger').click()
  await expect(page.locator('[data-ghstat]')).toHaveCount(0)
})
