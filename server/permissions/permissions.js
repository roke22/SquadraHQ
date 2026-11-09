import { randomBytes } from 'node:crypto'
import { bad, now, oneLine, cleanText } from '../platform/index.js'

// Permission profiles: what the agents of a team may do without asking,
// written in the dashboard and turned into Claude Code's own permission rules
// (allow, ask, deny), which its machine passes to each session it opens from
// the dashboard (claude --settings). Claude Code enforces them, not the model;
// what the user wrote in their own words goes to the session's system prompt
// too, as the reason. Each machine decides how far the dashboard may go
// ("permissions_from_dashboard" in its settings.json): squadra-host checks
// every rule again and refuses what it doesn't take.
//
// A profile is a few capabilities, each allowed, always asked or forbidden
// (left out: Claude Code decides, as without a profile), and rules of its own.

// What each capability is, as rules. deny: what forbidding it denies (when
// it isn't the same list).
export const CAPABILITIES = {
  edit: { rules: ['Edit(./**)'], deny: ['Edit(**)'] },
  tests: {
    rules: [
      'Bash(npm test *)', 'Bash(npm run test *)', 'Bash(npm run build *)', 'Bash(npm run lint *)', 'Bash(pnpm test *)', 'Bash(pnpm run test *)',
      'Bash(yarn test *)', 'Bash(npx vitest *)', 'Bash(npx jest *)', 'Bash(npx playwright test *)', 'Bash(node --test *)', 'Bash(pytest *)',
      'Bash(python -m pytest *)', 'Bash(python3 -m pytest *)', 'Bash(go test *)', 'Bash(go build *)', 'Bash(cargo test *)', 'Bash(cargo build *)',
      'Bash(make test *)', 'Bash(php artisan test *)', 'Bash(vendor/bin/phpunit *)', 'Bash(composer test *)', 'Bash(dotnet test *)', 'Bash(mvn test *)',
    ],
  },
  install: {
    rules: [
      'Bash(npm install *)', 'Bash(npm ci *)', 'Bash(pnpm install *)', 'Bash(pnpm add *)', 'Bash(yarn install *)', 'Bash(yarn add *)',
      'Bash(pip install *)', 'Bash(pip3 install *)', 'Bash(composer install *)', 'Bash(composer require *)', 'Bash(bundle install *)',
      'Bash(go mod download *)', 'Bash(cargo fetch *)',
    ],
  },
  commit: {
    rules: [
      'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)',
      'Bash(git restore *)', 'Bash(git stash *)', 'Bash(git switch *)', 'Bash(git branch *)',
    ],
    deny: ['Bash(git commit *)'],
  },
  push: { rules: ['Bash(git push *)'] },
  history: { rules: ['Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git push --force-with-lease *)', 'Bash(git reset --hard *)', 'Bash(git clean *)', 'Bash(git rebase *)'] },
  remove: { rules: ['Bash(rm *)', 'Bash(rmdir *)', 'Bash(git rm *)'] },
  web: { rules: ['WebFetch', 'WebSearch'] },
  docker: { rules: ['Bash(docker *)', 'Bash(docker-compose *)'] },
  sudo: { rules: ['Bash(sudo *)'] },
}
export const CAPABILITY_IDS = Object.keys(CAPABILITIES)
const STATES = ['allow', 'ask', 'deny']

// Two to start from, as they are (a copy can be changed).
export const BUILTIN_PROFILES = [
  {
    id: 'readonly', builtin: true, name: 'Read only', notes: '',
    caps: { edit: 'deny', install: 'deny', commit: 'deny', push: 'deny', history: 'deny', remove: 'deny', docker: 'deny', sudo: 'deny' },
    extra: { allow: [], ask: [], deny: [] },
  },
  {
    id: 'dev', builtin: true, name: 'Development', notes: '',
    caps: { edit: 'allow', tests: 'allow', install: 'allow', commit: 'allow', push: 'ask', history: 'deny', remove: 'ask', sudo: 'deny' },
    extra: { allow: [], ask: [], deny: [] },
  },
]

