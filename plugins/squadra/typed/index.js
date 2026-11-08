// Agents without channels (Codex CLI, Grok CLI). What arrives is left in this
// session's pending-input folder, one file per message, and squadra-host types
// it in the session's terminal when the agent waits for input: a <channel>
// block like the ones Claude Code shows, so the same rules read the same way.
// Permission prompts are answered in the session's own terminal (no relay).

import { mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { S, log, writePrivateFile } from '../core/index.js'

export const TYPED_AGENTS = ['codex', 'grok']

// Where squadra-host looks for what to type (the same name there).
export const PENDING_DIR = 'pending-input'

const attr = v => String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c])

// The block as it is typed. content is already safe (safeContent: no
// "<channel" or "</channel" inside it).
export function render({ content, meta }) {
  const attrs = Object.entries(meta ?? {})
    .filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && v != null && v !== '')
    .map(([k, v]) => ` ${k}="${attr(v)}"`).join('')
  return `<channel source="squadra"${attrs}>\n${String(content ?? '').trim()}\n</channel>`
}

let seq = 0
export function deliver(params) {
  const s = S
  if (!s) return
  try {
    const dir = join(s.stateDir, PENDING_DIR)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`)
    // (Named so they sort in the order they arrived.)
    const name = `${String(Date.now()).padStart(14, '0')}-${String(++seq).padStart(6, '0')}-${process.pid}.txt`
    writePrivateFile(join(dir, name), render(params) + '\n')
  } catch (err) {
    log(`could not leave a message for the terminal: ${err.message}`)
  }
}

// No relay: the prompt is answered in the terminal.
export const givePermission = () => {}
export const takePermissionReply = () => 'chat'
