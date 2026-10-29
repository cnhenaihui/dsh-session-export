/**
 * Offline render test: rebuilds SessionLogSnapshots straight from the on-disk
 * v4 jsonl.zstd logs so the renderers can be exercised before the plugin is
 * installed into a live profile.
 *
 * Run: node test/render-test.mjs <sessions-dir> <out-dir> <root-session-id>
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { collectFleetSnapshot } from '../lib/collect.js'
import { createRedactor } from '../lib/redact.js'
import { renderRaw } from '../lib/render-raw.js'
import { renderSummary } from '../lib/render-summary.js'
import { bareSessionId, byteLength, fnv1a } from '../lib/util.js'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function decompressAll(buffer) {
  const starts = []
  for (let i = 0; i <= buffer.length - 4; i += 1) {
    if (
      buffer[i] === MAGIC[0] &&
      buffer[i + 1] === MAGIC[1] &&
      buffer[i + 2] === MAGIC[2] &&
      buffer[i + 3] === MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // A truncated final frame is expected while a session is still live.
    }
  }
  return { text: parts.join(''), frames: starts.length }
}

function loadSessionDir(dirPath) {
  const file = path.join(dirPath, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) return null
  const { text, frames } = decompressAll(fs.readFileSync(file))
  const lines = text.split('\n').filter((line) => line.trim())
  if (lines.length === 0) return null
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    return null
  }
  const events = []
  for (let i = 1; i < lines.length; i += 1) {
    try {
      events.push(JSON.parse(lines[i]))
    } catch {
      // skip malformed line
    }
  }
  return { header, events, frames, file }
}

const [, , sessionsDir, outDir, rootId] = process.argv
if (!sessionsDir || !outDir || !rootId) {
  console.error('usage: node test/render-test.mjs <sessions-dir> <out-dir> <root-session-id>')
  process.exit(2)
}

const loaded = []
for (const name of fs.readdirSync(sessionsDir)) {
  const full = path.join(sessionsDir, name)
  if (!fs.statSync(full).isDirectory()) continue
  const session = loadSessionDir(full)
  if (session) loaded.push({ dirName: name, ...session })
}

console.log(`loaded sessions: ${loaded.length}`)

const byBare = new Map()
for (const item of loaded) {
  byBare.set(bareSessionId(item.header.id), item)
  // Also index by directory name, which is the on-disk id shape.
  byBare.set(bareSessionId(item.dirName), item)
}

const ctx = {
  sessionQuery: {
    async listSessions() {
      return loaded.map((item) => ({ header: item.header, live: false, persisted: true }))
    },
    async readSession(id) {
      const bare = bareSessionId(String(id))
      const item = byBare.get(bare)
      if (!item) throw new Error(`not found: ${id}`)
      return {
        session: item.header,
        inheritedEventCount: 0,
        events: item.events,
      }
    },
    async listEvents() {
      return []
    },
  },
}

const snapshot = await collectFleetSnapshot(ctx, rootId, {})
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const makeRedactor = () =>
  createRedactor({
    enabled: true,
    home: process.env.USERPROFILE || process.env.HOME || '',
    cwd: snapshot.rootSession?.cwd || '',
  })

const exportId = `test-${fnv1a(String(snapshot.generatedAt))}`
snapshot.meta = { exportId }
snapshot.sessions = snapshot.sessions.map((s) => ({ ...s, rawFileName: 'test.raw.md' }))

const options = {
  includeReasoning: true,
  includeSystemPrompt: false,
  toolResultMaxChars: 6000,
  timeZone,
  rawFileName: 'test.raw.md',
  summaryFileName: 'test.summary.md',
}

const summaryRedactor = makeRedactor()
const summary = renderSummary(snapshot, {
  ...options,
  redact: summaryRedactor.redact,
  redactionReport: summaryRedactor.report,
})

const rawRedactor = makeRedactor()
const raw = renderRaw(snapshot, {
  ...options,
  redact: rawRedactor.redact,
  redactionReport: rawRedactor.report,
})

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'test.summary.md'), summary, 'utf8')
fs.writeFileSync(path.join(outDir, 'test.raw.md'), raw, 'utf8')

console.log('--- snapshot ---')
console.log('root:', snapshot.rootBare)
console.log('sessions:', snapshot.sessions.map((s) => `${s.displayName}(${s.bare.slice(0, 8)}) d${s.depth} ${s.eventCount}ev`).join(' | '))
console.log('total events:', snapshot.coverage.totalEvents)
console.log('warnings:', snapshot.warnings.length, snapshot.warnings)
console.log('--- output ---')
console.log('summary bytes:', byteLength(summary))
console.log('raw bytes:', byteLength(raw))
console.log('redaction summary:', JSON.stringify(summaryRedactor.report()))
console.log('redaction raw:', JSON.stringify(rawRedactor.report()))
