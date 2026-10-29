/**
 * summary.md renderer — the human-readable narrative.
 *
 * This is NOT a shortened copy of raw.md. It is built independently from the
 * same frozen snapshot, by reducing events into narrative beats (who spoke,
 * what was decided, which tool did what) and merging every session onto one
 * wall-clock timeline.
 *
 * Ordering is always (time, sessionCreatedAt, seq) because DSH has no
 * cross-session sequence number.
 */

import {
  cleanTitle,
  escapeInline,
  formatClock,
  formatDateTime,
  humanBytes,
  isInjectedText,
  truncateText,
} from './util.js'

const SPAWN_TOOLS = new Set([
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'workflow',
  'create_worktree',
])

const TEAM_TOOLS = new Set(['send_message', 'interrupt_agent', 'team_task_create', 'team_task_update', 'wait_agent'])

const READ_TOOLS = new Set(['read'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'web_search', 'web_fetch'])
const EXEC_TOOLS = new Set(['pwsh', 'bash', 'shell'])

function yamlString(value) {
  const text = String(value ?? '')
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

/** Split one user message into the human's words and harness injections. */
function splitUserBlocks(blocks) {
  const real = []
  const injected = []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (isInjectedText(block.text)) injected.push(block.text)
    else real.push(block.text)
  }
  return { real: real.join('\n\n').trim(), injected }
}

