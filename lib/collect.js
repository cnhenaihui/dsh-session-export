/**
 * Snapshot collection: locate the session tree, freeze every session's event log
 * once, and derive the per-session facts the renderers need.
 *
 * Everything here is read-only. The plugin never appends session events.
 */

import { bareSessionId, sessionIdVariants } from './util.js'

const READ_CONCURRENCY = 4

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function childrenIndex(records) {
  const children = new Map()
  for (const record of records) {
    const parent = record.header?.parentSession
    if (!parent) continue
    const parentBare = bareSessionId(parent)
    if (!children.has(parentBare)) children.set(parentBare, [])
    children.get(parentBare).push(bareSessionId(record.header.id))
  }
  for (const list of children.values()) list.sort()
  return children
}

/** Walk up parentSession links to the highest reachable ancestor. */
function findRoot(byBare, startBare) {
  const visited = new Set()
  let current = startBare
  let unresolvedParent = null
  let cycle = false
  for (;;) {
    if (visited.has(current)) {
      cycle = true
      break
    }
    visited.add(current)
    const record = byBare.get(current)
    const parent = record?.header?.parentSession
    if (!parent) break
    const parentBare = bareSessionId(parent)
    if (!byBare.has(parentBare)) {
      unresolvedParent = parentBare
      break
    }
    current = parentBare
  }
  return { root: current, unresolvedParent, cycle }
}

/** Breadth-first subtree walk, so a shared ancestor is never visited twice. */
function collectSubtree(byBare, rootBare) {
  const children = childrenIndex([...byBare.values()])
  const ordered = []
  const visited = new Set()
  const queue = [{ bare: rootBare, depth: 0 }]
  while (queue.length > 0) {
    const node = queue.shift()
    if (visited.has(node.bare)) continue
    visited.add(node.bare)
    ordered.push(node)
    for (const child of children.get(node.bare) ?? []) {
      if (!visited.has(child)) queue.push({ bare: child, depth: node.depth + 1 })
    }
  }
  return ordered
}

/** Read one session log, tolerating both id shapes and old-format failures. */
async function readOneLog(sessionQuery, bare, signal) {
  const attempts = []
  for (const variant of sessionIdVariants(bare)) {
    try {
      const snapshot = await sessionQuery.readSession(variant)
      if (snapshot && Array.isArray(snapshot.events)) {
        return { snapshot, usedId: variant, error: null, degraded: false }
      }
      attempts.push(`${variant}: 返回空快照`)
    } catch (error) {
      attempts.push(`${variant}: ${error?.message ?? String(error)}`)
    }
  }

  // Degraded path: metadata-only listing. Keeps the session visible in the
  // report even when its raw log cannot be replayed (e.g. migration-required).
  for (const variant of sessionIdVariants(bare)) {
    try {
      const events = await sessionQuery.listEvents(variant)
      if (Array.isArray(events)) {
        return {
          snapshot: {
            session: null,
            inheritedEventCount: 0,
            events,
            metadataOnly: true,
          },
          usedId: variant,
          error: attempts.join(' | '),
          degraded: true,
        }
      }
    } catch (error) {
      attempts.push(`listEvents ${variant}: ${error?.message ?? String(error)}`)
    }
  }
  return { snapshot: null, usedId: null, error: attempts.join(' | '), degraded: true }
}

