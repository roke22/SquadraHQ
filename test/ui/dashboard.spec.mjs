// The dashboard's main paths, in a browser. Selectors use what the page gives
// each thing (ids, data attributes, session names), not its layout: moving code
// around must not change these tests.

import { test as base, expect } from '@playwright/test'
import { OWNER, SERVER_TOKEN, startMachine, startServer, startSession } from './harness.mjs'
import { totpCode, totpStep } from '../../server/accounts/totp.js'

// Any error in the page fails the test, a script the Content-Security-Policy
// blocked included. (A wrong token is answered with a 401, which the browser
// reports too.)
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    page.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()) })
    await use(page)
    // (A test that causes one on purpose says which, in page.expectedErrors.)
    expect(errors.filter(e => !(page.expectedErrors ?? []).some(re => re.test(e)))).toEqual([])
  },
})

let server, coord, machine

test.beforeAll(async () => {
  server = await startServer()
  coord = await startSession(server, 'coord', 'coordinator')
  const worker = await startSession(server, 'worker1', 'worker', 'coord')
  await coord.send(worker.name, 'first task for the worker')
  machine = await startMachine(server, 'machine1', { id: 'worker1', role: 'worker', coordinator: 'coord' })
})

test.afterAll(async () => { await server?.stop() })

async function signIn(page, hash = '') {
  const [name, value] = (await server.ownerCookie()).split('=')
  await page.context().addCookies([{ name, value, url: server.url }])
  await page.goto(`${server.url}/?company=default${hash}`)
  await expect(page.locator('#app')).toBeVisible()
}

test('the first owner: made with the token, with codes, and it stays until signing out', async ({ page }) => {
  const own = await startServer({ tokenApi: false })
  try {
    await page.goto(own.url)
    const form = page.locator('#loginForm')
    await form.locator('[name=token]').fill('not-the-token')
    await form.locator('[name=name]').fill(OWNER.name)
    await form.locator('[name=email]').fill(OWNER.email)
    await form.locator('[name=password]').fill(OWNER.password)
    await page.locator('#loginBtn').click()
    await expect(page.locator('#loginErr')).not.toBeEmpty()
    await expect(page.locator('#app')).toBeHidden()

    await form.locator('[name=token]').fill(SERVER_TOKEN)
    await page.locator('#loginBtn').click()
    const secret = await page.locator('.secret code').textContent()
    await expect(page.locator('#loginForm svg.qr')).toBeVisible()
    await form.locator('[name=code]').fill(totpCode(secret, totpStep()))
    await page.locator('#loginBtn').click()
    await expect(page.locator('.codes')).toContainText(/[0-9a-f]{20}/)
    await page.locator('#loginBtn').click()
    await expect(page.locator('#app')).toBeVisible()
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(SERVER_TOKEN)

    await page.reload()
    await expect(page.locator('#app')).toBeVisible()
    expect(await page.evaluate(() => document.cookie)).toBe('') // (not for the page to read)

    await page.locator('#settingsBtn').click()
    await page.locator('#settings [data-logout]').click()
    await expect(page.locator('#login')).toBeVisible()
    await page.reload()
    await expect(page.locator('#loginForm [name=email]')).toBeVisible()

    // Signing in again: password, then the next code.
    await form.locator('[name=email]').fill(OWNER.email)
    await form.locator('[name=password]').fill('the wrong password')
    await page.locator('#loginBtn').click()
    await expect(page.locator('#loginErr')).toHaveText('wrong email or password')
    await form.locator('[name=password]').fill(OWNER.password)
    await page.locator('#loginBtn').click()
    await form.locator('[name=code]').fill(totpCode(secret, totpStep() + 1))
    await page.locator('#loginBtn').click()
    await expect(page.locator('#app')).toBeVisible()
  } finally { await own.stop() }
})

test('companies: two show apart, each with its own sessions; the selector changes between them', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('#companySelect')).toBeHidden()
  const other = await server.call('admin/createCompany', { name: 'Otra Compañía' })
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=companies]').click()
  await expect(page.locator('#settings')).toContainText('Otra Compañía')
  await page.locator(`[data-join="${other.id}"]`).click()
  await expect(page.locator(`#settings a[href="?company=${other.id}"]`)).toBeVisible()
  await page.goto(`${server.url}/?company=${other.id}`)
  await expect(page.locator('#companySelect')).toBeVisible()
  await expect(page.locator('#companySelect')).toHaveValue(other.id)
  await expect(page.locator('#nav')).toContainText('No teams yet')
  // A company this user isn't in: the page loads again for one they are in, on this site.
  await page.goto(`${server.url}/?company=zzz`)
  await expect(page).toHaveURL(new RegExp(`^${server.url}/\\?company=(default|${other.id})`))
  await page.goto(`${server.url}/?company=${other.id}`)
  await expect(page.locator('#companySelect')).toHaveValue(other.id)
  await page.locator('#companySelect').selectOption('default')
  await expect(page.locator('#nav')).toContainText('worker1')
  await expect(page).toHaveURL(/company=default/)
})

test('an invitation: a link of one use brings someone in, with only their role', async ({ page, browser }) => {
  await signIn(page)
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=members]').click()
  const invite = page.locator('[data-invite]')
  await invite.locator('[name=email]').fill('ana@example.com')
  await invite.locator('[name=role]').selectOption('observer')
  await invite.locator('button').click()
  const link = await page.locator('[data-link] .cmd').textContent()
  expect(link).toContain('/#/invite/')

  const ctx = await browser.newContext()
  const guest = await ctx.newPage()
  await guest.goto(link)
  await expect(guest.locator('#loginIntro')).toContainText('ana@example.com')
  await guest.locator('[name=name]').fill('Ana')
  await guest.locator('[name=password]').fill('another long password')
  await guest.locator('#loginBtn').click()
  await expect(guest.locator('#app')).toBeVisible()
  await expect(guest).not.toHaveURL(/invite/)
  // An observer: no adding machines, and the chat rather than a terminal.
  await expect(guest.locator('#addHostBtn')).toBeHidden()
  await expect(guest.locator('#nav')).toContainText('coord')
  // What it can't do isn't offered: anywhere it goes, and nothing asks the server for it.
  await guest.goto(`${server.url}/#/q/coord`)
  await expect(guest.locator('#team .tq-members')).toContainText('worker1')
  await expect(guest.locator('[data-describe], [data-links], [data-savetpl], [data-addworker]')).toHaveCount(0)
  await guest.goto(`${server.url}/#/q/coord/live`)
  await expect(guest.locator('#colsSeg')).toBeVisible()
  await expect(guest.locator('[data-addworker], [data-links], [data-savetpl], #modeSeg')).toHaveCount(0)
  await guest.goto(`${server.url}/#/s/worker1/chat`)
  await expect(guest.locator('#topRight [data-menu]')).toBeVisible()
  await expect(guest.locator('[data-act]')).toHaveCount(0)
  await guest.goto(`${server.url}/#/hosts`)
  await expect(guest.locator('.host').first()).toBeVisible()
  await expect(guest.locator('[data-hact], [data-hmenu]')).toHaveCount(0)
  await guest.goto(`${server.url}/#/org`)
  await expect(guest.locator('.org-card').first()).toBeVisible()
  await expect(guest.locator('[data-orgact], [data-orghandle]')).toHaveCount(0)
  await guest.locator('#settingsBtn').click()
  await expect(guest.locator('[data-tab]')).toHaveText(['Profile and password', 'Language, theme and notices'])
  await ctx.close()
})

