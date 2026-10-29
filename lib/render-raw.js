/**
 * raw.md renderer — the complete, replayable archive.
 *
 * Design rules baked in here:
 *  - every event is emitted once, in ascending seq order, per session
 *  - long payloads are folded, never dropped; dropped fields are named
 *  - `surfaceOp: replace` regions are marked so a reader cannot mistake a
 *    superseded branch for the live conversation
 *  - fork-inherited prefixes are announced, not expanded twice
 *  - the exporter's own tool/command events are filtered out
 */

import {
  cleanTitle,
  details,
  escapeInline,
  fenced,
  formatClock,
  formatDateTime,
  humanBytes,
  isInjectedText,
  truncateText,
} from './util.js'

const SELF_TOOL_PREFIXES = ['export_session_markdown', 'export_session']
const SELF_COMMANDS = ['export']

function yamlString(value) {
  const text = String(value ?? '')
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

function isSelfEvent(event) {
  if (event.type === 'tool/call') {
    const name = String(event.data?.name ?? '')
    return SELF_TOOL_PREFIXES.some((p) => name.startsWith(p))
  }
  if (event.type === 'tool/result') {
    const source = event.data?.message?.source
    return false && source
  }
  if (event.type === 'command/run' || event.type === 'command/done') {
    const name = String(event.data?.name ?? event.data?.command ?? '')
    return SELF_COMMANDS.includes(name)
  }
  return false
}

function eventBlocks(event) {
  const message = event.data?.message
  if (message && Array.isArray(message.content)) return message.content
  if (Array.isArray(event.data?.content)) return event.data.content
  return []
}

function renderBlock(block, options) {
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return String(block.text ?? '')
    case 'reasoning': {
      if (!options.includeReasoning) {
        return `*[reasoning 已省略 ${String(block.text ?? '').length} 字符]*`
      }
      const body = fenced(block.text ?? '', 'text')
      return details(`思考过程 · ${String(block.text ?? '').length} 字符`, body, false)
    }
    case 'tool-call':
      // Full arguments live on the dedicated `tool/call` event.
      return `→ \`${block.name}\``
    case 'image':
      return `*[图片附件 ${block.attachment?.mediaType ?? ''} ${humanBytes(block.attachment?.bytes ?? 0)}]*`
    case 'file':
      return `*[文件附件 ${block.attachment?.name ?? ''} ${humanBytes(block.attachment?.bytes ?? 0)}]*`
    case 'tool-addition':
      return `*[+ tool ${block.toolName}]*`
    case 'tool-removal':
      return `*[- tool ${block.toolName}]*`
    default:
      return fenced(JSON.stringify(block, null, 2), 'json')
  }
}

function renderLongPayload(text, options, label) {
  const value = String(text ?? '')
  if (value.length === 0) return `*(空)*`
  const limit = options.toolResultMaxChars
  if (value.length <= limit) return fenced(value, 'text')
  const cut = truncateText(value, limit)
  return [
    details(`${label} · ${value.length} 字符（已折叠）`, fenced(cut.text, 'text'), false),
    `> 原始长度 ${value.length} 字符 / ${humanBytes(Buffer.byteLength(value, 'utf8'))}，此处保留首尾各约 ${Math.floor(limit * 0.7)} / ${limit - Math.floor(limit * 0.7)} 字符；完整内容请用 readSession 复核。`,
  ].join('\n\n')
}