function extractBlockText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name}](${block.arguments ?? ''})`)
    } else if (block.type === 'image') parts.push(`[image ${block.attachment?.mediaType ?? ''}]`)
    else if (block.type === 'file') parts.push(`[file ${block.attachment?.name ?? ''}]`)
  }
  return parts.join('\n')
}

function summarizeEvents(events, signal) {
  const derived = {
    title: null,
    label: null,
    descriptor: null,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, calls: 0 },
    turns: [],
    toolCalls: 0,
    toolErrors: 0,
    firstTime: null,
    lastTime: null,
    models: new Set(),
    interrupted: 0,
    attempts: 0,
    shadowed: 0,
  }

  let turnCount = 0
  for (const event of events) {
    if (signal?.aborted) break
    const time = typeof event.time === 'number' ? event.time : null
    if (time !== null) {
      if (derived.firstTime === null || time < derived.firstTime) derived.firstTime = time
      if (derived.lastTime === null || time > derived.lastTime) derived.lastTime = time
    }

    if (event.type === 'session/title' && event.data?.title) {
      derived.title = event.data.title
    } else if (event.type === 'subagent/descriptor') {
      derived.descriptor = event.data ?? null
      derived.label = event.data?.label ?? null
      if (event.data?.agentModel) derived.models.add(event.data.agentModel)
    } else if (event.type === 'turn/start') {
      turnCount += 1
      derived.turns.push({ turn: event.data?.turn ?? turnCount, start: time, end: null, reason: null })
    } else if (event.type === 'turn/end') {
      const last = derived.turns[derived.turns.length - 1]
      if (last) {
        last.end = time
        last.reason = event.data?.reason ?? null
      }
    } else if (event.type === 'tool/call') {
      derived.toolCalls += 1
    } else if (event.type === 'tool/result') {
      if (event.data?.error || event.data?.message?.isError) derived.toolErrors += 1
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage) {
        derived.usage.inputTokens += usage.inputTokens ?? 0
        derived.usage.outputTokens += usage.outputTokens ?? 0
        derived.usage.reasoningTokens += usage.reasoningTokens ?? 0
        derived.usage.cacheReadTokens += usage.cacheReadTokens ?? 0
        derived.usage.calls += 1
      }
      const model = event.data?.message?.source?.model
      if (model) derived.models.add(model)
      if (event.data?.interrupted) derived.interrupted += 1
    } else if (event.type === 'assistant/attempt') {
      derived.attempts += 1
    }
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      derived.shadowed += 1
    }
  }
  derived.usage.models = [...derived.models]
  delete derived.models
  return derived
}

function pickHeader(record, usedId) {
  const header = record?.header ?? null
  return {
    ...(header ?? {}),
    id: header?.id ?? usedId ?? null,
  }
}

/**
 * Collect one immutable snapshot of a session tree.
 *
 * @param {object} ctx            host context (`sessionQuery` required)
 * @param {string} rootInput      session id in either textual shape
 * @param {object} options        { signal }
 */
export async function collectFleetSnapshot(ctx, rootInput, options = {}) {
  const { sessionQuery } = ctx
  const { signal } = options
  const warnings = []

  let records
  try {
    records = await sessionQuery.listSessions(signal)
  } catch (error) {
    throw new Error(`无法读取会话列表：${error?.message ?? String(error)}`)
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('当前没有可读取的会话')
  }

  const byBare = new Map()
  for (const record of records) {
    const id = record?.header?.id
    if (!id) continue
    byBare.set(bareSessionId(id), record)
  }

  let targetBare = null
  for (const variant of sessionIdVariants(rootInput)) {
    const candidate = bareSessionId(variant)
    if (byBare.has(candidate)) {
      targetBare = candidate
      break
    }
  }
  if (!targetBare) {
    // Accept a unique id prefix, which is how the UI usually shows a session.
    const needle = bareSessionId(rootInput).toLowerCase()
    if (needle.length >= 4) {
      const matches = [...byBare.keys()].filter((key) => key.toLowerCase().startsWith(needle))
      if (matches.length === 1) {
        targetBare = matches[0]
      } else if (matches.length > 1) {
        throw new Error(
          `会话 ID 前缀 ${rootInput} 匹配到 ${matches.length} 个会话，请给出更完整的 ID：${matches
            .slice(0, 5)
            .join(', ')}`,
        )
      }
    }
  }
  if (!targetBare) {
    throw new Error(`找不到会话 ${rootInput}（可能已被归档或删除）`)
  }

  const lineage = findRoot(byBare, targetBare)
  if (lineage.cycle) warnings.push(`检测到 parentSession 环路，已在 ${lineage.root} 处停止`)
  if (lineage.unresolvedParent) {
    warnings.push(`父会话 ${lineage.unresolvedParent} 不在可读范围内，已从 ${lineage.root} 起导出`)
  }

  const ordered = collectSubtree(byBare, lineage.root)
  const logResults = await mapLimit(ordered, READ_CONCURRENCY, async (node) => {
    const result = await readOneLog(sessionQuery, node.bare, signal)
    return { node, result }
  })

  const sessions = []
  for (const { node, result } of logResults) {
    const record = byBare.get(node.bare)
    const header = pickHeader(record, result.usedId ?? node.bare)
    const events = result.snapshot?.events ?? []
    const metadataOnly = Boolean(result.snapshot?.metadataOnly)
    const derived = metadataOnly
      ? {
          title: null,
          label: null,
          descriptor: null,
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, calls: 0, models: [] },
          turns: [],
          toolCalls: 0,
          toolErrors: 0,
          firstTime: null,
          lastTime: null,
          interrupted: 0,
          attempts: 0,
          shadowed: 0,
        }
      : summarizeEvents(events, signal)

    if (result.degraded) {
      warnings.push(
        `会话 ${node.bare} 无法完整读取，已降级为${metadataOnly ? '仅元数据' : '部分'}：${result.error}`,
      )
    }

    sessions.push({
      id: header.id,
      bare: node.bare,
      depth: node.depth,
      parentBare: header.parentSession ? bareSessionId(header.parentSession) : null,
      header,
      createdAt: header.createdAt ?? derived.firstTime,
      isSeeded: Boolean(header.isSeeded),
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? node.depth,
      agentPreset: header.agentPreset ?? null,
      cwd: header.cwd ?? null,
      title: derived.title,
      label: derived.label,
      descriptor: derived.descriptor,
      displayName: derived.label || derived.title || (node.depth === 0 ? '主会话' : `子代理 ${node.bare.slice(0, 8)}`),
      // Short, stable name for narrating "who did this"; never an auto-generated
      // session title, which can contain artifacts from the title model.
      roleName: node.depth === 0 ? '主控' : derived.label || `子代理 ${node.bare.slice(0, 8)}`,
      model: derived.descriptor?.agentModel ?? derived.usage.models?.[0] ?? null,
      events,
      metadataOnly,
      unavailable: events.length === 0,
      readError: result.degraded ? result.error : null,
      inheritedEventCount: Number(result.snapshot?.inheritedEventCount ?? 0) || 0,
      derived,
      firstTime: derived.firstTime,
      lastTime: derived.lastTime,
      eventCount: events.length,
    })
  }

  // Orphans: children whose parent lives outside the exported subtree.
  const exported = new Set(sessions.map((s) => s.bare))
  for (const session of sessions) {
    if (session.parentBare && !exported.has(session.parentBare)) {
      warnings.push(`会话 ${session.bare} 的父会话 ${session.parentBare} 不在本次导出范围内`)
    }
  }

  const totalEvents = sessions.reduce((sum, s) => sum + s.eventCount, 0)
  const times = sessions.flatMap((s) => [s.firstTime, s.lastTime]).filter((t) => typeof t === 'number')
  const covered = sessions
    .filter((s) => !s.metadataOnly && s.events.length > 0)
    .map((s) => ({
      bare: s.bare,
      displayName: s.roleName || s.displayName,
      maxSeq: Math.max(...s.events.map((e) => (typeof e.seq === 'number' ? e.seq : 0))),
      eventCount: s.eventCount,
    }))

  return {
    generatedAt: Date.now(),
    requestedId: rootInput,
    rootBare: lineage.root,
    rootSession: sessions.find((s) => s.bare === lineage.root) ?? sessions[0],
    sessions,
    warnings,
    coverage: {
      sessionCount: sessions.length,
      totalEvents,
      earliest: times.length ? Math.min(...times) : null,
      latest: times.length ? Math.max(...times) : null,
      covered,
    },
    usage: sessions.reduce(
      (acc, s) => {
        acc.inputTokens += s.derived.usage.inputTokens
        acc.outputTokens += s.derived.usage.outputTokens
        acc.reasoningTokens += s.derived.usage.reasoningTokens
        acc.cacheReadTokens += s.derived.usage.cacheReadTokens
        acc.calls += s.derived.usage.calls
        return acc
      },
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, calls: 0 },
    ),
  }
}

export { extractBlockText }
