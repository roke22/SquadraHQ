// What was said, while the inbox is read aloud: a command, an option (with
// whatever detail follows it), or an answer in the user's own words. In
// Spanish and in English alike, whatever the dashboard's language: people mix.
// (No DOM here: the tests load it on its own.)

// Lower case, without accents or punctuation around the words.
export const normalize = text => String(text ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿¡!?.,;:"«»()]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// Said on their own, these steer the reading instead of answering.
const COMMANDS = {
  stop: ['para', 'parar', 'salir', 'sal', 'cuelga', 'colgar', 'termina', 'terminar', 'fin', 'stop', 'exit', 'quit', 'hang up', 'end'],
  next: ['siguiente', 'salta', 'saltar', 'saltala', 'luego', 'despues', 'mas tarde', 'pasa', 'next', 'skip', 'later'],
  repeat: ['repite', 'repitelo', 'repitela', 'otra vez', 'como', 'que', 'repeat', 'again', 'say again', 'what'],
  done: ['hecho', 'leido', 'entendido', 'visto', 'done', 'read', 'got it', 'seen'],
  dismiss: ['descarta', 'descartar', 'descartala', 'dismiss'],
}
const YES = ['si', 'vale', 'envia', 'enviala', 'envialo', 'de acuerdo', 'ok', 'okay', 'correcto', 'eso es', 'adelante', 'yes', 'yeah', 'yep', 'send', 'send it', 'sure', 'correct', 'go ahead']
const NO = ['no', 'cambia', 'cambiar', 'cambialo', 'espera', 'nope', 'change', 'change it', 'wait']

// The option's number, said as a word or a digit.
const NUMBERS = [
  ['1', 'uno', 'una', 'primera', 'primero', 'one', 'first'],
  ['2', 'dos', 'segunda', 'segundo', 'two', 'second'],
  ['3', 'tres', 'tercera', 'tercero', 'three', 'third'],
  ['4', 'cuatro', 'cuarta', 'cuarto', 'four', 'fourth'],
  ['5', 'cinco', 'quinta', 'quinto', 'five', 'fifth'],
  ['6', 'seis', 'sexta', 'sexto', 'six', 'sixth'],
]
const NUMBER_OF = new Map(NUMBERS.flatMap((words, n) => words.map(w => [w, n])))
// Words before the choice ("la dos", "opción 2", "the second one", "number three").
const LEAD = new Set(['la', 'el', 'lo', 'opcion', 'numero', 'quiero', 'elijo', 'option', 'number', 'the', 'choose', 'pick', 'i'])
const AFTER = new Set(['one', 'option', 'opcion'])
const RECOMMENDED = [['recomendada'], ['recomendado'], ['que', 'recomiendas'], ['que', 'recomienda'], ['recommended'], ['what', 'you', 'recommend']]
// Words that only join the detail to the choice ("la dos, y que sea el lunes").
const JOINERS = new Set(['y', 'e', 'pero', 'con', 'and', 'but', 'with'])
const ARTICLES = new Set(['una', 'uno', 'one'])

// yes / no / null, for the question "do I send it?"
export function yesNo(text) {
  const t = normalize(text)
  if (YES.includes(t) || YES.some(w => t.startsWith(`${w} `))) return true
  if (NO.includes(t) || NO.some(w => t.startsWith(`${w} `))) return false
  return null
}

// { kind: 'command', cmd } | { kind: 'option', n, detail } | { kind: 'free', text } | { kind: 'empty' }
// The detail and the free text keep what was said as it was said, only trimmed.
export function parseUtterance(text, { options = 0, recommended = -1 } = {}) {
  const said = String(text ?? '').trim()
  const t = normalize(said)
  if (!t) return { kind: 'empty' }
  for (const [cmd, words] of Object.entries(COMMANDS)) if (words.includes(t)) return { kind: 'command', cmd }
  if (options) {
    // Each word as said, with how it reads (punctuation alone is no word).
    const words = said.split(/\s+/).map(raw => ({ raw, n: normalize(raw) })).filter(w => w.n)
    let i = 0
    while (i < words.length && LEAD.has(words[i].n)) i++
    let n = NUMBER_OF.get(words[i]?.n)
    let next = i + 1
    // ("una cosa más", "one more thing": an article, not a choice, unless it is introduced or alone.)
    if (ARTICLES.has(words[i]?.n) && i === 0 && words.length > 1 && !JOINERS.has(words[1].n) && !AFTER.has(words[1].n) && !/[,.;:]$/.test(words[0].raw)) n = null
    if (n == null && recommended >= 0) {
      const p = RECOMMENDED.find(p => p.every((w, k) => words[i + k]?.n === w))
      if (p) { n = recommended; next = i + p.length }
    }
    if (n != null && n < options) {
      if (AFTER.has(words[next]?.n)) next++
      return { kind: 'option', n, detail: tidy(words.slice(next)) }
    }
  }
  return { kind: 'free', text: said }
}

// What follows the choice, without the words that only join it.
function tidy(words) {
  let k = 0
  while (k < words.length && JOINERS.has(words[k].n)) k++
  return words.slice(k).map(w => w.raw).join(' ').replace(/^[\s,.;:—–-]+/, '').trim()
}

// Text to be read aloud: no markdown, no links spelled out, no long paths.
export function speakable(text, { link = 'a link', path = 'a file' } = {}) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, link)
    .replace(/(?:^|\s)(?:\/[\w.-]+){2,}\/?/g, ` ${path}`)
    .replace(/\*\*|__|[*_]/g, '')
    .replace(/[#>|]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