function renderEvent(event, session, options) {
  const seq = typeof event.seq === 'number' ? event.seq : '?'
  const clock = formatClock(event.time, options.timeZone)
  const full = formatDateTime(event.time, options.timeZone)
  const anchor = `e-${session.bare}-${seq}`
  const head = `<a id="${anchor}"></a>\n#### \`seq ${seq}\` · ${clock} · \`${event.type}\``
  const meta = `*${full}*`
  const data = event.data ?? {}

  const parts = [head, meta]

  if (event.surfaceOp) {
    if (typeof event.surfaceOp === 'string') {
      if (event.surfaceOp !== 'append') parts.push(`> **surface: ${event.surfaceOp}**`)
    } else if (event.surfaceOp.op === 'replace') {
      parts.push(
        `> ⚠️ **该段已被替换**（surfaceOp.replace，覆盖 seq ${event.surfaceOp.startSeq}–${event.surfaceOp.endSeq}）。` +
          `模型在后续轮次不再看到此处原文。`,
      )
    }
    if (Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0) {
      parts.push(`> 来源事件 seq：${event.sourceEventSeqs.join(', ')}`)
    }
  }

  switch (event.type) {
    case 'turn/start':
      parts.push('---', `**▶ turn ${data.turn} 开始**`)
      break
    case 'turn/end': {
      const reason = data.reason ?? {}
      const kind = reason.kind ?? 'unknown'
      const extra = reason.reason?.kind ? `（原因：${reason.reason.kind}${reason.reason.reason ? `: ${reason.reason.reason}` : ''}）` : ''
      const failure = reason.error?.message ? `\n\n失败详情：${reason.error.code} — ${reason.error.message}` : ''
      parts.push(`**◀ turn ${data.turn} 结束 · ${kind}${extra}**${failure}`)
      break
    }
    case 'step/start':
      parts.push(`*step ${data.step} 开始*`)
      break
    case 'step/end':
      parts.push(`*step ${data.step} 结束*`)
      break
    case 'user/message': {
      const blocks = eventBlocks(event)
      const humanBlocks = blocks.filter((b) => !(b?.type === 'text' && isInjectedText(b.text)))
      const injectedBlocks = blocks.filter((b) => b?.type === 'text' && isInjectedText(b.text))
      const humanBody = humanBlocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      const injectedBody = injectedBlocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      if (humanBody) parts.push('**👤 用户**', '', humanBody)
      if (injectedBody) {
        parts.push(
          details(
            `🧩 系统注入 ${injectedBlocks.length} 段（harness context，非用户输入）`,
            injectedBody,
            false,
          ),
        )
      }
      if (!humanBody && !injectedBody) parts.push('**👤 用户**', '', '*(空消息)*')
      break
    }
    case 'assistant/message': {
      const blocks = eventBlocks(event)
      const body = blocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      const usage = data.usage
        ? `\n\n*usage: in ${data.usage.inputTokens ?? 0} / out ${data.usage.outputTokens ?? 0}` +
          `${data.usage.reasoningTokens ? ` / reasoning ${data.usage.reasoningTokens}` : ''}*`
        : ''
      const interrupted = data.interrupted ? '\n\n> ⚠️ 本次回答被中断（interrupted）' : ''
      const model = data.message?.source?.model ? ` · model \`${data.message.source.model}\`` : ''
      parts.push(`**🤖 助手${model}**`, '', body || '*(空回复)*')
      parts.push(usage.trim(), interrupted.trim())
      break
    }
    case 'assistant/attempt':
      parts.push('> ⚠️ **一次未采用的尝试**（重试/中断前的流式记录，内容未进入对话）')
      break
    case 'system/message': {
      const blocks = eventBlocks(event)
      const body = blocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      if (!options.includeSystemPrompt) {
        parts.push(
          `*[system prompt 已省略 · ${String(body).length} 字符]*\n\n` +
            `> 出于隐私与体积考虑，system prompt 默认不导出。如需包含，请以 \`includeSystemPrompt: true\` 重新导出。`,
        )
      } else {
        parts.push('**⚙️ system prompt**', '', renderLongPayload(body, options, 'system prompt'))
      }
      break
    }
    case 'developer/message': {
      const blocks = eventBlocks(event)
      const body = blocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      parts.push('**🛠 developer**', '', body)
      break
    }
    case 'tool/call': {
      const args = String(data.arguments ?? '')
      parts.push(
        `**🔧 调用工具 \`${data.name}\`** · \`${data.callId}\``,
        '',
        renderLongPayload(args, options, `参数 ${data.name}`),
      )
      break
    }
    case 'tool/result': {
      const blocks = eventBlocks(event)
      const body = blocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
      const isError = Boolean(data.error || data.message?.isError)
      const banner = isError
        ? `> ❌ **工具报错**${data.error ? `：${data.error.name} / ${data.error.code}${data.error.reason ? ` — ${data.error.reason}` : ''}` : ''}`
        : '> ✅ 工具返回'
      parts.push(banner, '', renderLongPayload(body, options, '工具结果'))
      if (data.meta !== undefined) {
        parts.push(details('工具 meta', fenced(JSON.stringify(data.meta, null, 2), 'json')))
      }
      break
    }
    case 'request/header': {
      const header = data.header ?? {}
      const tools = Array.isArray(header.tools) ? header.tools : []
      const size = tools.length > 0 ? humanBytes(Buffer.byteLength(JSON.stringify(tools), 'utf8')) : '0 B'
      const config = header.config ?? {}
      parts.push(
        `**📡 请求头** · \`${config.provider ?? '?'}/${config.model ?? '?'}\` · reason=${data.reason ?? '?'}` +
          `${data.startsSeries ? ' · 新一轮序列' : ''}`,
        '',
        details(
          `工具清单 ${tools.length} 个 · ${size}（默认折叠）`,
          fenced(tools.map((t) => t.name).join('\n'), 'text'),
        ),
      )
      break
    }
    case 'request/context':
      parts.push(`*provider \`${data.provider}\` · model \`${data.model}\` · contextWindow ${data.contextWindow ?? '?'}*`)
      break
    case 'session/title':
      parts.push(`**会话标题**：${data.title ?? ''}`)
      break
    case 'session/end-seed':
      parts.push('*会话种子结束*')
      break
    case 'subagent/descriptor':
      parts.push(
        `**子代理**：\`${data.label ?? '(无标签)'}\` · provider=${data.provider ?? '?'} · mode=${data.mode ?? '?'} · model=${data.agentModel ?? '?'}`,
      )
      break
    case 'sandbox/mode':
      parts.push(`*sandbox: \`${data.mode}\`${data.source ? `（${data.source}）` : ''}*`)
      break
    case 'approval/policy':
      parts.push(`*approval: \`${data.policy}\`${data.source ? `（${data.source}）` : ''}*`)
      break
    case 'agent/inbox/spliced': {
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      if (inserted.length === 0) return ''
      const body = inserted
        .map((m) => {
          const blocks = Array.isArray(m.content) ? m.content : []
          return blocks.map((b) => renderBlock(b, options)).filter(Boolean).join('\n\n')
        })
        .join('\n\n---\n\n')
      parts.push(`**📥 注入消息**（target=${data.target ?? '?'}，${inserted.length} 条）`, '', renderLongPayload(body, options, '注入内容'))
      break
    }
    default:
      parts.push(details(`${event.type} 原始数据`, fenced(JSON.stringify(data, null, 2), 'json')))
      break
  }

  return parts.filter((p) => p !== '' && p !== undefined && p !== null).join('\n\n')
}

