// The screenshots of the dashboard for the website, the README and the
// documentation: a made-up company with three teams at work, in English and
// Spanish, light and dark, on a desktop and a phone.
//   npm run screenshots            (into docs/screenshots/)
//   SHOTS_DIR=/some/folder npm run screenshots
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMachine, startServer, startSession } from './harness.mjs'

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'screenshots')
mkdirSync(OUT, { recursive: true })

const DATA = {
  en: {
    teams: [['coord-dev', 'Development', 'The shop: cart and payments'], ['coord-qa', 'QA', 'Test what Development ships'], ['editor', 'Content', 'The help centre and the release notes']],
    order: 'Go through the open issues in issues/ and fix them. Tell me if there are big decisions to make.',
    said: 'There are 12 open. I am splitting them between api and web by area, and I will leave in your inbox what is yours to decide.',
    webPrompt: 'Fix the error when confirming a payment (issue 18)',
    webText1: 'The error comes from **checkout.js**: the total is rounded twice, once per line and again at the end.',
    webText2: 'Fixed and covered with a test: 27 tests pass.',
    plan: ['Fix the open issues of the shop', [
      ['Round the total to cents', 'done', 'api', 'GH-2'], ['Free shipping from 40', 'done', 'api', 'GH-10'], ['Reject negative quantities', 'done', 'api', 'GH-4'],
      ['Error when confirming a payment', 'doing', 'web', 'GH-18'], ['Drop the legacy_discount column', 'waiting', null, 'GH-6', 'It holds data in all 1240 rows'],
      ['Stock from the supplier API', 'blocked', null, 'GH-7', 'The key is with purchasing'], ['Release 1.3.0', 'todo', null, 'GH-12']]],
    asks: [
      ['Issue 6 drops the legacy_discount column, but the production export has values in all 1240 rows. Back them up and drop it, or keep the column?', ['Back up, then drop', 'Keep the column'], 'Back up, then drop', 'https://github.com/example/shop/issues/6'],
      ['Stacking the coupon and the loyalty discount lowers the margin of discounted orders from 31% to 24%, and Finance wants at least 27%. Which rule?', ['Stack them, capped at 15%', 'Keep the bigger one'], 'Stack them, capped at 15%', 'GH-5'],
    ],
    tell: 'The invoices page is done and tested: 11 tests pass, committed on release/1.3.0, not deployed.',
    reports: [['web', 'done', 'Invoices page done: 11 tests pass'], ['api', 'blocked', 'The supplier API key is missing: purchasing has it']],
    boardName: 'Shop', boardTasks: ['Invoices page', 'Stock sync with the supplier', 'Round the cart total', 'Checkout tests on mobile'],
  },
  es: {
    teams: [['coord-dev', 'Desarrollo', 'La tienda: carrito y pagos'], ['coord-qa', 'QA', 'Probar lo que entrega Desarrollo'], ['editor', 'Contenidos', 'El centro de ayuda y las notas de versión']],
    order: 'Revisa las issues abiertas en issues/ y resuélvelas. Avísame si hay que tomar decisiones importantes.',
    said: 'Hay 12 abiertas. Las reparto entre api y web por áreas, y te dejo en la bandeja lo que te toca decidir.',
    webPrompt: 'Arregla el error al confirmar un pago (issue 18)',
    webText1: 'El error viene de **checkout.js**: el total se redondea dos veces, por línea y otra vez al final.',
    webText2: 'Arreglado y cubierto con una prueba: pasan las 27 pruebas.',
    plan: ['Resolver las issues abiertas de la tienda', [
      ['Redondear el total a céntimos', 'done', 'api', 'GH-2'], ['Envío gratis desde 40 €', 'done', 'api', 'GH-10'], ['Rechazar cantidades negativas', 'done', 'api', 'GH-4'],
      ['Error al confirmar un pago', 'doing', 'web', 'GH-18'], ['Quitar la columna legacy_discount', 'waiting', null, 'GH-6', 'Tiene datos en las 1240 filas'],
      ['Stock desde la API del proveedor', 'blocked', null, 'GH-7', 'La clave la tiene compras'], ['Publicar la 1.3.0', 'todo', null, 'GH-12']]],
    asks: [
      ['La issue 6 borra la columna legacy_discount, pero el export de producción tiene datos en las 1240 filas. ¿Hago una copia y la borro, o la conservo?', ['Copia y luego borrar', 'Conservar la columna'], 'Copia y luego borrar', 'https://github.com/example/shop/issues/6'],
      ['Sumar cupón y fidelidad baja el margen de los pedidos con descuento del 31 % al 24 %, y Finanzas pide al menos un 27 %. ¿Qué regla aplico?', ['Sumarlos con tope del 15 %', 'Dejar el mayor de los dos'], 'Sumarlos con tope del 15 %', 'GH-5'],
    ],
    tell: 'La página de facturas está terminada y probada: pasan 11 pruebas, con commit en release/1.3.0, sin publicar.',
    reports: [['web', 'done', 'Página de facturas terminada: pasan 11 pruebas'], ['api', 'blocked', 'Falta la clave de la API del proveedor: la tiene compras']],
    boardName: 'Tienda', boardTasks: ['Página de facturas', 'Sincronizar el stock con el proveedor', 'Redondear el total del carrito', 'Pruebas del pago en el móvil'],
  },
}