test('the shell: Ctrl+K goes anywhere, and the settings open over everything and close with Esc', async ({ page }) => {
  await signIn(page)
  // The inbox is home.
  await expect(page.locator('#nav a[href="#/"]')).toHaveAttribute('aria-current', 'page')
  // Ctrl+K: a few letters, Enter, and you are there.
  await page.keyboard.press('Control+k')
  const input = page.locator('#palInput')
  await expect(input).toBeFocused()
  await input.fill('work')
  await expect(page.locator('#palList [role=option]').first()).toContainText('worker1')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/s\/worker1/)
  await expect(page.locator('#palette')).toBeHidden()
  // Esc closes it and gives the focus back.
  await page.locator('#searchBtn').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('#palette')).toBeHidden()
  await expect(page.locator('#searchBtn')).toBeFocused()
  // Settings: over the dashboard, which can't be reached meanwhile; the theme stays.
  await page.locator('#settingsBtn').click()
  await expect(page.locator('#settings [role=dialog]')).toBeVisible()
  await expect(page.locator('#app')).toHaveAttribute('inert', '')
  await page.locator('[data-tab=appearance]').click()
  await page.locator('[data-theme=dark]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings')).toBeHidden()
  await expect(page.locator('#settingsBtn')).toBeFocused()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.evaluate(() => localStorage.removeItem('pishaTheme'))
})

