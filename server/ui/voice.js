// The inbox read aloud, and answered by voice: hands-free, for a phone.
// It reads each decision that can be answered from here, with its options,
// listens for the answer, says back what it understood and sends it only
// once the user says yes. Then what there is to know, which can be replied
// to or marked done. Everything runs in the browser: its speech recognition
// and its voices (Chrome on Android sends the audio to Google to recognise it:
// the user is told before the first time).

import { $ } from './dom.js'
import { T, LANG, LOCALE } from './i18n.js'
import { state, can, sessions } from './state.js'
import { esc } from './format.js'
import { postJson } from './machines.js'
import { alertBox } from './mosaic.js'
import { confirmDialog } from './dialogs.js'
import { replaceHash } from './back.js'
import { currentRoute } from './router.js'
import { cantAnswer } from './inbox.js'
import { icon } from './icons.js'
import { parseUtterance, yesNo, speakable } from './voice-parse.js'

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
const SPEECH_LANG = LANG === 'es' ? 'es-ES' : 'en-GB'
const CONSENT = 'pisha.voice-ok'
const HEARD_TRIES = 2 // silences in a row before moving on
// How fast it reads, as on a voice message: a tap on the chip, the next one.
// (Small steps: past 1.2 the voices get hard to follow.)
const RATES = [1, 1.1, 1.2]
const RATE_KEY = 'pisha.voice-rate'
let rate = (() => { try { const r = Number(localStorage.getItem(RATE_KEY)); return RATES.includes(r) ? r : 1 } catch { return 1 } })()
// (Said in words, normal, fast, faster: a number says little about a voice.)
const rateLabel = r => T.vRates[RATES.indexOf(r)] ?? `${r.toLocaleString(LOCALE)}×`

export const voiceSupported = () => !!Recognition && 'speechSynthesis' in window
export const voiceButton = () => (can('operator') ? `<button type="button" class="btn" data-voice aria-pressed="${!!run}">${icon('mic')}<span>${esc(run ? T.vStop : T.vListen)}</span></button>` : '')

let run = null // the reading going on: { stopped, utterance, recognition, lock }

// --- speaking and listening -------------------------------------------------

function voiceFor() {
  const voices = speechSynthesis.getVoices()
  return voices.find(v => v.lang === SPEECH_LANG) ?? voices.find(v => v.lang?.startsWith(LANG)) ?? null
}

// Said aloud; resolves when it ends, is cut short (a tap) or the reading stops.
// A new speed takes effect at once: the sentence it was in is said again, faster
// or slower (where it is going comes from the voice's word boundaries, when it
// gives them; if not, from the start).
function say(text) {
  if (!run || run.stopped) return Promise.resolve()
  show(text, 'speaking')
  return new Promise(resolve => {
    const from = start => {
      const u = new SpeechSynthesisUtterance(text.slice(start))
      u.lang = SPEECH_LANG
      u.rate = rate
      const v = voiceFor(); if (v) u.voice = v
      u.onboundary = e => { if (run) run.at = start + (e.charIndex ?? 0) }
      u.onend = u.onerror = () => {
        if (u.replaced) return
        if (run?.utterance === u) { run.utterance = null; run.again = null }
        resolve()
      }
      run.utterance = u
      run.at = start
      run.again = () => {
        u.replaced = true
        speechSynthesis.cancel()
        // (A moment for the voice to stop: some drop what is said right after a cancel.)
        setTimeout(() => { if (run && !run.stopped) from(sentenceStart(text, run.at ?? start)); else resolve() }, 60)
      }
      speechSynthesis.speak(u)
    }
    from(0)
  })
}
// Where the sentence that has position at begins.
function sentenceStart(text, at) {
  let s = 0
  for (const m of text.slice(0, at).matchAll(/[.?!…:]\s+/g)) s = m.index + m[0].length
  return s
}

// What the user says next ('' after a silence, or once the reading stops).
function listen() {
  if (!run || run.stopped) return Promise.resolve('')
  show('', 'listening')
  return new Promise(resolve => {
    const r = new Recognition()
    r.lang = SPEECH_LANG
    r.interimResults = true
    r.maxAlternatives = 1
    let heard = ''
    r.onresult = e => {
      heard = [...e.results].map(x => x[0].transcript).join(' ').trim()
      show(heard, 'listening')
    }
    r.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stop(T.vMicDenied) }
    r.onend = () => { if (run?.recognition === r) run.recognition = null; resolve(heard) }
    run.recognition = r
    try { r.start() } catch { resolve('') }
  })
}

// --- the bar at the bottom: what is said, what was heard ---------------------