// What Claude Code shows in a terminal, near enough, for the live view.
const E = '\x1b[', dim = s => `${E}2m${s}${E}0m`, ok = s => `${E}32m${s}${E}0m`, acc = s => `${E}38;5;173m${s}${E}0m`, b = s => `${E}1m${s}${E}0m`
const term = lines => lines.join('\r\n') + '\r\n'
function screens(d) {
  return {
    'coord-dev': term([acc('╭─────────────────────────────────────────────────╮'), `${acc('│')} ${acc('✻')} ${b('Claude Code')}  ${dim('/srv/shop')}                       ${acc('│')}`, acc('╰─────────────────────────────────────────────────╯'), '',
      `${dim('>')} ${d.order.slice(0, 60)}…`, '', `${ok('⏺')} ${d.said.slice(0, 70)}…`, '',
      `${ok('⏺')} ${b('pisha - reply')} ${dim('(MCP)')}(chat_id: "web", text: "GH-18…")`, `  ${dim('⎿')}  sent (id: 41)`, '',
      `${ok('⏺')} ${b('pisha - update_plan')} ${dim('(MCP)')}(title: "${d.plan[0].slice(0, 28)}…")`, `  ${dim('⎿')}  Plan updated: 3 of 7 done, 1 in progress, 1 blocked, 1 waiting on the user.`, '',
      `${ok('⏺')} ${b('pisha - ask_user')} ${dim('(MCP)')}(text: "${d.asks[0][0].slice(0, 34)}…")`, `  ${dim('⎿')}  It is in the user's inbox (#1).`, '',
      `${acc('✻')} ${dim('Waiting for the workers’ reports…')}`, '', dim('─'.repeat(60)), `${dim('>')} `]),
    web: term([`${dim('>')} ${d.webPrompt}`, '', `${ok('⏺')} ${b('Read')}(src/checkout.js)`, `  ${dim('⎿')}  Read 214 lines`, '',
      `${ok('⏺')} ${b('Update')}(src/checkout.js)`, `  ${dim('⎿')}  Updated with 6 additions and 1 removal`, `     ${dim('118')} ${ok('+    const total = round(lines.reduce(sum, 0))')}`, '',
      `${ok('⏺')} ${b('Bash')}(npm test)`, `  ${dim('⎿')}  ${ok('✓')} 27 passed ${dim('(1.9 s)')}`, '', `${ok('⏺')} ${d.webText2}`, '',
      `${ok('⏺')} ${b('Bash')}(npm run lint)`, `  ${dim('⎿')}  ${acc('Running…')}`, '', dim('─'.repeat(60)), `${dim('>')} `]),
  }
}