function renderFleetTree(snapshot) {
  const byBare = new Map(snapshot.sessions.map((s) => [s.bare, s]))
  const children = new Map()
  for (const session of snapshot.sessions) {
    if (!session.parentBare) continue
    if (!children.has(session.parentBare)) children.set(session.parentBare, [])
    children.get(session.parentBare).push(session)
  }
  const lines = []
  const walk = (session, prefix, isLast, isRoot) => {
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ '
    const model = session.model ? ` · ${session.model}` : ''
    const time = session.firstTime ? formatClock(session.firstTime, snapshot.timeZone) : '--:--:--'
    const name =
      session.depth === 0
        ? `**主控**（${cleanTitle(session.title, '') || session.bare.slice(0, 8)}）`
        : `**${session.roleName || session.displayName}**`
    lines.push(
      `${prefix}${connector}${name} \`${session.bare.slice(0, 8)}\`${model} · ${time} · ${session.eventCount} 事件`,
    )
    const kids = children.get(session.bare) ?? []
    kids.forEach((child, index) => {
      const childPrefix = prefix + (isRoot ? '' : isLast ? '   ' : '│  ')
      walk(child, childPrefix, index === kids.length - 1, false)
    })
  }
  const root = byBare.get(snapshot.rootBare)
  if (root) walk(root, '', true, true)
  return fenced(lines.join('\n'), 'text')
}