function show(text, mode) {
  let bar = $('voiceBar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'voiceBar'
    bar.className = 'voice-bar'
    bar.setAttribute('role', 'status')
    bar.innerHTML = `<div class="voice-head"><span class="voice-mode"></span><button type="button" class="voice-speed" data-voicespeed></button></div>
      <button type="button" class="voice-say" data-voicecut><span class="voice-text"></span></button>
      <div class="voice-actions"><button type="button" class="btn" data-voicenext>${esc(T.vNext)}</button><button type="button" class="btn danger" data-voicestop>${esc(T.vStop)}</button></div>`
    document.body.appendChild(bar)
  }
  bar.dataset.mode = mode
  const label = mode === 'listening' ? T.vListening : mode === 'sending' ? T.vSending : T.vSpeaking
  bar.querySelector('.voice-mode').textContent = label
  bar.querySelector('.voice-text').textContent = text
  showRate(bar)
}
function showRate(bar = $('voiceBar')) {
  const b = bar?.querySelector('[data-voicespeed]')
  if (!b) return
  b.textContent = rateLabel(rate)
  b.setAttribute('aria-label', T.vSpeed(rateLabel(rate)))
}

// A tap while it speaks cuts it short; "next" skips what is being read.
document.addEventListener('click', e => {
  if (e.target.closest('[data-voicespeed]')) {
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    try { localStorage.setItem(RATE_KEY, String(rate)) } catch {}
    showRate()
    run?.again?.()
    return
  }
  if (e.target.closest('[data-voicecut]') && run?.utterance) { speechSynthesis.cancel(); return }
  if (e.target.closest('[data-voicenext]') && run) { run.skip = true; cutShort(); return }
  if (e.target.closest('[data-voicestop]')) { stop(); return }
  if (e.target.closest('[data-voice]')) { run ? stop() : start(); return }
})
function cutShort() {
  speechSynthesis.cancel()
  try { run?.recognition?.abort() } catch {}
}

// --- what is read ----------------------------------------------------------

// What can be done here: decisions answered from the dashboard, then notes.
// (A decision that has to be answered in its session is only mentioned.)
function queue(skipped) {
  const open = state.inbox.filter(i => !i.resolved_at && !skipped.has(i.id))
  const asks = open.filter(i => i.kind === 'ask').sort((a, b) => a.id - b.id)
  const tells = open.filter(i => i.kind === 'tell').sort((a, b) => a.id - b.id)
  return [...asks, ...tells]
}
const team = name => state.squadMeta.get(sessions.get(name)?.role === 'coordinator' ? name : sessions.get(name)?.coordinator)?.title || name
const clean = text => speakable(text, { link: T.vLink, path: T.vPath })
// (Each part ends as a sentence, so the voice pauses before the next.)
const sentence = text => (/[.?!…:]$/.test(text) ? text : `${text}.`)
const recIndexOf = i => {
  const rec = String(i.recommended ?? '').trim().toLowerCase()
  return rec ? i.options.findIndex(o => { const t = o.trim().toLowerCase(); return rec === t || (rec.startsWith(t) && /^[\s:.,;—–-]/.test(rec.slice(t.length))) }) : -1
}

function readAsk(i) {
  const rec = recIndexOf(i)
  const opts = i.options.map((o, n) => T.vOption(n + 1, clean(o))).join(' ')
  return [T.vAskFrom(i.session, team(i.session)), sentence(clean(i.text)), opts, rec >= 0 ? T.vRecommends(rec + 1) : '', i.options.length ? T.vHowAnswerOptions : T.vHowAnswer].filter(Boolean).join(' ')
}
const readTell = i => [T.vTellFrom(i.session, team(i.session)), sentence(clean(i.text)), cantAnswer(i) ? T.vHowDoneOnly : T.vHowTell].join(' ')

// "Stop" or "next" said where a yes or a no was expected: they still apply.
// true: it was one of them (and done).
async function steered(heard) {
  const p = parseUtterance(heard)
  if (p.kind !== 'command') return false
  if (p.cmd === 'stop') { stop(); return true }
  if (p.cmd === 'next') { if (run) run.skip = true; await say(T.vSkipped); return true }
  return false
}

// The answer read back, and sent only on a yes. true: sent.
async function confirmAndSend(i, answer, what) {
  await say(T.vConfirm(what))
  for (let k = 0; k < HEARD_TRIES && !run?.stopped && !run?.skip; k++) {
    const heard = await listen()
    if (await steered(heard)) return false
    const yn = yesNo(heard)
    if (yn === true) {
      show(what, 'sending')
      try {
        await postJson('/api/inbox/answer', { id: i.id, version: i.version, answer })
        await say(T.vSent)
        return true
      } catch (err) {
        await say(err.reason === 'changed' ? T.vChanged : T.vFailed(err.message))
        return false
      }
    }
    if (yn === false) { await say(T.vSayAgain); return false }
    await say(T.vYesOrNo)
  }
  return false
}

