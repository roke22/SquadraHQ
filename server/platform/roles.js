// What a user is in a company, from less to more. (The table of what each can
// do is next to each action: see server/dashboard/dashboard.js.)
export const ROLES = ['observer', 'operator', 'manager', 'owner']
// The agents a session can run: Claude Code, Codex CLI or Grok CLI.
export const AGENTS = ['claude', 'codex', 'grok']
export const atLeast = (role, needed) => ROLES.includes(needed) && ROLES.indexOf(role) >= ROLES.indexOf(needed)
