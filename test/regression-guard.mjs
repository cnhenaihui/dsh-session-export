/**
 * Meta-test: prove the client suite actually catches the regression that took a
 * round of user-visible debugging to find.
 *
 * The bug was `ctx.get('remote') ?? ctx.remote`: Cordis throws on bare property
 * access for any service a plugin did not inject, so a gracefully-absent service
 * became a thrown error shown next to the button. The stub must reproduce that
 * strictness or the suite passes while the browser fails.
 *
 * Run: node test/regression-guard.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

const PATCHES = [
  {
    label: 'walking through a nonexistent `remote` parent',
    from: "const commands = ctx.get?.('remote.commands')",
    to: "const commands = ctx.get?.('remote')?.commands",
  },
  {
    label: 'bare ctx property fallback',
    from: "const commands = ctx.get?.('remote.commands')",
    to: "const commands = ctx.get?.('remote.commands') ?? ctx['remote.commands']",
  },
  {
    label: 'reading .button off the bind() result',
    from: 'if (typeof bound === \'function\') lookup = bound',
    to: 'lookup = bound.button',
  },
]

const buggyPath = join(root, '.client-buggy.js')
let failures = 0

for (const patch of PATCHES) {
  if (!source.includes(patch.from)) {
    console.log(`  FAIL ${patch.label}: anchor not found in client.js`)
    failures += 1
    continue
  }
  const buggy = source.replace(patch.from, patch.to)
  writeFileSync(buggyPath, buggy, 'utf8')

  const testSource = readFileSync(join(here, 'client-test.mjs'), 'utf8').replace(
    "join(here, '..', 'client.js')",
    "join(here, '..', '.client-buggy.js')",
  )
  const testPath = join(root, '.client-buggy-test.mjs')
  writeFileSync(testPath, testSource, 'utf8')

  let output = ''
  let failed = false
  try {
    output = execFileSync(process.execPath, [testPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    failed = true
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const caught = failed || /FAIL|not passed|failed/.test(output)
  if (caught) {
    console.log(`  ok   suite catches: ${patch.label}`)
  } else {
    failures += 1
    console.log(`  FAIL suite missed: ${patch.label} (tests still passed with the bug in place)`)
  }

  unlinkSync(testPath)
  unlinkSync(buggyPath)
}

console.log()
if (failures === 0) console.log('regression guard: every reverted fix is caught')
else {
  console.log(`regression guard: ${failures} bug(s) went undetected`)
  process.exitCode = 1
}
