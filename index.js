/**
 * dsh-session-export
 *
 * Exports one DSH session tree (the lead session plus its whole subagent fleet)
 * into two Markdown files built from a single frozen snapshot:
 *
 *   <name>.summary.md  human-readable narrative timeline
 *   <name>.raw.md      complete raw event archive
 *
 * Read-only with respect to session storage: this plugin never appends events,
 * and it filters its own tool/command traces out of the archive.
 */

import { resolve as resolvePath } from 'node:path'

import { collectFleetSnapshot } from './lib/collect.js'
import { createRedactor } from './lib/redact.js'
import { renderRaw } from './lib/render-raw.js'
import { renderSummary } from './lib/render-summary.js'
import {
  bareSessionId,
  byteLength,
  cleanTitle,
  fnv1a,
  formatDateTime,
  humanBytes,
  slugify,
} from './lib/util.js'

export const name = 'session-md-export'

export const inject = ['tools', 'commands', 'sessionQuery', 'fs']

const TOOL_NAME = 'export_session_markdown'
// `export` is already taken by a built-in command, so this one is namespaced.
const COMMAND_NAME = 'md-export'
const VERSION = '0.1.0'

const DEFAULTS = {
  outputDir: 'exports',
  includeReasoning: true,
  includeSystemPrompt: false,
  redact: true,
  toolResultMaxChars: 6000,
  formats: ['summary', 'raw'],
}

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function resolveCwd(ctx, snapshot) {
  const fromSession = snapshot.rootSession?.cwd
  if (fromSession && fromSession.trim()) return fromSession
  try {
    const direct = ctx.get?.('workingDirectory')
    if (direct && typeof direct.defaultDirectory === 'string') return direct.defaultDirectory
  } catch {
    // ignore — fall back to process cwd
  }
  return process.cwd()
}

/**
 * Resolve the sandbox policy for THIS agent's session.
 *
 * `SandboxedFileSystem.checkedTarget` falls back to `sandboxPolicy.resolve()`
 * with no arguments when the caller passes no policy, and that argument-less
 * resolution yields a policy whose writable roots do not include the session
 * workspace — every write then fails with
 * `file access denied under workspace-write mode`.
 * DSH's own fs tools pass `resolve({ session })`, and so must this plugin.
 */
function resolveWritePolicy(ctx, agent) {
  const sandboxPolicy = ctx.get?.('sandboxPolicy')
  if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') return undefined
  try {
    return sandboxPolicy.resolve(agent?.session ? { session: agent.session } : {})
  } catch {
    return undefined
  }
}

async function writeTextFile(ctx, absolutePath, content, context) {
  const target = await ctx.fs.resolve(absolutePath, context?.signal ? { signal: context.signal } : undefined)
  const policy = resolveWritePolicy(ctx, context?.agent)
  await ctx.fs.writeText(target, content, undefined, context?.signal, policy)
  return target
}

/**
 * Ensure the parent directory exists. `ctx.fs` exposes no mkdir, so a first
 * write is attempted directly; some backends create missing parents, others
 * fail loudly with ENOENT — in which case we retry once by compiling nothing
 * and surfacing a precise instruction instead of a stack trace.
 */
async function writePair(ctx, dirAbsolute, files, context) {
  const written = []
  const policy = resolveWritePolicy(ctx, context?.agent)
  for (const file of files) {
    try {
      await writeTextFile(ctx, `${dirAbsolute}/${file.name}`, file.content, context)
      written.push(file)
    } catch (error) {
      const message = error?.message ?? String(error)
      const diagnosis = `[mode=${policy?.mode ?? 'unknown'}, workspaceRoot=${policy?.workspaceRoot ?? 'unknown'}]`
      const hint = message.includes('file access denied')
        ? `写入 ${file.name} 被沙箱拒绝：${message} ${diagnosis}。当前会话的文件策略不允许写该路径，请把导出目录改到会话工作区内。`
        : error?.code === 'ENOENT'
          ? `输出目录 ${dirAbsolute} 不存在。请先创建该目录，或把 outputDir 指向已存在的目录。`
          : `写入 ${file.name} 失败：${message} ${diagnosis}`
      const failure = new Error(hint)
      failure.writtenBefore = written.map((f) => f.name)
      throw failure
    }
  }
  return written
}

