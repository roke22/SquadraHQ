// A worker's tasks, seen through the hooks.
//
// Each message from a worker's coordinator is a task (unless it says fyi), and
// every task ends with a final report to it: reply with report done, blocked,
// failed or question. That it started needs no message: when the task starts
// a turn, the plugin puts 👀 on it (a reaction wakes nobody). That it ends is
// not left to Claude: the Stop hook keeps the turn from ending without the
// report, once; if it still ends without one, the coordinator is told.
// Only tasks Claude has seen count: one that arrives after the turn's last
// step waits for the next turn, and asking for its report now would only get
// the previous report again.

import { log, S, call } from '../core/index.js'

export const pendingTasks = s => [...s.tasks].filter(([, t]) => t.started).map(([id]) => id)

export const channelIds = prompt => [...String(prompt).matchAll(/<channel\b([^>]*)>/g)].map(m => Number(/\bmessage_id="(\d+)"/.exec(m[1])?.[1]))

// A prompt about to be sent (UserPromptSubmit), or the transcript showing a
// message reached Claude in a turn already going: the tasks it brings start now.
export function tasksStarting(s, ids) {
  if (s.role !== 'worker' || !s.tasks.size) return
  for (const id of ids) {
    const t = s.tasks.get(id)
    // (Only a task this plugin delivered: a tag typed in a prompt counts for nothing.)
    if (!t || t.started) continue
    t.started = true
    void call('setMessageReaction', { chat_id: s.coordinator, message_id: id, reaction: [{ type: 'emoji', emoji: '👀' }] }, { s }).catch(() => {})
  }
}

// A final report (replyTo: the message it answers, if any) closes the tasks it
// covers: all those Claude has seen or, when it answers a message, those up to
// that one. A later task stays open: Claude may have left it undone
// (Claude Code tells it to treat a message that arrives during a turn as
// information only), and its coordinator is waiting for it. Returns what is
// left, for the answer to tell Claude.
export function closeTasks(s, replyTo) {
  let closed = 0
  for (const id of pendingTasks(s)) if (replyTo == null || id <= replyTo) { s.tasks.delete(id); closed++ }
  // (Only for one that closed something: it can't keep the turn going for ever.)
  if (closed) s.stopAsked = false
  if (!pendingTasks(s).length) { clearTimeout(s.backgroundTimer); s.backgroundTimer = null }
  return pendingTasks(s)
}

// The turn is about to end (Stop hook): a reason to go on, or '' to let it.
// (It can't go on forever: it asks again only after a report or a new task.)
// background: something in this session still runs (perhaps not for this task:
// a dev server, say), and a turn may follow when it ends. Nothing is asked yet,
// but its coordinator isn't left waiting in silence: told after a while.
const BACKGROUND_NOTICE_MS = Number(process.env.SQUADRA_BACKGROUND_NOTICE_MS) || 10 * 60_000
// A coordinator ending its turn asking the user for something in this chat,
// which they don't read: once per turn, a reminder to use the inbox. (A guess
// from its last words; only ever a reminder.)
const ASKS_USER_RE = /necesito que (?:me )?(?:decidas|confirmes|digas|hagas|apruebes)|confirm(?:es|a) o decid|decid(?:e|es|as|an)\s+t[uú]|queda(?:n)? pendientes? (?:para ti|de ti|de una persona)|pendientes? para ti|decide[sn]? t[uú]|tu (?:ok|confirmaci[oó]n|decisi[oó]n|aprobaci[oó]n)|dime (?:qu[eé]|si)|¿(?:quieres|prefieres|apruebas|hago|subo|lo hago|seguimos|procedo)|need you to (?:decide|confirm)|your (?:call|decision|approval|ok)|do you want me to|should i (?:go ahead|proceed|deploy|apply)|let me know (?:if|whether|which)/i
// Words that point at the inbox: what it says is already there, not asked here.
const MENTIONS_INBOX_RE = /\binbox\b|\bbandeja\b|\bbuz[oó]n\b/i
function chatAskHint(s, lastText) {
  if (S !== s || s.role !== 'coordinator' || s.inboxThisTurn || s.chatAskHinted) return ''
  // (With a question of its own still open in the inbox, "your decision" is most likely that one.)
  if (s.openAsks?.size) return ''
  // Its plan says a task waits on the user, and nothing is asked in their inbox.
  if (s.planWaiting) {
    s.chatAskHinted = true
    return `[Squadra] Before you finish: your plan has ${s.planWaiting === 1 ? 'a task' : `${s.planWaiting} tasks`} waiting on the user, but no open question in their inbox, and they read their inbox, not this conversation. Ask each decision with its own ask_user (with its options and the one you recommend), then end your turn. If they already answered, update the plan instead (help("inbox")).`
  }
  // (Before any order, "tell me what you want" is it being ready, not a decision:
  // nothing to put in the user's inbox.)
  if (!s.ordered) return ''
  if (MENTIONS_INBOX_RE.test(String(lastText ?? ''))) return ''
  const hit = ASKS_USER_RE.exec(String(lastText ?? ''))
  if (!hit) return ''
  s.chatAskHinted = true
  return `[Squadra] Before you finish: you are asking the user for something here ("${hit[0]}"), but they read their inbox, not this conversation. Put each decision that is theirs in its own ask_user (with its options and what you recommend), and what they should know or do in tell_user, then end your turn (help("inbox")).`
}