export function renderRaw(snapshot, options) {
  const opts = {
    includeReasoning: true,
    includeSystemPrompt: false,
    toolResultMaxChars: 6000,
    timeZone: undefined,
    redact: (x) => x,
    ...options,
  }
  const r = (text) => opts.redact(text)
  const out = []

  const title = cleanTitle(snapshot.rootSession?.title, snapshot.rootBare.slice(0, 8))
  const meta = snapshot.meta ?? {}

  out.push(`# 原始会话存档 · ${escapeInline(title)}`)
  out.push('')
  out.push(
    `> **本文件是完整事件日志**，逐条保留消息、工具调用、工具结果与状态，未经摘要。` +
      `面向复盘与审计；配套的可读叙述见同名 \`.summary.md\`。`,
  )
  out.push('')

  if (snapshot.warnings.length > 0) {
    out.push('## ⚠️ 导出警告')
    out.push('')
    for (const warning of snapshot.warnings) out.push(`- ${escapeInline(warning)}`)
    out.push('')
  }

  out.push('## 导出元数据')
  out.push('')
  out.push('| 项目 | 值 |')
  out.push('| --- | --- |')
  out.push(`| Export ID | \`${meta.exportId ?? ''}\` |`)
  out.push(`| 根会话 | \`${snapshot.rootBare}\` |`)
  out.push(`| 会话数 | ${snapshot.coverage.sessionCount} |`)
  out.push(`| 事件总数 | ${snapshot.coverage.totalEvents} |`)
  out.push(`| 起始 | ${snapshot.coverage.earliest ? formatDateTime(snapshot.coverage.earliest, opts.timeZone) : 'unknown'} |`)
  out.push(`| 截止 | ${snapshot.coverage.latest ? formatDateTime(snapshot.coverage.latest, opts.timeZone) : 'unknown'} |`)
  out.push(`| 导出时刻 | ${formatDateTime(snapshot.generatedAt, opts.timeZone)} |`)
  out.push(`| 模型调用 | ${snapshot.usage.calls} 次，in ${snapshot.usage.inputTokens} / out ${snapshot.usage.outputTokens} tokens |`)
  out.push('')

  out.push('## 编队结构')
  out.push('')
  out.push(renderFleetTree({ ...snapshot, timeZone: opts.timeZone }))
  out.push('')

  out.push('## 快照覆盖范围')
  out.push('')
  out.push('本次导出是一次**冻结快照**：以下每个会话都记录了覆盖到的事件序号上界。导出时刻之后产生的事件不在本文件内。')
  out.push('')
  out.push('| 会话 | 覆盖至 seq | 事件数 |')
  out.push('| --- | --- | --- |')
  for (const item of snapshot.coverage.covered) {
    out.push(`| ${escapeInline(item.displayName)} (\`${item.bare.slice(0, 8)}\`) | ${item.maxSeq} | ${item.eventCount} |`)
  }
  out.push('')

  out.push('---')
  out.push('')

  for (const session of snapshot.sessions) {
    const model = session.descriptor?.agentModel ? ` · ${session.descriptor.agentModel}` : ''
    const preset = session.agentPreset ? ` · preset \`${session.agentPreset}\`` : ''
    const heading =
      session.depth === 0
        ? `主控${session.title ? `（${cleanTitle(session.title, '')}）` : ''}`
        : session.roleName || session.displayName
    out.push(`## 会话 · ${escapeInline(heading)} \`${session.bare}\``)
    out.push('')
    out.push(
      `- 角色：${session.depth === 0 ? '主会话' : `子代理（depth ${session.depth}）`}${model}${preset}`,
    )
    out.push(`- 创建：${formatDateTime(session.createdAt, opts.timeZone)}`)
    out.push(`- 事件：${session.eventCount} 条${session.metadataOnly ? '（仅元数据，正文不可读）' : ''}`)
    out.push(`- cwd：\`${session.cwd ?? 'unknown'}\``)
    if (session.readError) out.push(`- ⚠️ 读取异常：${escapeInline(session.readError)}`)
    out.push('')

    if (session.inheritedEventCount > 0) {
      out.push(
        `> ⚠️ **fork 继承**：本会话前 ${session.inheritedEventCount} 条事件继承自父会话，` +
          `已在父会话完整导出，此处不重复展开。`,
      )
      out.push('')
    }

    if (session.metadataOnly) {
      out.push('> ⚠️ 该会话的原始日志无法重放（可能为旧格式或已损坏），仅保留事件元数据：')
      out.push('')
      out.push('| seq | type | time | surface |')
      out.push('| --- | --- | --- | --- |')
      for (const event of session.events.slice(0, 500)) {
        out.push(
          `| ${event.seq} | \`${event.type}\` | ${formatClock(event.time, opts.timeZone)} | ${event.surface ?? '?'} |`,
        )
      }
      if (session.events.length > 500) {
        out.push(`| … | 其余 ${session.events.length - 500} 条已省略 | | |`)
      }
      out.push('')
      continue
    }

    // Emit everything in seq order; skip only the exporter's own traces.
    const visible = session.events.filter((event) => !isSelfEvent(event))
    const selfFiltered = session.events.length - visible.length
    if (selfFiltered > 0) {
      out.push(`> 已过滤 ${selfFiltered} 条导出器自身产生的事件（工具调用/命令记录）。`)
      out.push('')
    }

    const inherited = Math.min(session.inheritedEventCount, visible.length)
    if (inherited > 0) {
      out.push(
        details(
          `继承的 ${inherited} 条事件（默认折叠）`,
          visible
            .slice(0, inherited)
            .map((event) => renderEvent(event, session, opts))
            .join('\n\n'),
          false,
        ),
      )
      out.push('')
    }

    for (const event of visible.slice(inherited)) {
      const rendered = renderEvent(event, session, opts)
      if (rendered) out.push(rendered, '')
    }

    if (session.events.length === 0) {
      out.push('*(该会话没有任何事件)*')
      out.push('')
    }
    out.push('---')
    out.push('')
  }

  out.push('## 文件说明')
  out.push('')
  out.push('- 每个事件标题前的 `seq N` 是该会话内的事件序号，跨会话不连续、不可比较。')
  out.push('- 时间统一为该主机本地时区；frontmatter 中的 `timezone` 指明实际时区。')
  out.push('- 被折叠的内容没有被删除，展开 `<details>` 即可看到；超长内容保留首尾并在正文注明原始长度。')
  out.push('- 「该段已被替换」表示该区间在后续对话中被整体替换，模型已不再看到原文。')
  out.push('')

  // Redact the body first so the tallies cover the whole document.
  const bodyText = r(out.join('\n'))
  const report =
    typeof opts.redactionReport === 'function'
      ? opts.redactionReport()
      : { enabled: Boolean(opts.redact), total: 0 }
  const head = [
    '---',
    `export_id: ${yamlString(meta.exportId ?? '')}`,
    'kind: "raw"',
    `title: ${yamlString(title)}`,
    `root_session: ${yamlString(snapshot.rootBare)}`,
    `sessions: [${snapshot.sessions.map((s) => yamlString(s.bare)).join(', ')}]`,
    `created_at: ${yamlString(snapshot.coverage.earliest ? formatDateTime(snapshot.coverage.earliest, opts.timeZone) : 'unknown')}`,
    `exported_at: ${yamlString(formatDateTime(snapshot.generatedAt, opts.timeZone))}`,
    `timezone: ${yamlString(opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local')}`,
    `event_count: ${snapshot.coverage.totalEvents}`,
    `session_count: ${snapshot.coverage.sessionCount}`,
    `redacted: ${report.enabled ? 'true' : 'false'}`,
    `redaction_count: ${report.total ?? 0}`,
    `exporter: ${yamlString('dsh-session-export@0.1.0')}`,
    '---',
    '',
  ]

  return [...head, bodyText].join('\n')
}