/**
 * Resolve the export directory.
 *
 * `outputDir` may be a path relative to the session workspace, or an absolute
 * path the operator picked in a chooser. Delegating to `path.resolve` keeps the
 * platform's own rules instead of a hand-rolled prefix test: on Windows
 * `path.resolve(cwd, '/exports')` is the drive root, not a workspace child, and
 * a bare `D:` is a drive-relative path rather than an absolute one.
 */
function resolveOutputDir(cwd, outputDir) {
  const raw = String(outputDir ?? '').trim()
  if (!raw) return cwd.replace(/[\\/]+$/, '')
  return resolvePath(cwd, raw)
}

function chooserSignal(signal, timeoutMs = 300_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  try {
    return AbortSignal.any([signal, timeout])
  } catch {
    return timeout
  }
}

/**
 * Ask the operator to pick a directory through the host's OS chooser.
 *
 * Only a `native` backend can open a real dialog. A `browse` backend (or a
 * missing service) deliberately reports unavailable instead of silently
 * approximating, so callers can fall back to the next interaction.
 *
 * @returns `{status:'picked', path}` | `{status:'cancelled'}` | `{status:'unavailable', reason}`
 */
async function pickNativeDirectory(ctx, signal) {
  const picker = ctx.get?.('directoryPicker')
  if (!picker || typeof picker.capability !== 'function') {
    return { status: 'unavailable', reason: '当前组合没有 directoryPicker 服务' }
  }

  let capability
  try {
    capability = picker.capability()
  } catch (error) {
    return { status: 'unavailable', reason: error?.message ?? String(error) }
  }

  if (capability?.kind !== 'native' || typeof capability.pick !== 'function') {
    return {
      status: 'unavailable',
      reason: `目录选择后端为 ${capability?.kind ?? '未知'}，没有系统对话框`,
    }
  }

  try {
    const path = await capability.pick(chooserSignal(signal))
    return path ? { status: 'picked', path } : { status: 'cancelled' }
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'cancelled' }
    return { status: 'unavailable', reason: error?.message ?? String(error) }
  }
}

function homeDirectory() {
  return process.env.USERPROFILE || process.env.HOME || ''
}

/**
 * Ask the operator where to save, using DSH's own question surface.
 *
 * The `native` OS chooser is not always composed (`dsh-host-directory-picker-auto`
 * resolves to `browse` whenever trusted remote authorities are allowed), and a
 * `browse` capability has no `pick()` at all. `ctx.userQuestions.ask` works in
 * both compositions: it renders a card in the Web UI and reports a free-text
 * `custom` answer, so an arbitrary absolute path is expressible.
 *
 * Human answering is only valid for the live runtime root; a delegated child
 * raises `DELEGATED_CALLER`, which callers treat as "no chooser available" so a
 * subagent export never blocks on an answer it can never receive.
 *
 * @returns `{status:'picked', path}` | `{status:'cancelled'}` | `{status:'unavailable', reason}`
 */