function parseArgs(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

function firstLine(text, max = 120) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function basename(filePath) {
  const text = String(filePath ?? '')
  const parts = text.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : text
}

/** Turn a tool call into one readable clause. */
function describeTool(name, args) {
  const a = args ?? {}
  if (name === 'skill') return `加载技能 \`${a.name ?? '?'}\``
  if (name === 'read') return `读取 \`${basename(a.file_path ?? a.path ?? '?')}\``
  if (name === 'write') return `写入 \`${basename(a.file_path ?? a.path ?? '?')}\``
  if (name === 'edit') return `修改 \`${basename(a.file_path ?? a.path ?? '?')}\``
  if (name === 'grep') return `搜索「${firstLine(a.pattern ?? '', 60)}」`
  if (name === 'glob') return `查找文件 \`${a.pattern ?? '?'}\``
  if (name === 'web_search') {
    const queries = Array.isArray(a.queries) ? a.queries : [a.query ?? '?']
    return `联网检索「${firstLine(queries[0], 60)}」`
  }
  if (name === 'web_fetch') return `抓取网页 \`${firstLine(a.url ?? '?', 60)}\``
  if (EXEC_TOOLS.has(name)) return `执行命令 \`${firstLine(a.command ?? a.cmd ?? '?', 80)}\``
  if (name === 'spawn_teammate') return `派生子代理 **${a.name ?? '?'}**`
  if (name === 'subagent' || name === 'subagent_fork') return `派生子代理（${firstLine(a.description ?? '', 40)}）`
  if (name === 'workflow') return `运行工作流 \`${a.meta?.name ?? '?'}\``
  if (name === 'send_message') return `发消息给 \`${a.target ?? '?'}\``
  if (name === 'ask_user_question') return '向用户提问'
  if (name === 'update_goal') return `更新目标（${a.action ?? '?'}）`
  if (name === 'todo_write') return '更新任务清单'
  if (name === 'cordis_inspect_query') return `查询 ${a.provider ?? '?'} 契约`
  if (name === 'forward' ) return '转发'
  return `调用 \`${name}\``
}

function blocksOf(event) {
  const message = event.data?.message
  if (message && Array.isArray(message.content)) return message.content
  if (Array.isArray(event.data?.content)) return event.data.content
  return []
}

function plainText(blocks) {
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function joinBlocks(blocks) {
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Reduce every session to ordered narrative beats.
 * Each beat keeps its source event so the summary can anchor back into raw.md.
 */
function buildBeats(snapshot) {
  const beats = []

  for (const session of snapshot.sessions) {
    if (session.metadataOnly) {
      beats.push({
        time: session.createdAt ?? 0,
        session,
        seq: -1,
        kind: 'note',
        text: `会话 ${session.displayName} 的原始日志不可读，只能确认它存在（${session.eventCount} 条元数据）。`,
        severity: 'warn',
      })
      continue
    }

    let pendingTools = []
    let pendingToolSeq = null
    let lastAssistantSeq = null
    let firstUserSeen = false

    const flushTools = () => {
      if (pendingTools.length === 0) return
      beats.push({
        time: pendingTools[0].time,
        session,
        seq: pendingToolSeq ?? -1,
        kind: 'tools',
        tools: pendingTools,
      })
      pendingTools = []
      pendingToolSeq = null
    }

    for (const event of session.events) {
      const time = typeof event.time === 'number' ? event.time : session.createdAt ?? 0

      if (event.type === 'user/message') {
        flushTools()
        const blocks = blocksOf(event)
        const { real, injected } = splitUserBlocks(blocks)
        if (!real) {
          if (injected.length > 0) {
            beats.push({
              time,
              session,
              seq: event.seq,
              kind: 'injected',
              text: injected.join('\n\n'),
              event,
            })
          }
          continue
        }
        const isSubagentReport = /^Agent\s+\S+\s+sent a message:/i.test(real)
        // A subagent's first user message is the task its parent handed it.
        const isAssignment = !isSubagentReport && session.depth > 0 && !firstUserSeen
        firstUserSeen = true
        beats.push({
          time,
          session,
          seq: event.seq,
          kind: isSubagentReport ? 'report' : isAssignment ? 'assignment' : 'user',
          text: real,
          injectedCount: injected.length,
          event,
        })
        continue
      }

      if (event.type === 'assistant/message') {
        flushTools()
        const blocks = blocksOf(event)
        const text = plainText(blocks)
        const reasoning = blocks
          .filter((b) => b && b.type === 'reasoning')
          .map((b) => b.text ?? '')
          .join('\n')
        const calls = blocks.filter((b) => b && b.type === 'tool-call')
        if (text.trim()) {
          beats.push({ time, session, seq: event.seq, kind: 'assistant', text, event })
          lastAssistantSeq = event.seq
        } else if (reasoning.trim() && calls.length === 0) {
          beats.push({
            time,
            session,
            seq: event.seq,
            kind: 'assistant',
            text: '',
            silent: true,
            event,
          })
        }
        continue
      }

      if (event.type === 'tool/call') {
        const args = parseArgs(event.data?.arguments)
        pendingTools.push({
          time,
          seq: event.seq,
          name: event.data?.name,
          args,
          clause: describeTool(event.data?.name, args),
        })
        if (pendingToolSeq === null) pendingToolSeq = event.seq
        continue
      }

      if (event.type === 'tool/result') {
        const isError = Boolean(event.data?.error || event.data?.message?.isError)
        if (pendingTools.length > 0) {
          pendingTools[pendingTools.length - 1].isError = isError
          pendingTools[pendingTools.length - 1].resultSeq = event.seq
          pendingTools[pendingTools.length - 1].resultBlocks = blocksOf(event)
          pendingTools[pendingTools.length - 1].errorInfo = event.data?.error ?? null
        }
        continue
      }

      if (event.type === 'turn/end') {
        flushTools()
        const reason = event.data?.reason ?? {}
        if (reason.kind && reason.kind !== 'completed') {
          beats.push({
            time,
            session,
            seq: event.seq,
            kind: 'alert',
            text: `turn ${event.data?.turn ?? '?'} 以 **${reason.kind}** 结束${
              reason.reason?.reason ? `：${reason.reason.reason}` : ''
            }${reason.error?.message ? `：${reason.error.message}` : ''}`,
            severity: reason.kind === 'error' ? 'error' : 'warn',
          })
        }
        continue
      }

      if (event.type === 'subagent/descriptor') {
        beats.push({
          time,
          session,
          seq: event.seq,
          kind: 'spawn',
          text: `子代理 **${event.data?.label ?? session.displayName}** 启动（provider=${event.data?.provider ?? '?'}，model=${event.data?.agentModel ?? '?'}）`,
        })
        continue
      }
    }
    flushTools()
  }

  beats.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    const createdA = a.session.createdAt ?? 0
    const createdB = b.session.createdAt ?? 0
    if (createdA !== createdB) return createdA - createdB
    const depthA = a.session.depth ?? 0
    const depthB = b.session.depth ?? 0
    if (depthA !== depthB) return depthA - depthB
    return (a.seq ?? 0) - (b.seq ?? 0)
  })

  return mergeAdjacentBeats(beats)
}

function speaker(session) {
  return session.roleName || (session.depth === 0 ? '主控' : session.displayName)
}

/**
 * Fuse beats that read better together:
 *  - consecutive human messages from one submission (DSH splits them)
 *  - consecutive tool batches from the same session within 90 s
 */
function mergeAdjacentBeats(beats) {
  const merged = []
  for (const beat of beats) {
    const previous = merged[merged.length - 1]
    if (!previous) {
      merged.push(beat)
      continue
    }
    const sameSession = previous.session === beat.session
    if (
      sameSession &&
      previous.kind === 'user' &&
      beat.kind === 'user' &&
      Math.abs(beat.time - previous.time) < 1500
    ) {
      previous.text = `${previous.text}\n\n${beat.text}`
      previous.time = beat.time
      previous.mergedSeqs = [...(previous.mergedSeqs ?? [previous.seq]), beat.seq]
      continue
    }
    if (
      sameSession &&
      previous.kind === 'tools' &&
      beat.kind === 'tools' &&
      beat.time - previous.time < 90_000
    ) {
      previous.tools = [...previous.tools, ...beat.tools]
      previous.endTime = beat.time
      continue
    }
    merged.push(beat)
  }
  return merged
}

function anchorFor(session, seq) {
  if (typeof seq !== 'number' || seq < 0) return ''
  // File names are slugified (no spaces or bracket characters), so a bare link
  // works in every markdown renderer.
  return `[→ raw](${session.rawFileName}#e-${session.bare}-${seq})`
}

function renderToolsBeat(beat) {
  const items = beat.tools.map((tool) => {
    const mark = tool.isError ? ' ❌' : ''
    return `${tool.clause}${mark}`
  })
  // Collapse duplicate clauses (same tool called repeatedly).
  const counts = new Map()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  const lines = []
  for (const [item, count] of counts) {
    lines.push(count > 1 ? `${item} ×${count}` : item)
  }
  return lines.map((l) => `- ${l}`).join('\n')
}

function quoteBlock(text, maxChars) {
  const cut = truncateText(String(text ?? '').trim(), maxChars)
  return cut.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function renderBeat(beat, options) {
  const clock = formatClock(beat.time, options.timeZone)
  const who = speaker(beat.session)
  const link = anchorFor(beat.session, beat.seq)
  const linkSuffix = link && options.rawFileName ? ` ${link}` : ''

  switch (beat.kind) {
    case 'user':
      return `**${clock} · 👤 用户**${linkSuffix}\n\n${quoteBlock(beat.text, options.quoteMaxChars)}`
    case 'assignment':
      return `**${clock} · 📋 ${escapeInline(who)} 收到任务**${linkSuffix}\n\n${quoteBlock(
        beat.text,
        options.quoteMaxChars,
      )}`
    case 'report': {
      const text = beat.text.replace(/^Agent\s+\S+\s+sent a message:\s*/i, '')
      return `**${clock} · 📨 ${escapeInline(who)} 回报**${linkSuffix}\n\n${quoteBlock(
        text,
        options.quoteMaxChars,
      )}`
    }
    case 'assistant': {
      if (beat.silent) {
        return `**${clock} · 🤖 ${escapeInline(who)}**${linkSuffix}\n\n*(无可见文本，仅内部推理)*`
      }
      const cut = truncateText(beat.text.trim(), options.quoteMaxChars)
      return `**${clock} · 🤖 ${escapeInline(who)}**${linkSuffix}\n\n${cut.text}`
    }
    case 'tools': {
      const span =
        beat.endTime && beat.endTime !== beat.time
          ? `${clock}–${formatClock(beat.endTime, options.timeZone)}`
          : clock
      return `**${span} · 🔧 ${escapeInline(who)} 执行工具**${linkSuffix}\n\n${renderToolsBeat(beat)}`
    }
    case 'spawn':
      return `**${clock} · 🌱 编队变更**${linkSuffix}\n\n${beat.text}`
    case 'alert': {
      const icon = beat.severity === 'error' ? '❌' : '⚠️'
      return `**${clock} · ${icon} ${escapeInline(who)}**${linkSuffix}\n\n${beat.text}`
    }
    case 'note':
      return `**${clock} · ℹ️ 说明**\n\n${beat.text}`
    case 'injected':
      // Harness-injected context: kept in raw.md, deliberately silent here.
      return ''
    default:
      return ''
  }
}

function renderFleetTree(snapshot, options) {
  const children = new Map()
  for (const session of snapshot.sessions) {
    if (!session.parentBare) continue
    if (!children.has(session.parentBare)) children.set(session.parentBare, [])
    children.get(session.parentBare).push(session)
  }
  const lines = []
  const walk = (session, prefix, isLast, isRoot) => {
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ '
    const model = session.model ? `\`${session.model}\`` : '`?`'
    const mode = session.descriptor?.mode ? ` · ${session.descriptor.mode}` : ''
    const span =
      session.firstTime && session.lastTime
        ? `${formatClock(session.firstTime, options.timeZone)}–${formatClock(session.lastTime, options.timeZone)}`
        : '未知时段'
    const sessionTitle = truncateText(cleanTitle(String(session.title ?? '').trim(), ''), 24).text
    const label =
      session.depth === 0
        ? `**主控**${sessionTitle ? `（${escapeInline(sessionTitle)}）` : ''}`
        : `**${escapeInline(speaker(session))}**`
    lines.push(
      `${prefix}${connector}${label} ${model}${mode} · ${span} · ${session.eventCount} 事件`,
    )
    const kids = children.get(session.bare) ?? []
    kids.forEach((child, index) => {
      const childPrefix = prefix + (isRoot ? '' : isLast ? '   ' : '│  ')
      walk(child, childPrefix, index === kids.length - 1, false)
    })
  }
  const root = snapshot.sessions.find((s) => s.bare === snapshot.rootBare)
  if (root) walk(root, '', true, true)
  return lines.join('\n')
}

/** Group beats into time blocks for headings; 5-minute buckets read naturally. */
function groupBeats(beats, bucketMs) {
  const groups = []
  let current = null
  for (const beat of beats) {
    const bucket = Math.floor(beat.time / bucketMs)
    if (!current || current.bucket !== bucket) {
      current = { bucket, time: beat.time, beats: [] }
      groups.push(current)
    }
    current.beats.push(beat)
  }
  return groups
}

export function renderSummary(snapshot, options) {
  const opts = {
    quoteMaxChars: 1200,
    timeZone: undefined,
    bucketMinutes: 5,
    rawFileName: 'raw.md',
    summaryFileName: 'summary.md',
    ...options,
  }
  const r = opts.redact ?? ((x) => x)
  const beats = buildBeats(snapshot)
  const title = cleanTitle(snapshot.rootSession?.title, snapshot.rootBare.slice(0, 8))
  const meta = snapshot.meta ?? {}

  const userBeats = beats.filter((b) => b.kind === 'user' || b.kind === 'report')
  const toolCalls = beats
    .filter((b) => b.kind === 'tools')
    .reduce((sum, b) => sum + b.tools.length, 0)
  const alerts = beats.filter((b) => b.kind === 'alert')
  const injectedCount = beats.filter((b) => b.kind === 'injected').length
  const durationMs =
    snapshot.coverage.earliest && snapshot.coverage.latest
      ? snapshot.coverage.latest - snapshot.coverage.earliest
      : 0

  const out = []
  out.push(`# 会话纪要 · ${escapeInline(title)}`)
  out.push('')
  out.push(
    `> 本文件是**可读叙事**：按时间顺序还原这段会话里发生了什么、谁做了什么决定。` +
      `每条记录都带 \`[→ raw]\` 锚点，可跳转到同名 \`.raw.md\` 中的原始事件。`,
  )
  out.push('')

  if (snapshot.warnings.length > 0) {
    out.push('## ⚠️ 导出提示')
    out.push('')
    for (const warning of snapshot.warnings) out.push(`- ${escapeInline(warning)}`)
    out.push('')
  }

  out.push('## 速览')
  out.push('')
  out.push('| 项目 | 值 |')
  out.push('| --- | --- |')
  out.push(`| 时间跨度 | ${formatDateTime(snapshot.coverage.earliest, opts.timeZone)} → ${snapshot.coverage.latest ? formatClock(snapshot.coverage.latest, opts.timeZone) : '?'}（${Math.max(1, Math.round(durationMs / 60000))} 分钟） |`)
  out.push(`| 参与会话 | ${snapshot.coverage.sessionCount}（主会话 1 + 子代理 ${Math.max(0, snapshot.coverage.sessionCount - 1)}） |`)
  out.push(`| 用户/子代理发言 | ${userBeats.length} 条 |`)
  out.push(`| 系统注入 | ${injectedCount} 条（叙事中省略，原文见 raw） |`)
  out.push(`| 工具调用 | ${toolCalls} 次 |`)
  out.push(`| 事件总数 | ${snapshot.coverage.totalEvents} |`)
  out.push(`| 模型调用 | ${snapshot.usage.calls} 次 · in ${snapshot.usage.inputTokens} / out ${snapshot.usage.outputTokens} tokens |`)
  out.push(`| 异常 | ${alerts.length === 0 ? '无' : `${alerts.length} 处（见时间线 ⚠️）`} |`)
  out.push('')

  out.push('## 编队与分工')
  out.push('')
  out.push('```text')
  out.push(renderFleetTree(snapshot, opts))
  out.push('```')
  out.push('')
  out.push(
    '> `fork` 表示子代理继承了父会话上下文；其余为独立上下文。' +
      '事件数反映该分支的活跃程度。',
  )
  out.push('')

  out.push('## 时间线')
  out.push('')

  const groups = groupBeats(beats, opts.bucketMinutes * 60_000)
  for (const group of groups) {
    const rendered = group.beats.map((beat) => renderBeat(beat, opts)).filter(Boolean)
    if (rendered.length === 0) continue
    out.push(`### ${formatClock(group.time, opts.timeZone)} 起`)
    out.push('')
    for (const block of rendered) out.push(block, '')
  }

  if (beats.length === 0) {
    out.push('*(这段会话没有任何可叙述的事件)*')
    out.push('')
  }

  out.push('---')
  out.push('')
  out.push('## 附：如何对照原文')
  out.push('')
  out.push(`- 每条记录末尾的 \`[→ raw]\` 指向 \`.raw.md\` 里 \`seq N\` 的事件。`)
  out.push('- 会话内 `seq` 连续递增，但**跨会话不可比较**；本时间线用实际时间排序。')
  out.push('- 本摘要由确定性规则生成，未调用模型改写，因此与原文一致、可复现。')
  out.push('')

  // Redact the body first so the tallies cover the whole document.
  const bodyText = r(out.join('\n'))
  const report = typeof opts.redactionReport === 'function' ? opts.redactionReport() : { enabled: false, total: 0 }
  const head = [
    '---',
    `export_id: ${yamlString(meta.exportId ?? '')}`,
    'kind: "summary"',
    `title: ${yamlString(title)}`,
    `root_session: ${yamlString(snapshot.rootBare)}`,
    `created_at: ${yamlString(snapshot.coverage.earliest ? formatDateTime(snapshot.coverage.earliest, opts.timeZone) : 'unknown')}`,
    `exported_at: ${yamlString(formatDateTime(snapshot.generatedAt, opts.timeZone))}`,
    `timezone: ${yamlString(opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local')}`,
    `sessions: ${snapshot.coverage.sessionCount}`,
    `event_count: ${snapshot.coverage.totalEvents}`,
    `model_calls: ${snapshot.usage.calls}`,
    `redacted: ${report.enabled ? 'true' : 'false'}`,
    `redaction_count: ${report.total ?? 0}`,
    `narrative: "deterministic"`,
    `exporter: ${yamlString('dsh-session-export@0.1.0')}`,
    '---',
    '',
  ]

  return [...head, bodyText].join('\n')
}