test('the shell on a phone: no sidebar, the places and the settings at the bottom, and back as an arrow', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await signIn(page)
  await expect(page.locator('#rail')).toBeHidden()
  await expect(page.locator('#menuBtn')).toHaveCount(0)
  // One of the main places: no back.
  await expect(page.locator('#backBtn')).toBeHidden()
  await page.locator('#tabbar a[href="#/teams"]').click()
  await expect(page).toHaveURL(/#\/teams/)
  await page.locator('#teams a[href="#/s/worker1"]').first().click()
  await expect(page).toHaveURL(/#\/s\/worker1/)
  // The arrow alone, named for where it goes.
  const back = page.locator('#backBtn')
  await expect(back).toBeVisible()
  await expect(back).toHaveAttribute('aria-label', 'Back to Teams')
  await expect(back.locator('.head-back-to')).toBeHidden()
  await back.click()
  await expect(page).toHaveURL(/#\/teams$/)
  // The settings, from the bar.
  await page.locator('#tabbar [data-settings]').click()
  await expect(page.locator('#settings [role=dialog]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await ctx.close()
})

test('back: where the user came from, skipping the tabs of one place, and one level up with nowhere to go back to', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'worker3', role: 'worker', coordinator: 'coord' } })
  await signIn(page)
  const back = page.locator('#backBtn')
  await expect(back).toBeHidden()
  // From the inbox to a session, and between its chat and its terminal.
  await page.evaluate(() => { location.hash = '#/s/worker3/chat' })
  await expect(back).toHaveAttribute('aria-label', 'Back to Inbox')
  await expect(back.locator('.head-back-to')).toHaveText('Inbox')
  await page.locator('#topTabs a', { hasText: 'Terminal' }).click()
  await expect(page).toHaveURL(/#\/s\/worker3$/)
  await page.locator('#topTabs a', { hasText: 'Conversation' }).click()
  await expect(page).toHaveURL(/#\/s\/worker3\/chat$/)
  // One press: the inbox, not the other tab.
  await back.click()
  await expect(page).toHaveURL(/#\/$|#\/inbox$|\/\?company=default$/)
  await expect(back).toBeHidden()
  // And the browser's own back agrees: the step it skipped isn't there.
  await page.goForward()
  await expect(page).toHaveURL(/#\/s\/worker3\/chat$/)
  // Opened on its own (a link, a notification): up to its team, then to the teams.
  await page.goto(`${server.url}/?company=default#/s/worker1/chat`)
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(back).toHaveAttribute('aria-label', 'Back to coord')
  await back.click()
  await expect(page).toHaveURL(/#\/q\/coord$/)
  await expect(back).toHaveAttribute('aria-label', 'Back to Teams')
  // Cancel goes back where it was too.
  await page.evaluate(() => { location.hash = '#/new' })
  await page.locator('#topRight [data-back]').click()
  await expect(page).toHaveURL(/#\/q\/coord$/)
})

test('a new team: one page, and it opens its coordinator and workers on the machine, named and described', async ({ page }) => {
  await signIn(page, '#/teams')
  await page.locator('#topRight [data-newteam]').click()
  await expect(page).toHaveURL(/#\/new$/)
  const form = page.locator('#newteam form')
  await form.locator('[name=title]').fill('Payments')
  await expect(form.locator('[data-name="0"]')).toHaveValue('coord-payments')
  await form.locator('[name=goal]').fill('Take card payments')
  await form.locator('[data-name="1"]').fill('pay-api')
  await form.locator('[data-remove="1"]').click()
  await expect(form.locator('.nt-member')).toHaveCount(2)
  // A subfolder lists its own personas once it is typed, with nothing else changed.
  await expect(form.locator('[data-persona="0"] option')).toHaveCount(1)
  await form.locator('[name=sub]').fill('payments')
  await form.locator('[name=sub]').blur()
  await form.locator('[data-persona="0"]').selectOption('skill:project:payments-lead')
  await form.locator('[data-launch]').click()
  await expect(page).toHaveURL(/#\/q\/coord-payments$/)
  expect([...machine.identities.keys()]).toEqual(expect.arrayContaining(['coord-payments', 'pay-api']))
  expect(machine.opened.find(s => s.name === 'coord-payments')).toMatchObject({ folder: '/srv/squad/payments', persona: 'skill:project:payments-lead' })
  await expect(page.locator('#topTitle')).toHaveText('Payments')
  // Before they first log in, they are shown as what they were opened as, in their team.
  await expect(page.locator('#team .tq-members li').first().locator('.role')).toHaveClass(/coord/)
  await expect(page.locator('#team .tq-members')).toContainText('pay-api')
  await expect(page.locator('#nav .rail-sess.coord', { hasText: 'coord-payments' })).toBeVisible()
})

test('a team saved as a template: it says so, not that something failed', async ({ page }) => {
  await signIn(page, '#/q/coord-payments')
  await page.locator('[data-savetpl="coord-payments"]').click()
  await page.locator('.modal [name=tname]').fill('payments-team')
  await page.locator('.modal [data-ok]').click()
  await expect(page.locator('.modal h3')).toHaveText('Template saved')
  await expect(page.locator('.modal p')).toContainText('payments-team')
  // Only to read: one button, that closes it.
  await expect(page.locator('.modal .actions .btn')).toHaveCount(1)
  await page.locator('.modal [data-ok]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('the sessions: they are listed with their squad', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('#nav')).toContainText('coord')
  // Teams: a card per team, its coordinator first and its workers under it.
  await page.goto(`${server.url}/?company=default#/teams`)
  const team = page.locator('#teams .tm-card').filter({ hasText: 'coord' }).first()
  await expect(team.locator('.tm-person').first()).toContainText('coord')
  await expect(team.locator('.tm-person.sub', { hasText: 'worker1' })).toHaveCount(1)
  await expect(page.locator('#topTabs a[aria-current=page]')).toHaveText('List')
  // Its whole header leads to the team, not just its name.
  const head = team.locator('.tm-h')
  const box = await head.boundingBox()
  await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2)
  await expect(page).toHaveURL(/#\/q\/coord$/)
  await page.goto(`${server.url}/?company=default#/teams`)
  // The plan its coordinator keeps: how far it is on its card, each task on its page.
  await coord.call('setPlan', { title: 'Ship the cart', tasks: [{ title: 'Round the total', state: 'done', who: 'worker1' }, { title: 'Drop the old column', state: 'waiting', ref: 'GH-6', who: 'coord' }] })
  await expect(team.locator('.tm-foot')).toContainText('Ship the cart')
  await expect(team.locator('.tm-foot')).toContainText('1 of 2')
  await page.goto(`${server.url}/?company=default#/q/coord`)
  const plan = page.locator('#team .pl-table')
  await expect(plan.locator('tr').nth(1)).toContainText('Round the total')
  await expect(plan.locator('tr').nth(2)).toContainText('Waits on you')
  // Who has each task, with the icon of what they are.
  await expect(plan.locator('tr').nth(1).locator('.pl-who .role')).toHaveClass(/worker/)
  await expect(plan.locator('tr').nth(2).locator('.pl-who .role')).toHaveClass(/coord/)
  await expect(page.locator('#team .pl-meter')).toHaveAttribute('aria-label', '1 of 2 done, 0 in progress, 0 blocked, 1 waiting on you')
  await coord.call('setPlan', { tasks: [] })
  await page.goto(`${server.url}/#/c`)
  await expect(page.locator('#mosaic')).toContainText('coord')
})

test('the org chart: a squad shows its coordinator and its worker', async ({ page }) => {
  await signIn(page, '#/org')
  const card = page.locator('.org-card[data-squad="coord"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('worker1')
  // Its header pressed without dragging it opens the team; by the keyboard too.
  await card.locator('.org-head').click({ position: { x: 20, y: 20 } })
  await expect(page).toHaveURL(/#\/q\/coord$/)
  await page.goto(`${server.url}/?company=default#/org`)
  await page.locator('.org-card[data-squad="coord"] .org-head').focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/q\/coord$/)
})

test('a chat: it shows the history, and a new message without reloading', async ({ page }) => {
  await signIn(page, '#/s/worker1/chat')
  const session = page.locator('#session')
  await expect(session).toContainText('first task for the worker')
  await coord.send('worker1', 'second task, sent while watching')
  await expect(session).toContainText('second task, sent while watching')
})

test('the machines: a connected one is listed with its terminal', async ({ page }) => {
  await signIn(page, '#/hosts')
  const hosts = page.locator('#hosts')
  await expect(hosts.locator('.host-head')).toContainText('machine1')
  await expect(hosts.locator('.host-head .dot.ok')).toBeVisible()
  await expect(hosts.locator('.term-row').filter({ hasText: 'worker1' })).toBeVisible()
})

test('the inbox: what a coordinator left is there, with what it wrote kept as text, and it can be marked done', async ({ page }) => {
  const c = await startSession(server, 'inboxc', 'coordinator')
  await c.call('askUser', { text: 'Migrate the <b>column</b>?', options: ['Migrate', 'Keep'], recommended: 'Migrate first', ref: 'https://example.com/issues/421' })
  await c.call('tellUser', { text: 'The cart is done', ref: 'javascript:alert(1)' })
  await signIn(page, '#/inbox')
  const box = page.locator('#inbox')
  await expect(page.locator('#nav a[href="#/"] .badge')).toHaveText('2')
  // Nothing is open until one is picked: the list has the page.
  await expect(box.locator('.ibx-item').first()).toContainText('Migrate the <b>column</b>?')
  await expect(box.locator('.ibx-detail')).toBeHidden()
  // Each says what it is, and how long it has waited, on a clock that runs.
  const first = box.locator('.ibx-item').first()
  await expect(first.locator('.ibx-side .tag')).toHaveText('Decision')
  await expect(first.locator('.ibx-clock')).toHaveText(/^\d+:\d\d$/)
  const at = await first.locator('.ibx-clock').textContent()
  await expect(first.locator('.ibx-clock')).not.toHaveText(at, { timeout: 3000 })
  await box.locator('.ibx-item').first().click()
  await expect(box.locator('a[href="https://example.com/issues/421"]')).toBeVisible()
  // Esc closes it, and clicking it again opens it.
  await page.keyboard.press('Escape')
  await expect(box.locator('.ibx-detail')).toBeHidden()
  await box.locator('.ibx-item').first().click()
  // A question is dismissed, not done: here its coordinator can't be told, and it says so.
  await expect(box.locator('.ibx-detail [data-resolve]')).toHaveCount(0)
  await box.locator('[data-dismiss]').click()
  await expect(page.locator('.modal')).toContainText("couldn't be told")
  await page.locator('.modal .actions .btn').first().click()
  await expect(page.locator('#nav a[href="#/"] .badge')).toHaveText('1')
  // No decision left: back to the list, where the note is.
  await expect(page).toHaveURL(/#\/inbox$/)
  await box.locator('.ibx-item', { hasText: 'The cart is done' }).click()
  await expect(box.locator('a[href^="javascript"]')).toHaveCount(0)
  await box.locator('[data-resolve]').first().click()
  await expect(box).toContainText('Nothing is waiting for you')
})

test('the inbox: a question opened from the dashboard is answered there, and one changed meanwhile is read again first', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'inboxm', role: 'coordinator' } })
  const c = await startSession(server, 'inboxm', 'coordinator', undefined, machine.identities.get('inboxm'))
  const { id } = await c.call('askUser', { text: 'Stack the discounts?', options: ['Stack', 'Biggest'], recommended: 'Stack: customers expect it' })
  const { id: id2 } = await c.call('askUser', { text: 'Drop the column?', options: ['Drop', 'Keep'] })
  const { id: id3 } = await c.call('askUser', { text: 'Which name for the release?', options: ['1.3.0', '2.0.0'] })
  await signIn(page, `#/inbox/i${id}`)
  const detail = page.locator('.ibx-detail')
  await expect(page.locator('#topSub')).toContainText('3 waiting on you')
  // The recommended option is marked. Picking one only marks it: nothing is sent
  // until Send, with the detail typed before or after it.
  await expect(detail.locator('[data-option="0"]')).toHaveClass(/rec/)
  await expect(detail.locator('.ibx-rec')).toHaveText(/Customers expect it/)
  await detail.locator('[data-option="1"]').click()
  await expect(detail.locator('[data-option="1"]')).toHaveAttribute('aria-pressed', 'true')
  await detail.locator('[data-option="0"]').click()
  await expect(detail.locator('[data-option="0"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.locator('[data-option="1"]')).toHaveAttribute('aria-pressed', 'false')
  await detail.locator('textarea[name=answer]').fill('cap it at 25 %')
  expect(machine.answers.some(a => a.text.includes(`#${id} `))).toBe(false)
  await detail.locator('button.primary').click()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id} ("Stack the discounts?"), the user answers from their inbox: Stack. cap it at 25 %`)
  // Then the next that waits; what was answered is in Done.
  await expect(page).toHaveURL(new RegExp(`#/inbox/i(${id2}|${id3})$`))
  await page.locator('#topTabs [data-ibxtab=done]').click()
  await page.locator(`[data-key="i${id}"]`).click()
  await expect(page).toHaveURL(new RegExp(`#/inbox/done/i${id}$`))
  await expect(detail).toContainText('answered: Stack. cap it at 25 %')
  await page.locator('#topTabs [data-ibxtab=pending]').click()
  // A key picks an option (2 is the second), and Ctrl+Enter sends it.
  await page.locator(`[data-key="i${id3}"]`).click()
  await expect(detail).toContainText('Which name for the release?')
  await page.keyboard.press('2')
  await expect(detail.locator('[data-option="1"]')).toHaveAttribute('aria-pressed', 'true')
  await detail.locator('[data-option="1"]').focus()
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id3} ("Which name for the release?"), the user answers from their inbox: 2.0.0`)
  // Changed by its coordinator while open here: refused once, and it says so.
  page.expectedErrors = [/status of 409/]
  // The last that waits opens by itself; clicked again, it would close.
  await expect(page).toHaveURL(new RegExp(`#/inbox/i${id2}$`))
  await expect(detail).toContainText('Drop the column?')
  await c.call('editInbox', { id: String(id2), text: 'Drop the column? It holds data in all 1240 rows' })
  await expect(detail).toContainText('1240 rows')
  await expect(detail.locator('[data-changed]')).toBeVisible()
  await detail.locator('textarea[name=answer]').fill('Keep it')
  await detail.locator('button.primary').click()
  await expect(page.locator('.modal')).toContainText('read it again')
  await page.locator('.modal .actions .btn').first().click()
  expect(machine.answers.some(a => a.text.includes(`#${id2}`))).toBe(false)
  await expect(detail.locator('textarea[name=answer]')).toHaveValue('Keep it')
  await detail.locator('button.primary').click()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id2} ("Drop the column? It holds data in all 1240 rows"), the user answers from their inbox: Keep it`)
  await expect(page.locator('#inbox')).toContainText('Nothing is waiting for you')
  // Something it was told is replied to as well, with what it said; Done still closes it without a reply.
  const { id: t1 } = await c.call('tellUser', { text: 'The branches are behind main by 12 commits' })
  const { id: t2 } = await c.call('tellUser', { text: 'The release notes are ready' })
  await page.locator(`[data-key="i${t1}"]`).click()
  await detail.locator('textarea[name=answer]').fill('Update them with main')
  await detail.locator('button.primary').click()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${t1} ("The branches are behind main by 12 commits"), you told the user this, and they reply from their inbox: Update them with main`)
  await expect(page).toHaveURL(new RegExp(`#/inbox/i${t2}$`))
  await detail.locator(`[data-resolve="${t2}"]`).click()
  expect(machine.answers.some(a => a.text.includes(`#${t2} `))).toBe(false)
  await expect(page.locator('#inbox')).toContainText('Nothing is waiting for you')
  await page.locator('#topTabs [data-ibxtab=done]').click()
  await page.locator(`[data-key="i${t1}"]`).click()
  await expect(detail).toContainText('answered: Update them with main')
})

test('the inbox read aloud: each decision with its options, answered by voice and sent only on a yes; a note replied to', async ({ page }) => {
  // The browser's speech, played by the test: what it says is kept, what is "heard" is queued.
  await page.addInitScript(() => {
    try { localStorage.setItem('pisha.voice-ok', '1') } catch {}
    window.__said = []
    window.__heard = []
    window.SpeechRecognition = class {
      start() { setTimeout(() => { const t = window.__heard.shift(); if (t != null) this.onresult?.({ results: [[{ transcript: t }]] }); this.onend?.() }, 20) }
      abort() {}
    }
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.__said.push(u.text); setTimeout(() => u.onend?.(), 5) }, cancel() {}, getVoices: () => [] } })
  })
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'voicec', role: 'coordinator' } })
  const c = await startSession(server, 'voicec', 'coordinator', undefined, machine.identities.get('voicec'))
  await signIn(page, '#/inbox')
  // Only this test's entries in the inbox.
  await page.evaluate(async () => {
    const open = (await fetch('/api/c/default/inbox').then(r => r.json())).result.filter(i => !i.resolved_at)
    for (const i of open) await fetch('/api/c/default/inbox/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id }) })
  })
  const { id } = await c.call('askUser', { text: 'Ship on **Friday**?', options: ['Yes', 'No'], recommended: 'No: QA first' })
  const { id: note } = await c.call('tellUser', { text: 'The branches are behind main' })
  await expect(page.locator('#inbox')).toContainText('Ship on')
  // A "no" to what it understood: asked again. Then the second option with a detail, and a yes.
  await page.evaluate(() => window.__heard.push('one', 'no', 'la dos, y avisa a QA', 'sí', 'Update them with main', 'yes'))
  await page.locator('#topRight [data-voice]').click()
  await expect(page.locator('#voiceBar')).toBeVisible()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id} ("Ship on **Friday**?"), the user answers from their inbox: No. avisa a QA`)
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${note} ("The branches are behind main"), you told the user this, and they reply from their inbox: Update them with main`)
  // Only once each: the "one" that got a "no" was never sent.
  expect(machine.answers.filter(a => a.text.includes(`Inbox #${id} `)).length).toBe(1)
  const said = await page.evaluate(() => window.__said.join('\n'))
  expect(said).toContain('You have 1 decision and 1 note.')
  expect(said).toContain('A decision from voicec. Ship on Friday? Option 1: Yes. Option 2: No. It recommends 2.')
  expect(said).toContain('Option 1, Yes. Shall I send it?')
  expect(said).toContain('Option 2, No, and: avisa a QA. Shall I send it?')
  expect(said).toContain('Your answer: Update them with main. Shall I send it?')
  expect(said).toContain('A note from voicec. The branches are behind main. Say "done", "next", or reply to it.')
  // Nothing left: it says so, and the bar goes.
  await expect(page.locator('#voiceBar')).toHaveCount(0)
  expect(await page.evaluate(() => window.__said.at(-1))).toBe('Nothing left.')
})

