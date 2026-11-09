// Folders a test makes for itself, gone when its file ends: each test file
// runs in its own process, and this removes what that process made on the
// way out. (A run cut short leaves them, as any killed program would.)

import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made = []

// mkdtempSync(join(base, prefix)), remembered.
export function tempDir(prefix, base = tmpdir()) {
  const dir = mkdtempSync(join(base, prefix))
  made.push(dir)
  return dir
}

// A folder made by the code under test, not by the test: removed the same way.
export function removeLater(dir) {
  made.push(dir)
  return dir
}

// (A test may leave a folder it can't read or write, to check that case: given back first.)
function writable(dir) {
  try { chmodSync(dir, 0o700) } catch { return }
  let entries = []
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    const p = join(dir, e)
    try { if (lstatSync(p).isDirectory()) writable(p) } catch { /* gone meanwhile */ }
  }
}

export function removeTempDirs() {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {
      writable(dir)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* left: nothing more to do */ }
    }
  }
}
process.on('exit', removeTempDirs)
