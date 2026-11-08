// Agents without channels (Codex CLI, Grok CLI). What arrives is left in this
// session's pending-input folder, one file per message, and squadra-host types
// it in the session's terminal when the agent waits for input: a <channel>
// block like the ones Claude Code shows, so the same rules read the same way.
// Answers to permission prompts are left the same way, for squadra-host to type.

import { mkdirSync, lstatSync, readdirSync } from 'node:fs'
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

// Messages left for the terminal and not typed yet: squadra-host types them
// only while the agent waits for input, so between its turns.
export function waiting() {
  try { return readdirSync(join(S.stateDir, PENDING_DIR)).filter(f => /^\d{14}-\d{6}-\d+\.txt$/.test(f)).length } catch { return 0 }
}

// Where squadra-host looks for answers to permission prompts (the same name there).
export const ANSWERS_DIR = 'permission-answers'

// An approver's answer to a prompt in the terminal (see onTypedPermission),
// with the call it was asked about: squadra-host types it only while the
// prompt on screen shows that call.
export function givePermission(verdict) {
  const s = S
  if (!s || !verdict?.typed || !/^[a-km-z]{5}$/.test(String(verdict.request_id))) return
  try {
    const dir = join(s.stateDir, ANSWERS_DIR)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`)
    const answer = { request_id: verdict.request_id, behavior: verdict.behavior === 'allow' ? 'allow' : 'deny', tool: String(verdict.typed.tool), input: verdict.typed.input, at: Date.now() }
    writePrivateFile(join(dir, `${String(Date.now()).padStart(14, '0')}-${verdict.request_id}.json`), JSON.stringify(answer) + '\n')
  } catch (err) {
    log(`could not leave a permission answer for the terminal: ${err.message}`)
  }
}