test('the inbox read aloud: "stop" ends it, also while it asks whether to send, and nothing is sent', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('pisha.voice-ok', '1') } catch {}
    window.__said = []
    window.__heard = ['la uno', 'para']
    window.SpeechRecognition = class {
      start() { setTimeout(() => { const t = window.__heard.shift(); if (t != null) this.onresult?.({ results: [[{ transcript: t }]] }); this.onend?.() }, 20) }
      abort() {}
    }
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.__said.push(u.text); setTimeout(() => u.onend?.(), 5) }, cancel() {}, getVoices: () => [] } })
  })
  await signIn(page, '#/inbox')
  const c = await startSession(server, 'voicec', 'coordinator', undefined, machine.identities.get('voicec'))
  const { id } = await c.call('askUser', { text: 'Rename the release?', options: ['Yes', 'No'] })
  await expect(page.locator('#inbox')).toContainText('Rename the release?')
  await page.locator('#topRight [data-voice]').click()
  await expect.poll(() => page.evaluate(() => window.__said.join('\n'))).toContain('Option 1, Yes. Shall I send it?')
  await expect(page.locator('#voiceBar')).toHaveCount(0)
  await expect(page.locator('#topRight [data-voice]')).toHaveAttribute('aria-pressed', 'false')
  expect(machine.answers.some(a => a.text.includes(`Inbox #${id} `))).toBe(false)
})