async function askUserForDirectory(ctx, { agent, signal, cwd }) {
  const userQuestions = ctx.get?.('userQuestions')
  if (!userQuestions || typeof userQuestions.ask !== 'function') {
    return { status: 'unavailable', reason: '当前组合没有 userQuestions 服务' }
  }

  const home = homeDirectory()
  const quick = [
    { label: '工作区 exports 目录', path: `${cwd.replace(/[\\/]+$/, '')}/exports`, note: '默认位置' },
    ...(home
      ? [
          { label: '桌面', path: `${home}\\Desktop`, note: '方便直接找到' },
          { label: '文档', path: `${home}\\Documents`, note: '归档用' },
        ]
      : []),
  ]

  let answer
  try {
    answer = await userQuestions.ask({
      agent,
      // Bounded so a composition without a live answerer cannot hang the call.
      signal: chooserSignal(signal, 120_000),
      questions: [
        {
          id: 'export-dir',
          header: '保存位置',
          question: '把导出文件保存到哪里？',
          detail:
            '可选下面的常用位置，或直接在输入框里填写绝对路径（如 D:\\会话导出）。目录不存在会自动创建。',
          options: quick.map((o) => ({ label: o.label, description: `${o.note} · ${o.path}` })),
          multiSelect: false,
        },
      ],
    })
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'DELEGATED_CALLER') {
      return { status: 'unavailable', reason: '子代理无法弹出选择（只有主会话能回答）' }
    }
    if (error?.name === 'AbortError' || code === 'ASK_ABORTED') {
      return { status: 'cancelled' }
    }
    return { status: 'unavailable', reason: error?.message ?? String(error) }
  }

  const item = Array.isArray(answer?.answers)
    ? answer.answers.find((entry) => entry?.id === 'export-dir')
    : undefined

  const typed = String(item?.custom ?? '').trim()
  if (typed) return { status: 'picked', path: typed }

  const selectedLabel = Array.isArray(item?.selected) ? item.selected[0] : undefined
  const matched = quick.find((entry) => entry.label === selectedLabel)
  if (matched) return { status: 'picked', path: matched.path }

  return { status: 'cancelled' }
}

/**
 * Resolve where to save: an explicit directory, the OS chooser when composed,
 * otherwise DSH's question card. Returns `null` when the operator declined.
 */
async function requestOutputDirectory(ctx, { agent, signal, cwd }) {
  const native = await pickNativeDirectory(ctx, signal)
  if (native.status !== 'unavailable') return native

  const asked = await askUserForDirectory(ctx, { agent, signal, cwd })
  if (asked.status !== 'unavailable') return asked

  return { status: 'unavailable', reason: `${native.reason}；${asked.reason}` }
}

/** The agent's effective working directory, without needing a snapshot yet. */
async function agentCwd(ctx, agent, signal) {
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory) {
    try {
      if (agent && typeof workingDirectory.ensure === 'function') {
        const ensured = await workingDirectory.ensure(agent, signal)
        if (typeof ensured === 'string' && ensured) return ensured
      }
      if (typeof workingDirectory.defaultDirectory === 'string') {
        return workingDirectory.defaultDirectory
      }
    } catch {
      // fall through to the process directory
    }
  }
  return process.cwd()
}