async function handle(i) {
  // Fresh from the inbox: it may have changed, or closed, while another was read.
  const now = () => state.inbox.find(x => x.id === i.id)
  replaceHash(`#/inbox/i${i.id}`)
  const ask = i.kind === 'ask'
  if (ask && cantAnswer(i)) { await say(`${T.vAskFrom(i.session, team(i.session))} ${sentence(clean(i.text))} ${T.vAnswerInSession}`); return }
  await say(ask ? readAsk(i) : readTell(i))
  let silences = 0
  while (run && !run.stopped && !run.skip) {
    const cur = now()
    if (!cur || cur.resolved_at) return
    if (cur.version !== i.version) { i = cur; await say(`${T.vChanged} ${ask ? readAsk(i) : readTell(i)}`); continue }
    const heard = await listen()
    if (!run || run.stopped || run.skip) return
    const p = parseUtterance(heard, { options: ask ? i.options.length : 0, recommended: ask ? recIndexOf(i) : -1 })
    if (p.kind === 'empty') {
      if (++silences >= HEARD_TRIES) { await say(T.vMovingOn); return }
      await say(T.vDidntHear); continue
    }
    silences = 0
    if (p.kind === 'command') {
      if (p.cmd === 'stop') return stop()
      if (p.cmd === 'next') return say(T.vSkipped)
      if (p.cmd === 'repeat') { await say(ask ? readAsk(i) : readTell(i)); continue }
      if (p.cmd === 'done' && !ask) {
        try { await postJson('/api/inbox/resolve', { id: i.id }); await say(T.vMarkedDone) } catch (err) { await say(T.vFailed(err.message)) }
        return
      }
      if (p.cmd === 'dismiss' && ask) {
        await say(T.vConfirmDismiss)
        const heard = await listen()
        if (await steered(heard)) return
        if (yesNo(heard) === true) {
          try { await postJson('/api/inbox/dismiss', { id: i.id }); await say(T.vDismissed) } catch (err) { await say(T.vFailed(err.message)) }
          return
        }
        await say(T.vSayAgain); continue
      }
    }
    if (!ask && cantAnswer(i)) { await say(T.vHowDoneOnly); continue }
    if (p.kind === 'option') {
      const choice = i.options[p.n]
      const answer = p.detail ? `${choice}. ${p.detail}` : choice
      if (await confirmAndSend(i, answer, T.vOptionSaid(p.n + 1, choice, p.detail))) return
      continue
    }
    // In their own words (also a command that doesn't apply here, as said).
    const text = p.kind === 'free' ? p.text : heard
    if (await confirmAndSend(i, text, T.vWordsSaid(text))) return
  }
}

// --- starting and stopping ---------------------------------------------------

async function start() {
  if (!window.isSecureContext) return alertBox(T.vNeedsHttps)
  if (!voiceSupported()) return alertBox(T.vUnsupported)
  let ok = false
  try { ok = localStorage.getItem(CONSENT) === '1' } catch {}
  if (!ok) {
    return confirmDialog({ title: T.vConsentTitle, text: esc(T.vConsent), confirm: T.vConsentOk, settles: true, run: async () => {
      try { localStorage.setItem(CONSENT, '1') } catch {}
      setTimeout(begin) // (after the dialog closes: its button was the gesture that lets it speak)
    } })
  }
  begin()
}

async function begin() {
  if (run) return
  run = { stopped: false, skip: false, utterance: null, recognition: null, lock: null }
  refreshButton()
  try { run.lock = await navigator.wakeLock?.request('screen') } catch {}
  const skipped = new Set()
  const first = queue(skipped)
  const asks = first.filter(i => i.kind === 'ask').length
  await say(first.length ? T.vStart(asks, first.length - asks) : T.vNothing)
  while (run && !run.stopped) {
    const next = queue(skipped)[0]
    if (!next) break
    skipped.add(next.id) // (read once each time round; what is left open stays open)
    run.skip = false
    await handle(next)
  }
  if (run && !run.stopped && first.length) await say(queue(new Set()).length ? T.vEndSome : T.vEnd)
  stop()
}

export function stop(why = '') {
  if (!run) return
  run.stopped = true
  cutShort()
  try { run.lock?.release() } catch {}
  run = null
  $('voiceBar')?.remove()
  refreshButton()
  if (why) alertBox(why)
}

function refreshButton() {
  for (const b of document.querySelectorAll('[data-voice]')) {
    b.setAttribute('aria-pressed', String(!!run))
    b.querySelector('span').textContent = run ? T.vStop : T.vListen
  }
}

// Leaving the inbox, or the page, ends it.
window.addEventListener('hashchange', () => { if (run && currentRoute().view !== 'inbox') stop() })
window.addEventListener('pagehide', () => stop())