test('the inbox read aloud: its speed changes with a tap on the card, at once, and is remembered', async ({ page }) => {
  // A voice that keeps talking until it is cut short, as a long question would.
  await page.addInitScript(() => {
    try { localStorage.setItem('pisha.voice-ok', '1') } catch {}
    window.__said = []
    window.SpeechRecognition = class { start() { setTimeout(() => this.onend?.(), 20) } abort() {} }
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(u) { window.__said.push({ text: u.text, rate: u.rate }); window.__u = u; setTimeout(() => u.onboundary?.({ charIndex: 40 }), 5) },
      cancel() { const u = window.__u; window.__u = null; setTimeout(() => u?.onend?.(), 0) },
      getVoices: () => [],
    } })
  })
  await signIn(page, '#/inbox')
  await page.evaluate(async () => {
    const open = (await fetch('/api/c/default/inbox').then(r => r.json())).result.filter(i => !i.resolved_at)
    for (const i of open) await fetch('/api/c/default/inbox/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id }) })
  })
  const c = await startSession(server, 'voicec', 'coordinator', undefined, machine.identities.get('voicec'))
  await c.call('askUser', { text: 'Move the launch to Tuesday? The videos are not ready. And the posts wait for them.', options: ['Yes', 'No'] })
  await expect(page.locator('#inbox')).toContainText('Move the launch')
  await page.locator('#topRight [data-voice]').click()
  const speed = page.locator('#voiceBar [data-voicespeed]')
  await expect(speed).toHaveText('Normal')
  await expect(speed).toHaveAttribute('aria-label', 'Reading speed: Normal. Tap to change it')
  // At once: what it was saying is said again, from the sentence it was in, faster.
  // (A tap on the card cuts the welcome short: then it reads the question.)
  await page.locator('#voiceBar [data-voicecut]').click()
  await expect(page.locator('#voiceBar .voice-text')).toContainText('Move the launch')
  const before = await page.evaluate(() => window.__said.length)
  await speed.click()
  await expect(speed).toHaveText('Fast')
  await expect.poll(() => page.evaluate(() => window.__said.at(-1)?.rate)).toBe(1.1)
  expect(await page.evaluate(() => window.__said.length)).toBe(before + 1)
  expect(await page.evaluate(() => window.__said.at(-1).text)).toMatch(/^Move the launch to Tuesday\? The videos are not ready\./)
  await speed.click()
  await expect(speed).toHaveText('Faster')
  await speed.click()
  await expect(speed).toHaveText('Normal')
  await speed.click()
  await expect(speed).toHaveText('Fast')
  await page.locator('#voiceBar [data-voicestop]').click()
  await expect(page.locator('#voiceBar')).toHaveCount(0)
  // Remembered here, for the next time.
  expect(await page.evaluate(() => localStorage.getItem('pisha.voice-rate'))).toBe('1.1')
  await page.evaluate(() => localStorage.removeItem('pisha.voice-rate'))
})