async function runExport(ctx, request, context = {}) {
  const { signal } = context
  const options = { ...DEFAULTS, ...request }
  const formats = Array.isArray(options.formats) && options.formats.length > 0
    ? options.formats
    : DEFAULTS.formats

  // 1. Freeze one snapshot first; nothing after this point may observe newer events.
  const snapshot = await collectFleetSnapshot(ctx, options.sessionId, { signal })

  const cwd = resolveCwd(ctx, snapshot)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  // One redactor per file so each document reports its own tally while sharing
  // exactly the same rule set.
  const makeRedactor = () =>
    createRedactor({
      enabled: options.redact,
      home: process.env.USERPROFILE || process.env.HOME || '',
      cwd,
    })
  const summaryRedactor = makeRedactor()
  const rawRedactor = makeRedactor()

  const exportId = `${stamp(snapshot.generatedAt)}-${fnv1a(`${snapshot.rootBare}|${snapshot.generatedAt}`)}`
  const title = cleanTitle(snapshot.rootSession?.title, snapshot.rootBare.slice(0, 8))
  const baseName = `${slugify(title)}_${snapshot.rootBare.slice(0, 8)}_${stamp(snapshot.generatedAt)}`

  const summaryName = `${baseName}.summary.md`
  const rawName = `${baseName}.raw.md`

  const baseRenderOptions = {
    includeReasoning: options.includeReasoning,
    includeSystemPrompt: options.includeSystemPrompt,
    toolResultMaxChars: options.toolResultMaxChars,
    timeZone,
    rawFileName: rawName,
    summaryFileName: summaryName,
  }

  // 2. Render both files in memory before touching the disk, so a rendering
  //    failure cannot leave a half-written pair behind.
  const pending = []
  let summaryText = null
  let rawText = null

  snapshot.sessions = snapshot.sessions.map((session) => ({
    ...session,
    rawFileName: rawName,
  }))
  snapshot.meta = { exportId }

  if (formats.includes('summary')) {
    summaryText = renderSummary(snapshot, {
      ...baseRenderOptions,
      redact: summaryRedactor.redact,
      redactionReport: summaryRedactor.report,
    })
    pending.push({ name: summaryName, content: summaryText, kind: 'summary' })
  }
  if (formats.includes('raw')) {
    rawText = renderRaw(snapshot, {
      ...baseRenderOptions,
      redact: rawRedactor.redact,
      redactionReport: rawRedactor.report,
    })
    pending.push({ name: rawName, content: rawText, kind: 'raw' })
  }

  const digest = fnv1a(`${exportId}|${summaryText ?? ''}|${rawText ?? ''}`)

  // 3. Write.
  const dirAbsolute = resolveOutputDir(cwd, options.outputDir)
  const written = await writePair(ctx, dirAbsolute, pending, context)

  return {
    ok: true,
    exportId,
    digest,
    title,
    rootSession: snapshot.rootBare,
    sessionCount: snapshot.coverage.sessionCount,
    eventCount: snapshot.coverage.totalEvents,
    warnings: snapshot.warnings,
    outputDir: dirAbsolute,
    files: written.map((file) => ({
      name: file.name,
      kind: file.kind,
      bytes: byteLength(file.content),
      path: `${dirAbsolute}/${file.name}`,
    })),
    redaction: rawRedactor.report(),
    generatedAt: snapshot.generatedAt,
    timeZone,
  }
}