// A coordinator's first order: something typed in its terminal (by the user,
// or their answer from the inbox) or a request from a linked coordinator. Its
// workers' messages and the server's notices are not one.
const CHANNEL_BLOCK_RE = /<channel\b[^>]*>[\s\S]*?<\/channel>/g
export function orderSeen(s, prompt) {
  if (s.role !== 'coordinator' || s.ordered) return
  const text = String(prompt ?? '')
  if (text.replace(CHANNEL_BLOCK_RE, '').trim() || /<channel\b[^>]*\b(?:linked="true"|kind="squadra_board")/.test(text)) s.ordered = true
}

// The user's answer from the inbox is typed in as a prompt ("Inbox #12 (…), the
// user answers…" or "…dismissed it…"): that question is no longer open.
export function inboxAnswered(s, prompt) {
  if (s.role !== 'coordinator' || !s.openAsks?.size) return
  for (const m of String(prompt).matchAll(/(?:^|\n)\s*Inbox #(\d+) \(/g)) s.openAsks.delete(Number(m[1]))
}

export async function stopCheck(s, { background = false, lastText = '' } = {}) {
  const hint = chatAskHint(s, lastText)
  if (hint) return hint
  if (S !== s || s.role !== 'worker') return ''
  const ids = pendingTasks(s)
  if (!ids.length) return ''
  if (background) {
    s.backgroundTimer ??= setTimeout(() => {
      s.backgroundTimer = null
      const open = pendingTasks(s)
      if (S !== s || !open.length) return
      void call('sendMessage', {
        chat_id: s.coordinator,
        text: `⏳ (automatic) ${s.name} ended its turn with work still running in the background, and has not reported on your task ${open.map(i => `#${i}`).join(', ')}. Ask it how it goes, or look at its terminal.`,
        squadra_auto: true,
      }, { s }).catch(err => log(`background notice failed: ${err.message}`))
    }, BACKGROUND_NOTICE_MS)
    s.backgroundTimer.unref?.()
    return ''
  }
  clearTimeout(s.backgroundTimer)
  s.backgroundTimer = null
  const list = ids.map(i => `#${i}`).join(', ')
  if (!s.stopAsked) {
    s.stopAsked = true
    return `[Squadra] Before you finish: your coordinator "${s.coordinator}" is waiting for your final report on its task ${list}. Send it now with ONE reply to chat_id "${s.coordinator}" whose report argument is set to "done", "blocked", "failed" or "question" (that argument is what makes it a report: writing "done" in the text doesn't count), and in its text what you did or what stopped you, and only the decisions that matter, in up to 3 lines. It is required: nobody can waive it, not even your coordinator.`
  }
  // Asked once already: the turn ends, and the coordinator is told.
  for (const id of ids) s.tasks.delete(id)
  s.stopAsked = false
  await call('sendMessage', {
    chat_id: s.coordinator,
    text: `⚠️ (automatic) ${s.name} ended its turn without a final report on your task ${list}. Ask it how it went, or look at its terminal.`,
    squadra_auto: true,
  }, { s }).catch(err => log(`missing-report notice failed: ${err.message}`))
  return ''
}