test('the inbox: pending and done apart; done a page at a time, by words or team; what arrives shows by itself', async ({ page }) => {
  const a = await startSession(server, 'pagea', 'coordinator')
  const b = await startSession(server, 'pageb', 'coordinator')
  const ids = []
  for (let n = 0; n < 27; n++) ids.push((await a.call('tellUser', { text: `Batch A note ${n}` })).id, (await b.call('tellUser', { text: `Batch B note ${n}` })).id)
  await server.call('api/inbox/read-all', { ids })
  await signIn(page, '#/inbox/done')
  const box = page.locator('#inbox')
  await expect(page.locator('#topTabs [data-ibxtab=done]')).toHaveAttribute('aria-current', 'page')
  await expect(box.locator('.ibx-group-h').first()).toHaveText('Today')
  // A page, and the next as the list ends.
  await expect(box.locator('.ibx-item')).toHaveCount(50)
  await box.locator('.ibx-more [data-more]').scrollIntoViewIfNeeded()
  await expect.poll(() => box.locator('.ibx-item').count()).toBeGreaterThanOrEqual(54)
  // By its words, then by team.
  await box.locator('#ibxQ').fill('Batch B note 7')
  await expect(box.locator('.ibx-item')).toHaveCount(1)
  await expect(box.locator('#ibxQ')).toHaveValue('Batch B note 7')
  await box.locator('#ibxQ').fill('')
  await box.locator('[data-donefilter] select').selectOption('pagea')
  await expect(box.locator('.ibx-item')).toHaveCount(27)
  await expect(box.locator('.ibx-end')).toBeVisible()
  // Pending: what arrives shows on its own, marked, and counted in the tab's title.
  await page.locator('#topTabs [data-ibxtab=pending]').click()
  await expect(page).toHaveURL(/#\/inbox$/)
  await a.call('tellUser', { text: 'Fresh note one' })
  await b.call('tellUser', { text: 'Fresh note two' })
  await expect(box.locator('.ibx-item', { hasText: 'Fresh note one' })).toHaveClass(/new/)
  await expect(page).toHaveTitle(/^\(\d+\) /)
  // Everything to know, read at once; then it is done.
  await box.locator('[data-readall]').click()
  await expect(box.locator('.ibx-item', { hasText: 'Fresh note' })).toHaveCount(0)
  await page.locator('#topTabs [data-ibxtab=done]').click()
  // (The team picked there still is: one of its own.)
  await expect(box.locator('.ibx-item', { hasText: 'Fresh note one' })).toBeVisible()
  await expect(box.locator('.ibx-item', { hasText: 'Fresh note two' })).toHaveCount(0)
})

test('disconnecting a machine: it offers to end the sessions opened there, ticked', async ({ page }) => {
  await signIn(page, '#/hosts')
  await page.locator('#hosts .host-head [data-hmenu]').first().click()
  await page.locator('.menu [data-a=disconnect]').click()
  const option = page.locator('.modal [data-option]')
  await expect(option).toBeChecked()
  await expect(page.locator('.modal .check')).toContainText('sessions')
  await page.locator('.modal [data-cancel]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('adding a machine: one page, from its command to the machine connected and where it may work', async ({ page }) => {
  await signIn(page, '#/hosts')
  await page.locator('#addHostBtn').click()
  await expect(page).toHaveURL(/#\/hosts\/new$/)
  const box = page.locator('#addmachine')
  // The whole way in sight: what isn't due yet, dimmed.
  await expect(box.locator('.nt-sec.later')).toHaveCount(3)
  await box.locator('[name=amname]').fill('studio')
  const enrolled = page.waitForResponse(r => r.url().includes('/hosts/enroll'))
  await box.locator('[data-gen]').click()
  const { result } = await (await enrolled).json()
  await expect(box.locator('.cmd').first()).toBeVisible()
  await expect(box).toContainText('Waiting for the machine to connect')
  // Going elsewhere and back keeps it.
  await page.evaluate(() => { location.hash = '#/hosts' })
  await page.evaluate(() => { location.hash = '#/hosts/new' })
  await expect(box.locator('.cmd').first()).toBeVisible()
  // The machine that runs it connects: the page follows by itself.
  await startMachine(server, 'studio', { id: 'studio-w', role: 'worker' }, { code: result.code })
  await expect(box).toContainText('studio is connected')
  await expect(box.locator('.nt-sec.later')).toHaveCount(0)
  await expect(box.locator('.am-folders')).toContainText('/srv/squad')
})

test('adding a machine for a company: its command says which, and it can have its own system user', async ({ page }) => {
  await signIn(page)
  const other = await server.call('admin/createCompany', { name: 'Machine Co' })
  const cookie = await server.ownerCookie()
  await fetch(`${server.url}/api/companies/join`, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ company: other.id }) })
  await page.goto(`${server.url}/?company=${other.id}#/hosts`)
  await page.locator('#addHostBtn').click()
  await page.locator('[data-gen]').click()
  await page.locator('[data-os=linux]').click()
  const cmd = page.locator('#addmachine .cmd').first()
  await expect(cmd).toContainText(`--company=${other.id}`)
  await expect(cmd).not.toContainText('sudo')
  await page.locator('.am-adv > summary').click()
  await page.locator('[data-osuser]').fill('empresa-1')
  await page.locator('[data-osuser]').blur()
  await expect(cmd).toContainText('&& sudo bash install.sh')
  await expect(cmd).toContainText('--os-user=empresa-1')
  // A name that can't be one is not put in a command.
  await page.locator('[data-osuser]').fill('x; rm -rf /')
  await page.locator('[data-osuser]').blur()
  await expect(cmd).not.toContainText('--os-user')
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=machines]').click()
  await expect(page.locator('#settings')).toContainText('machine1')
})

test('a company: its activity, what it keeps, its export; deleted, and brought back', async ({ page }) => {
  await signIn(page)
  const co = await server.call('admin/createCompany', { name: 'To Delete' })
  const cookie = await server.ownerCookie()
  await fetch(`${server.url}/api/companies/join`, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ company: co.id }) })
  await page.goto(`${server.url}/?company=${co.id}`)
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=company]').click()
  const form = page.locator('[data-retention]')
  await form.locator('[name=retention_days]').fill('30')
  await form.locator('button').click()
  await expect(page.locator('[data-saved]')).toHaveText('Saved.')
  await page.locator('[data-tab=members]').click()
  await page.locator('[data-tab=company]').click()
  await expect(page.locator('.audit')).toContainText('company/retention/set')
  await expect(page.locator('[name=retention_days]')).toHaveValue('30')
  const download = page.waitForEvent('download')
  await page.locator('a[href$="/company/export"]').click()
  expect((await download).suggestedFilename()).toContain(`pisha-${co.id}-`)
  const del = page.locator('[data-delete-company]')
  await del.locator('[name=confirm]').fill('not the name')
  await del.locator('button').click()
  await expect(page.locator('#settings .err')).not.toBeEmpty()
  await del.locator('[name=confirm]').fill('To Delete')
  await del.locator('button').click()
  await expect(page).not.toHaveURL(new RegExp(co.id))
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=companies]').click()
  await page.locator(`[data-restore="${co.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(co.id))
  await expect(page.locator('#app')).toBeVisible()
})

test('a terminal: it shows the screen, and what is typed reaches the machine', async ({ page }) => {
  await signIn(page, `#/t/${machine.id}/worker1`)
  const screen = page.locator('#terminal .xterm-rows')
  await expect(screen).toContainText('screen from the machine')
  await page.locator('#terminal .xterm').click()
  await page.keyboard.type('hello')
  await expect(screen).toContainText('hello')
  expect(machine.typed.join('')).toContain('hello')
})

