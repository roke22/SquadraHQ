import { T } from './i18n.js'

// What a session is doing now, said as a phrase ("Running the tests",
// "Reading observe.js") instead of the command or the tool's arguments: the
// whole command is in its conversation and in the tooltip. Read from what the
// session already reports; nothing is asked of the model.
// Order: a command recognised here (said the same way in every language),
// then the description Claude wrote for it, then the program's name alone.

// Commands that say what they do (a guess from the command line). The
// timeline uses the first three too.
export const TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?\b|\bnpx\s+(?:vitest|jest|playwright\s+test|mocha)\b|\b(?:pytest|vitest|jest|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bmake\s+(?:test|check)\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradle\w*\s+test\b|\bartisan\s+test\b/
export const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/
export const PUSH_RE = /\bgit\s+(?:-C\s+\S+\s+)?push\b/
const GIT = sub => new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:${sub})\\b`)

const quoted = re => cmd => { const m = re.exec(cmd); return m ? (m[2] ?? m[3] ?? '').slice(0, 60) : null }
const searchTerm = quoted(/\b(?:rg|grep|egrep|ag|ack|git\s+grep)\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:(["'])(.+?)\1|([^\s|;&<>"'-][^\s|;&<>]*))/)
const hostOf = url => { try { return new URL(url).host } catch { return '' } }
const urlIn = cmd => /\bhttps?:\/\/[^\s"'|;&<>)]+/.exec(cmd)?.[0] ?? ''

// [test, phrase]: the first that matches.
const COMMANDS = [
  [cmd => TEST_RE.test(cmd), () => T.nowTests],
  [cmd => COMMIT_RE.test(cmd), () => T.nowCommit],
  [cmd => PUSH_RE.test(cmd), () => T.nowPush],
  [cmd => GIT('pull|fetch').test(cmd), () => T.nowPull],
  [cmd => GIT('checkout|switch').test(cmd), () => T.nowBranch],
  [cmd => GIT('merge|rebase|cherry-pick').test(cmd), () => T.nowMerge],
  [cmd => GIT('diff|show').test(cmd), () => T.nowDiff],
  [cmd => GIT('log').test(cmd), () => T.nowGitLog],
  [cmd => GIT('status').test(cmd), () => T.nowGitStatus],
  [cmd => /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b|\bpip3?\s+install\b|\bcomposer\s+(?:install|require|update)\b|\bbundle\s+install\b|\bcargo\s+fetch\b|\bgo\s+mod\s+(?:download|tidy)\b/.test(cmd), () => T.nowInstall],
  [cmd => /\beslint\b|\bprettier\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b|\bruff\b|\bflake8\b|\bphpcs\b|\bcargo\s+clippy\b/.test(cmd), () => T.nowLint],
  [cmd => /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b(?!\s+(?:test|check))|\bvite\s+build\b|\bwebpack\b/.test(cmd), () => T.nowBuild],
  [cmd => /\bartisan\s+migrate\b|\bprisma\s+migrate\b|\b(?:alembic|knex|sequelize)\b.*\bmigrat|\brails\s+db:migrate\b/.test(cmd), () => T.nowMigrate],
  [cmd => /\bdocker\s+(?:compose\s+|-compose\s+)?(?:up|start|run)\b|\bdocker-compose\s+up\b/.test(cmd), () => T.nowContainers],
  [cmd => /\bdocker\s+build\b/.test(cmd), () => T.nowImage],
  [cmd => searchTerm(cmd) != null, cmd => T.nowSearch(searchTerm(cmd), '')],
  [cmd => /^(?:find|fd|tree|ls)\b/.test(cmd), () => T.nowListFiles],
  [cmd => /^(?:curl|wget|http)\b/.test(cmd) && hostOf(urlIn(cmd)), cmd => T.nowFetch(hostOf(urlIn(cmd)))],
  [cmd => /^ssh\s/.test(cmd), cmd => T.nowSsh(/^ssh\s+(?:-\S+\s+(?:\S+\s+)?)*([^\s-]\S*)/.exec(cmd)?.[1]?.replace(/^.*@/, '') ?? '')],
  [cmd => /^sleep\s/.test(cmd), () => T.nowWait],
]

// The command that matters in a line: past "cd x &&", variables set before it,
// "sudo", "timeout 60"… (Only the first line: summaries carry no more.)
function mainCommand(line) {
  const parts = String(line).split(/\s*(?:&&|\|\||;)\s*/).map(p => p.trim()).filter(Boolean)
  const strip = p => p.replace(/^(?:(?:[A-Z_][A-Z0-9_]*=\S*|sudo|env|time|nice|timeout\s+\S+|command)\s+)+/, '')
  return parts.map(strip).find(p => !/^(?:cd|export|source|\.|set|pushd|popd|true)\b/.test(p)) ?? strip(parts[0] ?? '')
}
// (A loop or a condition says nothing of what runs inside it.)
const program = cmd => {
  const word = (mainCommand(cmd).split(/\s+/)[0] ?? '').split('/').pop().slice(0, 40)
  return /^(?:for|while|until|if|case|do|then|\{|\(|\[\[?|function)$/.test(word) ? '' : word
}

export function commandPhrase(line) {
  const cmd = mainCommand(line)
  for (const [test, say] of COMMANDS) if (test(cmd)) return say(cmd)
  // (Tests, a commit or a push anywhere in the line: "npm test | tail".)
  for (const [test, say] of COMMANDS.slice(0, 3)) if (test(String(line))) return say(String(line))
  return null
}

const fileName = summary => String(summary ?? '').replace(/\s+\([^)]*\)$/, '').split('/').filter(Boolean).pop() ?? ''
const squadraTool = (tool, summary) => {
  const to = /^chat_id: (.+)$/.exec(summary)?.[1] ?? ''
  switch (tool) {
    case 'reply': return to ? T.nowReply(to) : T.nowWriting
    case 'ask_user': return T.nowAsk
    case 'tell_user': return T.nowTell
    case 'update_plan': return T.nowPlan
    case 'ping': return T.nowPing
    case 'edit_inbox': return T.nowEditInbox
    case 'download_attachment': return T.nowDownload
    default: return null
  }
}

// tool: what the server says it runs ({ name, summary, what }).
export function nowPhrase(tool) {
  const name = String(tool?.name ?? '')
  const sum = String(tool?.summary ?? '')
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      // (A command that touches secrets: not even its name is sent.)
      if (/^command … \(/.test(sum)) return T.nowSecretCommand
      return commandPhrase(sum) ?? (tool?.what || (program(sum) ? T.nowRun(program(sum)) : T.nowRunSome))
    case 'Read': return T.nowRead(fileName(sum))
    case 'Write': return T.nowWrite(fileName(sum))
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return T.nowEdit(fileName(sum))
    case 'Grep': {
      const m = /^"(.*)"(?: in (.+?))?(?: \([^)]*\))?$/.exec(sum)
      return m ? T.nowSearch(m[1].slice(0, 60), m[2] ? fileName(m[2]) : '') : T.nowSearch(sum.slice(0, 60), '')
    }
    case 'Glob': return T.nowFindFiles(sum.split(' in ')[0].slice(0, 60))
    case 'WebFetch': return T.nowFetch(hostOf(sum) || sum.slice(0, 60))
    case 'WebSearch': return T.nowWebSearch(sum.slice(0, 80))
    case 'Task':
    case 'Agent': return T.nowAgent(sum.replace(/^[^:]*:\s*/, '').slice(0, 100))
    case 'TodoWrite': return T.nowTodos
    case 'Skill': return T.nowSkill(sum.slice(0, 60))
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return (mcp[1] === 'squadra' || mcp[1].endsWith('_squadra') ? squadraTool(mcp[2], sum) : null) ?? T.nowMcp(mcp[2].replace(/_/g, ' '), mcp[1].replace(/^plugin_[^_]+_/, ''))
  return name ? T.nowTool(name) : T.tool
}
