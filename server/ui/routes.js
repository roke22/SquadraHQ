// What an address in the dashboard points to. (Pure: the back button reads
// the ones it came from with it too.)

export const dec = v => { try { return decodeURIComponent(v) } catch { return v } }

// Names in the address are only ever session names and machine ids: any
// other text (a crafted link) goes to the main view, never into the header.
const ROUTE_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ROUTE_ID = /^[A-Za-z0-9_-]{1,64}$/
export function parseRoute(hash) {
  // The inbox is home: what needs you comes first.
  if (hash === '' || hash === '#' || hash === '#/' || hash === '#/inbox') return { view: 'inbox' }
  // One entry of it picked: a question or result (i12), a permission (p<name>), a name to approve (a<name>).
  // What is done is its own tab, with its own entries.
  if (hash === '#/inbox/done') return { view: 'inbox', tab: 'done' }
  if (hash === '#/inbox/running') return { view: 'inbox', tab: 'running' }
  const ib = hash.match(/^#\/inbox\/(done\/)?([ipa][A-Za-z0-9_-]{1,64})$/)
  if (ib) return ib[1] ? { view: 'inbox', tab: 'done', item: ib[2] } : { view: 'inbox', item: ib[2] }
  if (hash === '#/teams') return { view: 'teams' }
  // The task boards; one of them, with a task open beside it (or a new one).
  if (hash === '#/boards') return { view: 'boards' }
  if (hash === '#/usage') return { view: 'usage' }
  const bd = hash.match(/^#\/b\/(\d{1,9})(?:\/(new|[A-Za-z][A-Za-z0-9]{0,5}-\d{1,9}))?$/)
  if (bd) return { view: 'board', board: Number(bd[1]), ...(bd[2] ? { task: bd[2] } : {}) }
  if (hash === '#/new') return { view: 'newteam' }
  if (hash === '#/mosaic') return { view: 'mosaic' }
  if (hash === '#/archived') return { view: 'archived' }
  if (hash === '#/hosts') return { view: 'hosts' }
  if (hash === '#/hosts/new') return { view: 'addmachine' }
  if (hash === '#/c') return { view: 'leads' }
  if (hash === '#/org') return { view: 'org' }
  // A team: its page, or every session of it live.
  const ql = hash.match(/^#\/q\/([^/]+)\/live$/)
  if (ql) return ROUTE_NAME.test(dec(ql[1])) ? { view: 'mosaic', squad: dec(ql[1]) } : { view: 'teams' }
  const q = hash.match(/^#\/q\/([^/]+)$/)
  if (q) return ROUTE_NAME.test(dec(q[1])) ? { view: 'team', squad: dec(q[1]) } : { view: 'teams' }
  const h = hash.match(/^#\/h\/(.+)$/)
  if (h) return ROUTE_ID.test(dec(h[1])) ? { view: 'hosts', host: dec(h[1]) } : { view: 'hosts' }
  const t = hash.match(/^#\/t\/([^/]+)\/(.+)$/)
  if (t) return ROUTE_ID.test(dec(t[1])) && ROUTE_NAME.test(dec(t[2])) ? { view: 'terminal', host: dec(t[1]), term: dec(t[2]) } : { view: 'hosts' }
  // A session: its live terminal when it has one (opened on a machine
  // from here), else its chat; ".../chat" always the chat.
  const sc = hash.match(/^#\/s\/([^/]+)\/chat$/)
  if (sc) return ROUTE_NAME.test(dec(sc[1])) ? { view: 'session', name: dec(sc[1]), chat: true } : { view: 'mosaic' }
  const m = hash.match(/^#\/s\/(.+)$/)
  return m && ROUTE_NAME.test(dec(m[1])) ? { view: 'session', name: dec(m[1]) } : { view: 'mosaic' }
}