test('the inbox, running: who is at work now, with its clock, and it opens its session', async ({ page }) => {
  const s = await startSession(server, 'busy1', 'worker', 'coord')
  // (At work for over a minute, from one tool to its text to the next: the clock counts it all.)
  const t0 = Date.now() - 65_000
  await s.observe([
    { kind: 'prompt', ts: t0 }, { kind: 'tool_start', id: 'b1', tool: 'Bash', ts: t0 + 1000, summary: 'npm test' },
    { kind: 'tool_end', id: 'b1', tool: 'Bash', ts: t0 + 20_000, ok: true }, { kind: 'text', text: 'tests pass', ts: t0 + 30_000 },
    { kind: 'tool_start', id: 'b2', tool: 'Bash', ts: Date.now() - 2000, summary: 'npm run lint' },
  ])
  await signIn(page, '#/inbox')
  await expect(page.locator('#topTabs [data-ibxtab=running] .badge')).not.toHaveCount(0)
  await page.locator('#topTabs [data-ibxtab=running]').click()
  const row = page.locator('#inbox .ibx-item', { hasText: 'busy1' })
  await expect(row.locator('.ibx-side .tag')).toHaveText('Working')
  await expect(row.locator('.ibx-clock')).toHaveText(/^1:\d\d$/)
  await row.click()
  await expect(page).toHaveURL(/#\/s\/busy1$/)
})

test('the chat: what is opened stays open when more arrives, and text being selected is not redrawn away', async ({ page }) => {
  const s = await startSession(server, 'keep1', 'worker', 'coord')
  const t0 = Date.now()
  await s.observe([
    { kind: 'tool_start', id: 'k1', tool: 'Bash', ts: t0, summary: 'kept-tool', detail: 'kept input' },
    { kind: 'tool_end', id: 'k1', tool: 'Bash', ts: t0 + 1, ok: true, detail: 'kept output' },
    { kind: 'text', text: 'selectable words here', ts: t0 + 2 },
  ])
  await signIn(page, '#/s/keep1/chat')
  const group = page.locator('#session .chat details.tools').first()
  await group.locator('summary').first().click()
  const input = group.locator('details[data-d^="i"]').first()
  await input.locator('summary').click()
  await expect(input).toHaveAttribute('open', '')
  await s.observe([{ kind: 'text', text: 'one more line', ts: Date.now() }])
  await expect(page.locator('#session .chat')).toContainText('one more line')
  await expect(page.locator('#session .chat details[data-d^="i"]').first()).toHaveAttribute('open', '')
  // Selecting: nothing is redrawn until it ends.
  await page.evaluate(() => { const p = [...document.querySelectorAll('#session .assistant')].find(x => x.textContent.includes('selectable')); getSelection().selectAllChildren(p) })
  await s.observe([{ kind: 'text', text: 'arrived while selecting', ts: Date.now() }])
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => getSelection().toString())).toContain('selectable words')
  await expect(page.locator('#session .chat')).not.toContainText('arrived while selecting')
  await page.evaluate(() => getSelection().removeAllRanges())
  await expect(page.locator('#session .chat')).toContainText('arrived while selecting')
  // Left selected, it doesn't hide what arrives for ever (it waits 20 s, real ones).
  test.setTimeout(60_000)
  await page.evaluate(() => { const p = [...document.querySelectorAll('#session .assistant')].find(x => x.textContent.includes('selectable')); getSelection().selectAllChildren(p) })
  await s.observe([{ kind: 'text', text: 'arrived and left selected', ts: Date.now() }])
  await page.waitForTimeout(1000)
  await expect(page.locator('#session .chat')).not.toContainText('arrived and left selected')
  await expect(page.locator('#session .chat')).toContainText('arrived and left selected', { timeout: 25_000 })
  await expect(page.locator('#session .chat .older')).not.toContainText(/Loading/)
})

test('dialogs: Escape closes the one on top', async ({ page }) => {
  await signIn(page, `#/h/${machine.id}`)
  await page.locator('#topRight [data-hact="new"]').click()
  const dialogs = page.locator('.modal-bg')
  await expect(dialogs).toHaveCount(1)
  // The new session dialog is for the machine on screen.
  await expect(dialogs.first().locator('select').first()).toHaveValue(machine.id)
  await page.evaluate(() => { const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = '<button data-cancel>x</button>'; bg.querySelector('button').onclick = () => bg.remove(); document.body.appendChild(bg) })
  await expect(dialogs).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(dialogs).toHaveCount(1)
})

test('the chat: a link whose host is written with % shows the real host', async ({ page }) => {
  const s = await startSession(server, 'links1', 'worker', 'coord')
  const url = 'https://github.com%2Eevil.example/x'
  await s.observe([{ kind: 'text', text: `[${url}](${url})`, ts: Date.now() }])
  await signIn(page, '#/s/links1/chat')
  await expect(page.locator('#session .chat a[href*="evil.example"] + .dim-note')).toHaveText('(github.com.evil.example)')
})

test('the chat: a tool shows its end across messages, and none runs after its turn', async ({ page }) => {
  const s = await startSession(server, 'tools1', 'worker', 'coord')
  const t0 = Date.now()
  const tool = (kind, id, ts, extra) => ({ kind, id, tool: 'Bash', ts: t0 + ts, ...extra })
  await s.observe([
    tool('tool_start', 'crossed', 0, { summary: 'crossed-tool' }),
    { kind: 'text', text: 'a message in between', ts: t0 + 1 },
    tool('tool_end', 'crossed', 2, { ok: true }),
    tool('tool_start', 'denied', 3, { summary: 'denied-tool' }),
    { kind: 'stop', ts: t0 + 4 },
    tool('tool_start', 'running', 5, { summary: 'running-tool' }),
  ])
  await signIn(page, '#/s/tools1/chat')
  const row = name => page.locator('#session .chat .tool', { hasText: name }).locator('.res')
  const groups = page.locator('#session .chat details.tools')
  for (let i = 0; i < 3; i++) await groups.nth(i).evaluate(d => { d.open = true })
  await expect(row('crossed-tool')).toHaveClass(/\bok\b/)
  await expect(row('denied-tool')).toHaveText('no result')
  await expect(row('running-tool')).toHaveClass(/\brun\b/)
  // Its end doesn't appear again on its own: one group each, nothing else running.
  await expect(groups).toHaveCount(3)
  await expect(page.locator('#session .chat .res.run')).toHaveCount(2) // the tool, and its group
})

// (Last: it adds a terminal to the machine, which the tests above count.)
test('the Chat button: from a terminal and from the machines, it opens the chat', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'worker2', role: 'worker', coordinator: 'coord' } })
  const chatOpens = async button => {
    await button.click()
    await expect(page).toHaveURL(/#\/s\/worker2\/chat$/)
    await expect(page.locator('#session .chat')).toBeVisible()
  }
  await signIn(page, `#/t/${machine.id}/worker2`)
  await chatOpens(page.locator('#topRight').getByRole('button', { name: 'Chat', exact: true }))
  await page.goto(`${server.url}/#/hosts`)
  await chatOpens(page.locator('#hosts .term-row', { hasText: 'worker2' }).getByRole('button', { name: 'Chat', exact: true }))
})

test('beside a session terminal: what it is doing, and what mattered, read from what it reported', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'tlw', role: 'coordinator' } })
  const s = await startSession(server, 'tlw', 'coordinator', undefined, machine.identities.get('tlw'))
  const t = Date.now()
  const ev = (kind, ago, extra = {}) => ({ kind, ts: t - ago * 1000, ...extra })
  const bash = (id, cmd, ago, ok = true) => [ev('tool_start', ago, { id, tool: 'Bash', summary: cmd }), ev('tool_end', ago - 1, { id, tool: 'Bash', ok })]
  await s.observe([
    ev('prompt', 60, { text: 'Fix the cart' }),
    ev('tool_start', 50, { id: 'e1', tool: 'Edit', summary: 'src/cart.js (+3 −1)' }), ev('tool_end', 49, { id: 'e1', tool: 'Edit', ok: true }),
    ...bash('b1', 'npm test', 40, false), ...bash('b2', 'git commit -m "Round the total"', 30), ...bash('b3', 'ls -la', 20),
    ev('stop', 10),
  ])
  await signIn(page, '#/s/tlw')
  const tl = page.locator('.tv-aside .tl-list')
  // What it typed, the files it edited, the tests and the commit; a plain command is left out.
  await expect(tl.locator('.tl-item')).toHaveCount(4)
  for (const text of ['Fix the cart', 'Edited a file', 'src/cart.js', 'Tests failed', 'Round the total']) await expect(tl).toContainText(text)
  await expect(tl).not.toContainText('ls -la')
  // A new one shows up by itself.
  await s.observe(bash('b4', 'npm test', 5))
  await expect(tl).toContainText('Tests passed')
  // The panel folds, and stays folded.
  await page.locator('[data-tvfold]').click()
  await expect(page.locator('.tv')).toHaveClass(/folded/)
  await page.reload()
  await expect(page.locator('.tv')).toHaveClass(/folded/)
  // Opened from Machines, the same terminal has it too.
  await page.locator('[data-tvfold]').click()
  await page.goto(`${server.url}/#/t/${machine.id}/tlw`)
  await expect(page.locator('.tv-aside .tl-list')).toContainText('Round the total')
  // And beside its conversation, under its team and details.
  await page.goto(`${server.url}/#/s/tlw/chat`)
  await expect(page.locator('.sv-aside .tl-list')).toContainText('Round the total')
})