async function company(lang) {
  const d = DATA[lang]
  const server = await startServer()
  const machine = await startMachine(server, 'mac-mini', { id: 'api', role: 'worker', coordinator: 'coord-dev' }, { screens: screens(d) })
  // (Codex and Grok sessions too, to show each agent's mark: Codex in a pane
  // that shows its conversation, Grok only in the lists, since the terminals
  // drawn here are Claude Code's.)
  const open = async (name, role, coordinator, agent) => {
    await server.call('api/terminals/open', { host: machine.id, spec: { name, role, ...(coordinator ? { coordinator } : {}) } })
    return startSession(server, name, role, coordinator, machine.identities.get(name), { agent })
  }
  const dev = await open('coord-dev', 'coordinator')
  const web = await open('web', 'worker', 'coord-dev')
  const api = await startSession(server, 'api', 'worker', 'coord-dev', undefined, { agent: 'codex' })
  const qa = await open('coord-qa', 'coordinator')
  await open('pruebas', 'worker', 'coord-qa', 'grok')
  await open('editor', 'coordinator')
  await startMachine(server, 'server-2', { id: 'docs', role: 'worker', coordinator: 'editor' })
  for (const [c, title, goal] of d.teams) await server.call('api/org/squad', { coordinator: c, title, goal })
  const t = Date.now()
  const ev = (kind, at, extra = {}) => ({ kind, ts: t - at * 1000, ...extra })
  await dev.observe([ev('observe_start', 900, { level: 'full', cwd: '/srv/shop' }), ev('prompt', 880, { text: d.order }), ev('text', 860, { text: d.said }),
    ev('tool_start', 850, { id: 't1', tool: 'Bash', summary: 'ls issues/' }), ev('tool_end', 849, { id: 't1', tool: 'Bash', ok: true, summary: '12 files' }),
    ev('tool_start', 840, { id: 't2', tool: 'Read', summary: 'issues/006-drop-legacy-discount.md' }), ev('tool_end', 839, { id: 't2', tool: 'Read', ok: true }),
    ev('usage', 830, { context_tokens: 182000, compact_at: 600000, context_window: 1000000, context_pct: 30 }), ev('stop', 820)])
  await web.observe([ev('observe_start', 700, { level: 'full', cwd: '/srv/shop' }), ev('prompt', 600, { text: d.webPrompt }), ev('text', 560, { text: d.webText1 }),
    ev('tool_start', 540, { id: 'w1', tool: 'Read', summary: 'src/checkout.js' }), ev('tool_end', 539, { id: 'w1', tool: 'Read', ok: true }),
    ev('tool_start', 520, { id: 'w2', tool: 'Edit', summary: 'src/checkout.js +6 −1' }), ev('tool_end', 518, { id: 'w2', tool: 'Edit', ok: true }),
    ev('tool_start', 500, { id: 'w3', tool: 'Bash', summary: 'npm test' }), ev('tool_end', 470, { id: 'w3', tool: 'Bash', ok: true, summary: '27 passed', duration_ms: 30000 }),
    ev('text', 460, { text: d.webText2 }), ev('tool_start', 30, { id: 'w4', tool: 'Bash', summary: 'npm run lint' })])
  await api.observe([ev('observe_start', 800, { level: 'full', cwd: '/srv/shop' }), ev('tool_start', 40, { id: 'a1', tool: 'Bash', summary: 'npm test -- stock' }),
    ev('notification', 35, { type: 'permission_prompt', text: 'Bash: npm test -- stock' })])
  await dev.call('setPlan', { title: d.plan[0], tasks: d.plan[1].map(([title, state, who, ref, note]) => ({ title, state, ...(who ? { who } : {}), ref, ...(note ? { note } : {}) })) })
  for (const [text, options, recommended, ref] of d.asks) await dev.call('askUser', { text, options, recommended, ref })
  await qa.call('tellUser', { text: d.tell })
  for (const [from, report, text] of d.reports) await (from === 'web' ? web : api).call('sendMessage', { chat_id: 'coord-dev', text, pisha_report: report })
  return server
}

// A company of its own for the usage screen: linked teams that message each
// other, a board with tasks, and a week of tokens spent on them, each turn
// started by a real message (what started it is told from the message).
async function usageCompany(lang) {
  const d = DATA[lang]
  const server = await startServer()
  const machine = await startMachine(server, 'mac-mini', { id: 'api', role: 'worker', coordinator: 'coord-dev' }, { screens: {} })
  const open = async (name, role, coordinator, agent) => {
    await server.call('api/terminals/open', { host: machine.id, spec: { name, role, ...(coordinator ? { coordinator } : {}) } })
    return startSession(server, name, role, coordinator, machine.identities.get(name), { agent })
  }
  const dev = await open('coord-dev', 'coordinator')
  const web = await open('web', 'worker', 'coord-dev')
  const api = await startSession(server, 'api', 'worker', 'coord-dev', undefined, { agent: 'codex' })
  const qa = await open('coord-qa', 'coordinator')
  const grok = await open('pruebas', 'worker', 'coord-qa', 'grok')
  for (const [c, title, goal] of d.teams) if (c !== 'editor') await server.call('api/org/squad', { coordinator: c, title, goal })
  await server.call('api/links/add', { a: 'coord-dev', b: 'coord-qa' })
  const board = await server.call('api/boards/create', { name: d.boardName, teams: ['coord-dev', 'coord-qa'] })
  for (const title of d.boardTasks) await server.call('api/tasks/create', { board: board.id, title })
  const msg = async (from, to) => (await from.call('sendMessage', { chat_id: to, text: 'SQ-1' })).message_id
  const ids = { toWeb: await msg(dev, 'web'), toApi: await msg(dev, 'api'), toGrok: await msg(qa, 'pruebas'), fromWeb: await msg(web, 'coord-dev'), fromApi: await msg(api, 'coord-dev'), fromGrok: await msg(grok, 'coord-qa'), toQa: await msg(dev, 'coord-qa'), toDev: await msg(qa, 'coord-dev') }
  const t = Date.now()
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  // [session, model, how much it spends, what starts its turns]
  const spend = [
    [dev, 'claude-opus-5-5', 0.9, [['user'], ['message', ids.fromWeb], ['message', ids.fromApi], ['message', ids.toDev], ['board']]],
    [web, 'claude-opus-5-5', 1.3, [['message', ids.toWeb]]],
    [api, 'gpt-5.5-codex', 0.8, [['message', ids.toApi]]],
    [qa, 'claude-sonnet-5-5', 0.5, [['message', ids.toQa], ['message', ids.fromGrok], ['inbox']]],
    [grok, 'grok-4.7', 0.6, [['message', ids.toGrok]]],
  ]
  for (let day = 6; day >= 0; day--) {
    const busy = [0.6, 0.9, 0.4, 1.1, 1.0, 0.7, 0.8][day]
    for (const [s, model, weight, causes] of spend) {
      const events = []
      for (let i = 0; i < 6; i++) {
        const k = (40_000 + rnd() * 90_000) * weight * busy
        const [cause, id] = causes[i % causes.length]
        events.push({ kind: 'tokens', ts: t - day * 86400_000 - (2 + i * 1.3) * 3600_000, model, input: Math.round(k * 0.02), cache_read: Math.round(k * 0.82), cache_write: Math.round(k * 0.13), output: Math.round(k * 0.03), calls: 2 + Math.round(rnd() * 6), cause, ...(id ? { msg: id } : {}), task: `SQ-${1 + Math.floor(rnd() * d.boardTasks.length)}` })
      }
      await s.observe(events)
    }
  }
  return server
}