function formatReceipt(result) {
  const lines = []
  lines.push(`✅ 已导出会话树「${result.title}」`)
  lines.push('')
  lines.push(`- 导出 ID：\`${result.exportId}\``)
  lines.push(`- 会话数：${result.sessionCount}　事件数：${result.eventCount}`)
  lines.push(`- 脱敏：${result.redaction.enabled ? `${result.redaction.total} 处` : '未启用'}`)
  lines.push('')
  lines.push('| 文件 | 大小 |')
  lines.push('| --- | --- |')
  for (const file of result.files) {
    lines.push(`| \`${file.name}\` | ${humanBytes(file.bytes)} |`)
  }
  lines.push('')
  lines.push(`目录：\`${result.outputDir}\``)
  if (result.warnings.length > 0) {
    lines.push('')
    lines.push(`⚠️ ${result.warnings.length} 条提示：`)
    for (const warning of result.warnings.slice(0, 5)) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

const parameterSchema = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description:
        '要导出的会话 ID（导出整棵智能体编队树）。省略则导出当前会话所在的编队树。',
    },
    includeSystemPrompt: {
      type: 'boolean',
      description: '是否包含 system prompt 原文。默认 false（隐私与体积考虑）。',
    },
    includeReasoning: {
      type: 'boolean',
      description: '是否包含 reasoning 思考过程（raw 中默认折叠）。默认 true。',
    },
    redact: {
      type: 'boolean',
      description: '是否对 key/token/家目录路径做正则脱敏。默认 true。',
    },
    toolResultMaxChars: {
      type: 'integer',
      description: '单个工具结果/参数在 raw 中超过该字符数时折叠。默认 6000。',
    },
    outputDir: {
      type: 'string',
      description:
        '输出目录。省略时会在导出前弹出目录选择器让用户指定保存位置；给定则直接使用。可写相对会话工作区的路径（如 exports），也可写绝对路径（如 D:\\会话导出）。目录不存在时会自动创建。',
    },
    formats: {
      type: 'array',
      items: { type: 'string', enum: ['summary', 'raw'] },
      description: '要生成的文件类型。默认两者都生成。',
    },
  },
  additionalProperties: false,
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        '把当前会话及其完整智能体编队导出为两份 Markdown：可读的时间流水叙事摘要（summary.md）与包含全部事件的原始存档（raw.md）。' +
        '只读导出，不会修改会话内容。可指定 sessionId 导出历史会话树。',
      parameters: parameterSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            exportId: { type: 'string' },
            outputDir: { type: 'string' },
            sessionCount: { type: 'integer' },
            eventCount: { type: 'integer' },
            files: { type: 'array', items: { type: 'object' } },
            warnings: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: true,
        },
        render(_args, value) {
          const result = value ?? {}
          if (!result.ok) {
            return [{ type: 'text', text: `❌ 导出失败：${result.error ?? '未知错误'}` }]
          }
          return [{ type: 'text', text: formatReceipt(result) }]
        },
      },
      isConcurrencySafe() {
        // Export reads the frozen log and writes uniquely named files.
        return true
      },
      async execute(args, exec) {
        const request = { ...(args ?? {}) }
        if (!request.sessionId) {
          const agentId = exec.agent?.id ?? exec.agent
          if (agentId) request.sessionId = String(agentId)
        }
        if (!request.sessionId) {
          return { ok: false, error: '无法确定要导出的会话 ID' }
        }

        // No explicit target: let the operator pick where to save, before any
        // rendering work happens. An explicit outputDir skips the chooser.
        if (!request.outputDir) {
          const choice = await requestOutputDirectory(ctx, {
            agent: exec.agent,
            signal: exec.signal,
            cwd: await agentCwd(ctx, exec.agent, exec.signal),
          })
          if (choice.status === 'cancelled') {
            return { ok: false, error: '已取消导出（未选择保存位置）' }
          }
          if (choice.status === 'picked') request.outputDir = choice.path
        }

        try {
          return await runExport(ctx, request, { signal: exec.signal, agent: exec.agent })
        } catch (error) {
          return {
            ok: false,
            error: error?.message ?? String(error),
            writtenBefore: error?.writtenBefore ?? [],
          }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.commands.register({
      name: COMMAND_NAME,
      description: '把当前会话及其智能体编队导出为 summary.md + raw.md',
      input: { hint: '[outputDir]' },
      recordInput: false,
      async handler(invocation) {
        const dirArg = String(invocation.rawInput ?? '').trim()
        const agentId = invocation.agent?.id
        if (!agentId) {
          return { kind: 'error', text: '无法确定当前会话 ID' }
        }

        // With no explicit target, ask the operator where to save.
        let outputDir = dirArg || undefined
        let note = ''
        if (!outputDir) {
          const choice = await requestOutputDirectory(ctx, {
            agent: invocation.agent,
            signal: invocation.signal,
            cwd: await agentCwd(ctx, invocation.agent, invocation.signal),
          })
          if (choice.status === 'cancelled') {
            return { kind: 'success', text: '已取消导出（未选择保存位置）' }
          }
          if (choice.status === 'picked') {
            outputDir = choice.path
          } else {
            note = `未能询问保存位置（${choice.reason}），改用默认目录。\n\n`
          }
        }

        try {
          const result = await runExport(
            ctx,
            { sessionId: String(agentId), ...(outputDir ? { outputDir } : {}) },
            { signal: invocation.signal, agent: invocation.agent },
          )
          return { kind: 'success', text: `${note}${formatReceipt(result)}` }
        } catch (error) {
          return { kind: 'error', text: `导出失败：${error?.message ?? String(error)}` }
        }
      },
    }),
  )
}
