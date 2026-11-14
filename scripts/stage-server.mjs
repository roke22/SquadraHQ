#!/usr/bin/env node
// The npm package is server/ alone: before it is packed (npm pack, npm
// publish), what the server also hands out to machines is copied into it
// (pisha-host and its signature, the installers), where the server looks
// for them when they aren't beside it as in the repository; after, removed.
//
//   node scripts/stage-server.mjs        copy them in
//   node scripts/stage-server.mjs --undo remove them

import { cpSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server')
const PARTS = [['host/pisha-host.mjs', 'pisha-host.mjs'], ['host/pisha-host.mjs.sig', 'pisha-host.mjs.sig'], ['install', 'install'], ['LICENSE', 'LICENSE']]

if (process.argv.includes('--undo')) {
  for (const [, to] of PARTS) rmSync(join(SERVER, to), { recursive: true, force: true })
} else {
  for (const [from, to] of PARTS) {
    if (!existsSync(join(ROOT, from))) { if (from.endsWith('.sig')) continue; throw new Error(`${from} is missing`) }
    cpSync(join(ROOT, from), join(SERVER, to), { recursive: true })
  }
}