test('what a session is doing now: a phrase, with its command only in the tooltip', async ({ page }) => {
  const s = await startSession(server, 'nowp', 'worker', 'tlw')
  const long = 'cd /var/www/app && python3 manage.py shell -c "from orders.models import Order; print(Order.objects.filter(status=\'open\').count())"'
  await s.observe([{ kind: 'prompt', ts: Date.now() - 5000, text: 'Count them' }, { kind: 'tool_start', ts: Date.now() - 2000, id: 'p1', tool: 'Bash', summary: long, what: 'Count the open orders' }])
  await signIn(page, '#/s/nowp')
  const row = page.locator('.rail-sess', { hasText: 'nowp' })
  await expect(row).toHaveAttribute('title', /^Count the open orders · .*\nBash · cd \/var\/www\/app/s)
  await expect(page.locator('#topSub')).toContainText('Count the open orders')
  await expect(page.locator('#topSub')).not.toContainText('manage.py')
  // A command it recognises: its own phrase, in the dashboard's language.
  await s.observe([{ kind: 'tool_end', ts: Date.now() - 1000, id: 'p1', tool: 'Bash', ok: true }, { kind: 'tool_start', ts: Date.now(), id: 'p2', tool: 'Bash', summary: 'cd /var/www/app && npm test 2>&1 | tail -40', what: 'Run the tests' }])
  await expect(page.locator('#topSub')).toContainText('Running the tests')
})

test('permission profiles: written in your own words, checked line by line, and a team opens with them', async ({ page }) => {
  page.expectedErrors = [/status of 400/] // (a rule Claude Code wouldn't read, refused on purpose)
  await signIn(page, '#/teams')
  await page.locator('#settingsBtn').click()
  await page.locator('.settings [data-tab=permissions]').click()
  // The two built in, kept as they are: a copy can be changed.
  await expect(page.locator('.perm-list tr')).toHaveCount(2)
  await expect(page.locator('.perm-list tr[data-profile=dev] [data-edit-profile]')).toHaveCount(0)
  await page.locator('[data-new-profile]').click()
  const d = page.locator('.modal')
  await d.locator('[name=name]').fill('Backend')
  await d.locator('[name=notes]').fill('They may commit and run the tests, but never push, and never use sudo.')
  await d.locator('[data-fill]').click()
  await expect(d.locator('[data-filled]')).toContainText('4 lines filled in')
  for (const [cap, st] of [['commit', 'allow'], ['tests', 'allow'], ['push', 'deny'], ['sudo', 'deny'], ['web', 'default']]) await expect(d.locator(`[name=cap-${cap}]`)).toHaveValue(st)
  // A rule Claude Code wouldn't read: said, and nothing saved.
  await d.locator('.perm-own summary').click()
  await d.locator('[name=own-deny]').fill('make deploy')
  await d.locator('[data-save]').click()
  await expect(d.locator('.err')).toContainText('is not a Claude Code permission rule')
  await d.locator('[name=own-deny]').fill('Bash(make deploy *)')
  await d.locator('[data-save]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  const row = page.locator('.perm-list tr', { hasText: 'Backend' })
  await expect(row).toContainText('Allowed: tests, commits')
  await expect(row).toContainText('Forbidden: push, sudo')
  await expect(row).toContainText('1 rule of its own')
  await page.keyboard.press('Escape')
  // The team follows it: shown on its page, and its sessions open with its rules.
  await page.goto(`${server.url}/?company=default#/q/coord`)
  await page.locator('.perm-side [data-perm-assign]').click()
  await page.locator('.modal [name=profile]').selectOption({ label: 'Backend' })
  await page.locator('.modal [data-ok]').click()
  await expect(page.locator('.perm-side')).toContainText('Follows “Backend”')
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'perm-w', role: 'worker', coordinator: 'coord', folder: '/srv/squad' } })
  const spec = machine.opened.find(o => o.name === 'perm-w')
  expect(spec.permissions.profile).toBe('Backend')
  expect(spec.permissions.allow).toContain('Bash(git commit *)')
  expect(spec.permissions.deny).toEqual(['Bash(git push *)', 'Bash(sudo *)', 'Bash(make deploy *)'])
  expect(spec.permissions.notes).toBe('They may commit and run the tests, but never push, and never use sudo.')
  // One session on its own: none, whatever its team's.
  await page.goto(`${server.url}/?company=default#/s/perm-w/chat`)
  await expect(page.locator('.sv-info .perm-side')).toContainText('Follows its team’s, “Backend”')
  await page.locator('.sv-info .perm-side [data-perm-assign]').click()
  await page.locator('.modal [name=profile]').selectOption('none')
  await page.locator('.modal [data-ok]').click()
  await expect(page.locator('.sv-info .perm-side')).toContainText('No profile')
})

test('people in all companies: a column each, the role changed in place, and one invitation for several', async ({ page }) => {
  const other = await server.call('admin/createCompany', { name: 'People Two' })
  await signIn(page)
  await page.locator('#settingsBtn').click()
  await page.locator('[data-tab=everyone]').click()
  const table = page.locator('#settings table.ev')
  await expect(table.locator('th', { hasText: 'People Two' })).toBeVisible()
  // One invitation, the same role in every company: one link.
  await page.locator('[data-evinvite] [name=email]').fill('two@example.com')
  await page.locator('[data-evinvite] [data-same]').selectOption('observer')
  await page.locator('[data-evinvite] button.primary').click()
  await expect(page.locator('#settings [data-link] .cmd')).toContainText('/#/invite/')
  await expect(page.locator('#settings')).toContainText('two@example.com')
  await expect(page.locator('#settings')).toContainText('People Two: Observer')
  // Each role says what it can do.
  await page.locator('#settings .roles-help summary').click()
  await expect(page.locator('#settings .roles-help')).toContainText('answers in the inbox')
  void other
})