const SHOTS = [
  // name, address, what to wait for, phone?
  ['inbox', '#/inbox/i1', '.ibx-opts'],
  ['inbox-list', '#/inbox', '.ibx-item'],
  ['teams', '#/teams', '.tm-card'],
  ['team', '#/q/coord-dev', '.pl-table'],
  ['session', '#/s/web/chat', '.sv-aside .sv-member'],
  ['timeline', '#/s/web', '.tv-aside .tl-item'], // (the terminal with its timeline beside it: the website shows it)
  ['machines', '#/hosts', '.mc-table'],
  ['org-chart', '#/org', '.org-card'],
  ['usage', '#/usage', '.u-tile', false, 'usage'],
  ['live', '#/q/coord-dev/live', '.pane'],
  ['new-team', '#/new', '.nt-member'],
  ['phone-inbox', '#/', '.ibx-item', true],
  ['phone-decision', '#/inbox/i1', '.ibx-opts', true],
]

for (const lang of ['en', 'es']) {
  test.describe(lang, () => {
    let server, usage
    test.beforeAll(async () => { server = await company(lang); usage = await usageCompany(lang) })
    test.afterAll(async () => { await server?.stop(); await usage?.stop() })
    for (const scheme of ['dark', 'light']) {
      test(`${lang} ${scheme}`, async ({ browser }) => {
        for (const [name, hash, ready, phone, which] of SHOTS) {
          const server_ = which === 'usage' ? usage : server
          const ctx = await browser.newContext({ colorScheme: scheme, locale: lang === 'es' ? 'es-ES' : 'en-GB', viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2 })
          await ctx.addInitScript(l => { try { localStorage.setItem('pishaLang', l) } catch {} }, lang)
          const page = await ctx.newPage()
          const [n, v] = (await server_.ownerCookie()).split('=')
          await ctx.addCookies([{ name: n, value: v, url: server_.url }])
          await page.goto(`${server_.url}/?company=default${hash}`)
          await expect(page.locator(ready).first()).toBeVisible()
          await page.evaluate(() => document.fonts.ready)
          await page.waitForTimeout(400)
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${lang}.jpg`), type: 'jpeg', quality: 86 })
          if (name === 'inbox') {
            await page.keyboard.press('Control+k'); await page.keyboard.type('we'); await page.waitForTimeout(250)
            await page.screenshot({ path: join(OUT, `palette-${scheme}-${lang}.jpg`), type: 'jpeg', quality: 86 })
            await page.keyboard.press('Escape')
            await page.locator('#settingsBtn').click(); await page.locator('[data-tab=appearance]').click(); await page.waitForTimeout(250)
            await page.screenshot({ path: join(OUT, `settings-${scheme}-${lang}.jpg`), type: 'jpeg', quality: 86 })
          }
          await ctx.close()
        }
      })
    }
  })
}
