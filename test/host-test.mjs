/**
 * Offline checks for the pure Host helpers.
 *
 * `resolveOutputDir` decides whether a chosen path is used verbatim or joined to
 * the workspace. Getting it wrong silently writes to a mangled directory — an
 * earlier hand-rolled version turned `D:\会话导出` into `<cwd>/D:会话导出` — so it
 * gets a table of expectations instead of a live export.
 *
 * Expectations are computed with `node:path`, because that is exactly the
 * behaviour being delegated to: the point of these cases is to pin the inputs
 * the plugin sees, not to re-derive path semantics by hand.
 *
 * Run: node test/host-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolve as resolvePath, sep } from 'node:path'

import { canWriteDir, slugify } from '../lib/util.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')

// The function is not exported, so lift its exact source out of the module and
// supply the one import it closes over.
const match = source.match(/function resolveOutputDir\(cwd, outputDir\) \{[\s\S]*?\n\}/)
if (match === null) {
  console.log('FAIL could not locate resolveOutputDir in index.js')
  process.exit(1)
}
const resolveOutputDir = new Function('resolvePath', `${match[0]}; return resolveOutputDir;`)(resolvePath)

const isWindows = sep === '\\'
const CWD = isWindows ? 'C:\\Users\\me\\ws' : '/home/me/ws'

/**
 * @param label   what the case proves
 * @param input   the `outputDir` the operator supplied
 * @param expect  the resolved directory, or a function receiving the workspace
 */
const cases = [
  ['blank falls back to the workspace', '', () => CWD],
  ['undefined falls back to the workspace', undefined, () => CWD],
  ['whitespace falls back to the workspace', '   ', () => CWD],
  ['relative joins under the workspace', 'exports', (ws) => resolvePath(ws, 'exports')],
  ['nested relative joins', '归档/1029', (ws) => resolvePath(ws, '归档/1029')],
  ['trailing separator is trimmed', 'exports/', (ws) => resolvePath(ws, 'exports')],
]

// Absolute-path handling differs by platform, so each case says which one it
// describes. This is the whole reason the helper delegates to `path.resolve`.
if (isWindows) {
  cases.push(
    ['windows drive path is used verbatim', 'D:\\会话导出', () => 'D:\\会话导出'],
    ['windows drive path with forward slashes', 'D:/会话导出', () => 'D:\\会话导出'],
    ['absolute with trailing separator is normalised', 'D:\\out\\', () => 'D:\\out'],
    ['lowercase drive letter is preserved', 'e:\\out', () => 'e:\\out'],
    ['a leading separator means the drive root, not the workspace', '/exports', () => 'C:\\exports'],
    ['a bare drive letter stays drive-relative', 'D:', () => resolvePath(CWD, 'D:')],
    ['a colon inside a name stays relative', 'a:b', (ws) => resolvePath(ws, 'a:b')],
    ['unc path stays absolute', '\\\\server\\share\\out', () => '\\\\server\\share\\out'],
  )
} else {
  cases.push(
    ['posix absolute path is used verbatim', '/home/me/out', () => '/home/me/out'],
    ['absolute with trailing separator is normalised', '/home/me/out/', () => '/home/me/out'],
    ['a colon inside a name stays relative', 'a:b', (ws) => resolvePath(ws, 'a:b')],
    ['a dot segment is normalised', 'a/../b', (ws) => resolvePath(ws, 'a/../b')],
  )
}

let failures = 0
for (const [label, input, expect] of cases) {
  const expected = typeof expect === 'function' ? expect(CWD) : expect
  const actual = resolveOutputDir(CWD, input)
  if (actual === expected) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(
      `  FAIL ${label}\n         input    ${JSON.stringify(input)}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`,
    )
  }
}

// The behaviour that motivated the rewrite, asserted directly.
const regression = resolveOutputDir(CWD, 'D:\\会话导出')
if (isWindows && regression.includes('ws/D:')) {
  failures += 1
  console.log(`  FAIL absolute path was mangled into the workspace: ${JSON.stringify(regression)}`)
} else {
  console.log('  ok   no workspace-prefixed absolute path')
}

/**
 * Writability, which drives the "save to the workspace instead of failing"
 * fallback. Every case here is a shape the sandbox reports on this platform.
 */
const policyCases = [
  ['workspace-write allows the workspace itself', CWD, { mode: 'workspace-write', workspaceRoot: CWD }, true],
  ['workspace-write allows a child', `${CWD}\\exports`, { mode: 'workspace-write', workspaceRoot: CWD }, true],
  ['workspace-write rejects a sibling', `${CWD}-other\\exports`, { mode: 'workspace-write', workspaceRoot: CWD }, false],
  ['workspace-write rejects the desktop', 'C:\\Users\\me\\Desktop', { mode: 'workspace-write', workspaceRoot: CWD }, false],
  ['trailing separators do not break containment', `${CWD}\\exports\\`, { mode: 'workspace-write', workspaceRoot: `${CWD}\\` }, true],
  ['case differences do not break containment', 'c:\\USERS\\me\\ws\\out', { mode: 'workspace-write', workspaceRoot: 'C:\\Users\\me\\ws' }, true],
  ['danger-full-access allows anything', 'D:\\随便\\哪', { mode: 'danger-full-access' }, true],
  ['an unknown mode is not pre-judged', 'D:\\out', { mode: 'something-new', workspaceRoot: CWD }, true],
  ['a missing policy is not pre-judged', 'D:\\out', undefined, true],
  ['read-only without a root is not pre-judged', 'D:\\out', { mode: 'read-only' }, true],
]

for (const [label, dir, policy, expected] of policyCases) {
  const actual = canWriteDir(dir, policy)
  if (actual === expected) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}\n         dir      ${JSON.stringify(dir)}\n         expected ${expected}\n         actual   ${actual}`)
  }
}

/**
 * File-name slugs. A session titled `本地插件：技能管理插件维护` used to produce
 * `本地插件：技能管理插件维护_….summary.md`, and the full-width colon is hostile
 * to zip/tooling even where NTFS allows it.
 */
const slugCases = [
  ['full-width colon is folded', '本地插件：技能管理插件维护', '本地插件-技能管理插件维护'],
  ['half-width path characters are folded', 'a/b:c*d?e"f<g>h|i', 'a-b-c-d-e-f-g-h-i'],
  ['a reserved device name is made safe', 'CON', 'CON-export'],
  ['blank input falls back', '   ', 'session'],
  ['trailing dots are trimmed', 'trailing dots...', 'trailing-dots'],
]

for (const [label, input, expected] of slugCases) {
  const actual = slugify(input)
  if (actual === expected) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}\n         input    ${JSON.stringify(input)}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`)
  }
}

const total = cases.length + 1 + policyCases.length + slugCases.length
console.log()
if (failures === 0) {
  console.log(`all ${total} host checks passed`)
} else {
  console.log(`${failures} host check(s) failed`)
  process.exitCode = 1
}
