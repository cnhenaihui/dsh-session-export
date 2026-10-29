/**
 * Shared helpers: session id normalisation, time formatting, markdown escaping,
 * truncation and a small stable hash.
 */

const SESSION_PREFIX = 'session-'

/**
 * DSH stores two shapes of the same logical session id:
 *   legacy:  "session-67a8d807-4a4a-..."   (also used by parentSession)
 *   current: "cc8a1db3-13f7-..."
 * Both must resolve to the same session, so every id that leaves or enters this
 * plugin goes through these helpers.
 */
export function stripSessionPrefix(id) {
  const text = String(id ?? '').trim()
  return text.startsWith(SESSION_PREFIX) ? text.slice(SESSION_PREFIX.length) : text
}

export function bareSessionId(id) {
  return stripSessionPrefix(id)
}

/** All textual forms worth trying against a session lookup, most likely first. */
export function sessionIdVariants(id) {
  const bare = stripSessionPrefix(id)
  if (!bare) return []
  return [bare, SESSION_PREFIX + bare]
}

/** True when two ids describe the same session regardless of prefix shape. */
export function sameSession(a, b) {
  return bareSessionId(a) === bareSessionId(b)
}

export function pad2(n) {
  return String(n).padStart(2, '0')
}

/** Wall-clock rendering in an explicit timezone (defaults to the host zone). */
export function formatClock(ms, timeZone) {
  if (!Number.isFinite(ms)) return '??:??:??'
  const date = new Date(ms)
  if (!timeZone) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  }
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? '00'
    return `${pick('hour')}:${pick('minute')}:${pick('second')}`
  } catch {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  }
}

/** Full local date-time, used inside event headers. */
export function formatDateTime(ms, timeZone) {
  if (!Number.isFinite(ms)) return 'unknown'
  const date = new Date(ms)
  if (!timeZone) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? '00'
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
  } catch {
    return formatDateTime(ms)
  }
}

/** Offset-bearing ISO 8601 so the archive is unambiguous. */
export function formatIsoWithOffset(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const date = new Date(ms)
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, '0')}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** Filesystem/title-safe slug. Keeps CJK, drops path-hostile characters. */
export function slugify(input, maxLength = 60) {
  const text = String(input ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!text) return 'session'
  return text.length > maxLength ? text.slice(0, maxLength).replace(/[-.]+$/, '') : text
}

/** Escape text so arbitrary content cannot break out of a markdown structure. */
export function escapeInline(text) {
  return String(text ?? '').replace(/([\\`*_{}\[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ')
}

/**
 * Pick a fence longer than any run of backticks inside the payload so that
 * exported tool output cannot terminate the block early.
 */
export function fenceFor(content, language = '') {
  let longest = 0
  const text = String(content ?? '')
  const re = /`+/g
  let match
  while ((match = re.exec(text)) !== null) {
    if (match[0].length > longest) longest = match[0].length
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return { open: `${fence}${language}`, close: fence }
}

/** Render content inside a safe fenced block. */
export function fenced(content, language = '') {
  const { open, close } = fenceFor(content, language)
  const body = String(content ?? '')
  return `${open}\n${body}${body.endsWith('\n') ? '' : '\n'}${close}`
}

/** Collapsible section with a one-line summary. */
export function details(summary, body, open = false) {
  const head = open ? '<details open>' : '<details>'
  return `${head}\n<summary>${escapeInline(summary)}</summary>\n\n${body}\n\n</details>`
}

export function truncateText(text, maxChars) {
  const value = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false, originalChars: value.length }
  }
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return {
    text: `${value.slice(0, head)}\n\n…[已截断 ${value.length - maxChars} 字符]…\n\n${value.slice(-tail)}`,
    truncated: true,
    originalChars: value.length,
  }
}

/** Deterministic 32-bit hash, used to tie the two files to one snapshot. */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * DSH delivers harness context as extra `user/message` events (runtime context,
 * skill catalog, time samples, delegation hints). They are genuine events, so
 * raw.md keeps them, but they are not things the human said — the narrative
 * filters them out.
 */
const INJECTION_SIGNATURES = [
  /^Current runtime context\./,
  /^<system-reminder>/,
  /^Time sampled while preparing/,
  /^Browser time zone for this request:/,
  /^\[Thinking language\]/,
  /^The user configured the language of your thinking/,
  /^Approval prompts are disabled in this session/,
  /^Approval policy:/,
  /^Delegation depth for/,
  /^Your parent agent id is "/,
  /^Current DSH file policy:/,
  /^Current working directory:/,
  /^You are the Team Lead named/,
  /^Current DeepSeek Harness implementation checkout:/,
  /^Current DSH Web GUI URL:/,
  /^Elapsed since the preceding/,
  /^\[model changed:/,
]

export function isInjectedText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  return INJECTION_SIGNATURES.some((re) => re.test(trimmed))
}

/**
 * Auto-generated session titles occasionally contain characters from an
 * unrelated script (the title model mixes them in). Keep Han, Latin, digits,
 * and common punctuation so file names and headings stay clean.
 */
export function cleanTitle(title, fallback = 'session') {
  const text = String(title ?? '').trim()
  if (!text) return fallback
  const cleaned = text
    .replace(/[^\p{Script=Han}\p{Script=Latin}\p{N}\s\-_.·、，。：；！？（）()【】]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length >= 2 ? cleaned : fallback
}