// A rule as Claude Code writes them: a tool, and what it applies to. (Its
// machine checks each one again, with what it takes from the dashboard.)
export const RULE_RE = /^(?:(?:Bash|PowerShell|Read|Edit|Write|NotebookEdit|WebFetch|WebSearch|Glob|Grep|Agent|Skill)(?:\((?:[^()\x00-\x1f\x7f]|\([^()\x00-\x1f\x7f]*\)){1,300}\))?|mcp__[A-Za-z0-9_-]+(?:__(?:[A-Za-z0-9_-]+|\*))?)$/
const RULES_MAX = 100
const NOTES_MAX = 2000
const PROFILES_MAX = 50
const ID_RE = /^(?:readonly|dev|p_[A-Za-z0-9_-]{8,24})$/
export const NONE = 'none' // a session that follows no profile, whatever its team's

export function createPermissions(platform, { sessions }) {
  const { db, broadcast } = platform
  const { NAME_RE } = sessions

  db.exec(`CREATE TABLE IF NOT EXISTS permission_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT, caps TEXT NOT NULL, extra TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
  for (const [table, column] of [['squads', 'profile'], ['identities', 'permission_profile']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
  }

  const parse = (s, dflt) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : dflt } catch { return dflt } }
  function listProfiles() {
    const own = db.prepare('SELECT * FROM permission_profiles ORDER BY name COLLATE NOCASE').all()
      .map(r => ({ id: r.id, builtin: false, name: r.name, notes: r.notes || '', caps: parse(r.caps, {}), extra: { allow: [], ask: [], deny: [], ...parse(r.extra, {}) }, updated_at: r.updated_at }))
    return [...BUILTIN_PROFILES, ...own]
  }
  const profileById = id => listProfiles().find(p => p.id === id) ?? null

  // What the dashboard sends, checked: anything unexpected is refused.
  function cleanRules(list, what) {
    if (list == null) return []
    if (!Array.isArray(list)) throw bad(`${what} must be a list of rules`)
    const out = []
    for (const raw of list) {
      const r = typeof raw === 'string' ? raw.trim() : ''
      if (!r) continue
      if (!RULE_RE.test(r)) throw bad(`"${cleanText(r.slice(0, 80))}" is not a Claude Code permission rule (e.g. Bash(make deploy *), Edit(./docs/**), WebFetch(domain:example.com))`)
      if (!out.includes(r)) out.push(r)
    }
    return out
  }
  function cleanProfile(p) {
    const name = oneLine(p.name, 40)
    if (!name) throw bad('the profile needs a name')
    const notes = typeof p.notes === 'string' ? cleanText(p.notes.slice(0, NOTES_MAX * 2)).trim().slice(0, NOTES_MAX) : ''
    const caps = {}
    for (const [k, v] of Object.entries(p.caps && typeof p.caps === 'object' ? p.caps : {})) {
      if (!CAPABILITY_IDS.includes(k)) throw bad(`unknown capability "${cleanText(String(k).slice(0, 40))}"`)
      if (v == null || v === '' || v === 'default') continue
      if (!STATES.includes(v)) throw bad(`${k}: must be allow, ask or deny`)
      caps[k] = v
    }
    const e = p.extra && typeof p.extra === 'object' ? p.extra : {}
    const extra = { allow: cleanRules(e.allow, 'allow'), ask: cleanRules(e.ask, 'ask'), deny: cleanRules(e.deny, 'deny') }
    if (extra.allow.length + extra.ask.length + extra.deny.length > RULES_MAX) throw bad(`at most ${RULES_MAX} rules of its own`)
    return { name, notes, caps, extra }
  }

  function saveProfile(p) {
    const id = p.id == null || p.id === '' ? null : String(p.id)
    if (id && !ID_RE.test(id)) throw bad('invalid profile id')
    if (id && BUILTIN_PROFILES.some(b => b.id === id)) throw bad('the built-in profiles are kept as they are: make a copy to change it')
    const v = cleanProfile(p)
    const others = listProfiles().filter(x => x.id !== id)
    if (others.some(x => x.name.toLowerCase() === v.name.toLowerCase())) throw bad(`there is already a profile called "${v.name}"`)
    if (id && !db.prepare('SELECT 1 FROM permission_profiles WHERE id = ?').get(id)) throw bad('profile not found')
    if (!id && db.prepare('SELECT COUNT(*) AS n FROM permission_profiles').get().n >= PROFILES_MAX) throw bad(`at most ${PROFILES_MAX} profiles`)
    const newId = id ?? `p_${randomBytes(9).toString('base64url')}`
    db.prepare(`INSERT INTO permission_profiles (id, name, notes, caps, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, notes = excluded.notes, caps = excluded.caps, extra = excluded.extra, updated_at = excluded.updated_at`)
      .run(newId, v.name, v.notes || null, JSON.stringify(v.caps), JSON.stringify(v.extra), now())
    broadcastAll()
    return profileById(newId)
  }
  function deleteProfile(p) {
    const id = String(p.id ?? '')
    if (BUILTIN_PROFILES.some(b => b.id === id)) throw bad('the built-in profiles cannot be deleted')
    if (!db.prepare('DELETE FROM permission_profiles WHERE id = ?').run(id).changes) throw bad('profile not found')
    // (Teams and sessions that had it follow none now, as before it existed.)
    db.prepare('UPDATE squads SET profile = NULL WHERE profile = ?').run(id)
    db.prepare('UPDATE identities SET permission_profile = NULL WHERE permission_profile = ?').run(id)
    broadcastAll()
    return { id, deleted: true }
  }

  // Which profile a team follows (its coordinator's name), or a session on
  // its own (NONE: none, whatever its team's; null: its team's).
  function assignProfile(p) {
    const profile = p.profile == null || p.profile === '' ? null : String(p.profile)
    if (profile && profile !== NONE && !profileById(profile)) throw bad('profile not found')
    if (p.coordinator != null) {
      const coordinator = String(p.coordinator)
      if (!NAME_RE.test(coordinator)) throw bad('invalid coordinator')
      if (profile === NONE) throw bad('a team follows a profile or none (leave it empty)')
      db.prepare(`INSERT INTO squads (coordinator, profile, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(coordinator) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`).run(coordinator, profile, now())
      broadcast('profiles', state())
      return { coordinator, profile }
    }
    const name = String(p.session ?? '')
    if (!NAME_RE.test(name) || !db.prepare('SELECT 1 FROM identities WHERE name = ?').get(name)) throw bad('session not found')
    db.prepare('UPDATE identities SET permission_profile = ? WHERE name = ?').run(profile, name)
    broadcast('profiles', state())
    return { session: name, profile }
  }

  // What the dashboard shows: the profiles, and who follows which.
  function state() {
    return {
      profiles: listProfiles(),
      teams: Object.fromEntries(db.prepare('SELECT coordinator, profile FROM squads WHERE profile IS NOT NULL').all().map(r => [r.coordinator, r.profile])),
      sessions: Object.fromEntries(db.prepare('SELECT name, permission_profile FROM identities WHERE permission_profile IS NOT NULL').all().map(r => [r.name, r.permission_profile])),
    }
  }
  const broadcastAll = () => broadcast('profiles', state())

  // The profile a session opened from the dashboard follows: its own, else its
  // team's (a coordinator's own squad; a worker's coordinator's). null: none.
  function effectiveProfile(name, role, coordinator) {
    const own = db.prepare('SELECT permission_profile FROM identities WHERE name = ?').get(name)?.permission_profile ?? null
    if (own === NONE) return null
    const team = role === 'coordinator' ? name : role === 'worker' ? coordinator : null
    const id = own ?? (team ? db.prepare('SELECT profile FROM squads WHERE coordinator = ?').get(team)?.profile ?? null : null)
    return id ? profileById(id) : null
  }

  // A profile as Claude Code's rules (and its words, for the system prompt).
  // A capability forbidden wins over one allowed that shares a rule.
  function compile(profile) {
    if (!profile) return null
    const allow = [], ask = [], deny = []
    const add = (list, rules) => { for (const r of rules) if (!list.includes(r)) list.push(r) }
    for (const id of CAPABILITY_IDS) {
      const state = profile.caps?.[id]
      const cap = CAPABILITIES[id]
      if (state === 'allow') add(allow, cap.rules)
      else if (state === 'ask') add(ask, cap.rules)
      else if (state === 'deny') add(deny, cap.deny ?? cap.rules)
    }
    add(allow, profile.extra?.allow ?? [])
    add(ask, profile.extra?.ask ?? [])
    add(deny, profile.extra?.deny ?? [])
    return { id: profile.id, name: profile.name, allow, ask, deny, notes: profile.notes || '' }
  }

  return { listProfiles, saveProfile, deleteProfile, assignProfile, permissionsState: state, effectiveProfile, compile, NONE }
}
