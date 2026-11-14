// The npm package (npx pisha-server): packed from server/ as npm publish
// would, unpacked elsewhere, and started from there with nothing else around
// it. It answers, keeps its data in ~/.pisha, and hands out to machines what
// it must (pisha-host and the installers), which live outside server/ in the
// repository.
//
// Run: node --test test/package.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './tempdirs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('the npm package starts on its own, keeps its data in ~/.pisha, and hands out pisha-host and the installers', async () => {
  const out = tempDir('pisha-pack-')
  execFileSync('npm', ['pack', '--pack-destination', out], { cwd: join(ROOT, 'server'), stdio: 'ignore' })
  const tgz = readdirSync(out).find(f => f.endsWith('.tgz'))
  assert.ok(tgz, 'packed')
  // (The copies made for packing are gone from the repository again.)
  for (const f of ['pisha-host.mjs', 'install', 'LICENSE']) assert.ok(!existsSync(join(ROOT, 'server', f)), `${f} left in server/`)

  const where = tempDir('pisha-unpacked-')
  execFileSync('tar', ['xzf', join(out, tgz), '-C', where])
  const pkg = join(where, 'package')
  for (const f of ['server.js', 'ui/index.html', 'vendor/InterVariable.woff2', 'pisha-host.mjs', 'install/linux.sh', 'install/macos.sh', 'install/windows.bat', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(pkg, f)), `${f} in the package`)
  }
  assert.ok(!existsSync(join(pkg, 'Dockerfile')), 'no Dockerfile in the package')

  // Started from somewhere else, as npx would: its data goes to ~/.pisha.
  const home = tempDir('pisha-home-')
  const cwd = tempDir('pisha-cwd-')
  mkdirSync(cwd, { recursive: true })
  const port = 24000 + Math.floor(Math.random() * 2000)
  const env = { ...process.env, HOME: home, PORT: String(port) }
  delete env.DATA_DIR
  const proc = spawn(process.execPath, [join(pkg, 'server.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  proc.stdout.on('data', d => { said += d }); proc.stderr.on('data', d => { said += d })
  try {
    let up = false
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch {} if (!up) await sleep(50) }
    assert.ok(up, `it answers: ${said.slice(-1500)}`)
    assert.ok(existsSync(join(home, '.pisha', 'pisha.db')), 'its data in ~/.pisha')
    assert.ok(existsSync(join(home, '.pisha', 'server-token')), 'its token in ~/.pisha')
    assert.ok(!existsSync(join(cwd, 'data')), 'nothing where it was started')
    assert.ok(said.includes(join(home, '.pisha')), 'it says where its token is')
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.match(await page.text(), /<title>Pisha<\/title>/)
    const host = await fetch(`http://127.0.0.1:${port}/host/pisha-host.mjs`)
    assert.equal(host.status, 200)
    assert.equal(await host.text(), readFileSync(join(ROOT, 'host/pisha-host.mjs'), 'utf8'))
    const linux = await fetch(`http://127.0.0.1:${port}/install/linux.sh`)
    assert.equal(linux.status, 200)
    assert.match(await linux.text(), /^#!\/usr\/bin\/env bash/)
  } finally {
    proc.kill('SIGTERM')
    await new Promise(r => proc.on('exit', r))
  }
})
