// What, in a task, may be the user's decision: data deleted, credentials, a
// deploy or publishing. A guess from the text (English and Spanish), only ever
// for a reminder at the moment it matters, never to refuse anything.
export const DECISION_RE = /\b(?:drop|truncate|delete\s+from|borra\w*|elimin\w*|migrati\w*|migraci[oó]n\w*|password\w*|contrase[ñn]a\w*|credential\w*|credencial\w*|secret\w*|api[\s_-]?keys?|claves?\s+de\s+(?:la\s+)?api|tokens?|deploy\w*|despleg\w*|desplieg\w*|publish\w*|publica[rd]?\w*|rollback|force[\s-]push)\b/i

export const decisionHit = text => DECISION_RE.exec(String(text ?? ''))?.[0] ?? null
