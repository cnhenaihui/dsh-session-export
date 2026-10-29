/**
 * Offline harness for the Client half.
 *
 * The browser bundle is a `window.__ModuleLoader__.load({id, factory})` call, so
 * this stubs the loader, `react`, and the cordis context, then drives the
 * registered component through pick → export → result with a fake
 * `remote.commands`. It catches shape mistakes that no syntax check can see.
 *
 * Run: node test/client-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- a minimal React stand-in ------------------------------------------------
const created = []
const stateSlots = []
let stateCursor = 0
const React = {
  createElement(type, props, ...children) {
    const node = { type, props: props ?? {}, children: children.flat().filter((c) => c != null) }
    created.push(node)
    return node
  },
  useState(initial) {
    const index = stateCursor++
    if (!(index in stateSlots)) stateSlots[index] = initial
    return [
      stateSlots[index],
      (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next
      },
    ]
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
}

// --- capture what the module registers --------------------------------------
let registration = null
let moduleExports = null

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      check('bundle id equals the package name', id === '@local/dsh-session-export', id)
      moduleExports = factory((spec) => {
        if (spec === 'react') return React
        throw new Error(`unexpected require("${spec}")`)
      })
    },
  },
}

// --- the cordis context the plugin will receive ------------------------------
const executed = []
const dictionaries = []
const locale = {
  register(ns, id, dict) {
    dictionaries.push([ns, id, dict])
    return () => {}
  },
  // Mirrors the real service: `bind(ns)` returns a LOOKUP FUNCTION
  // `(key, params) => string` that echoes the key back when unknown. An earlier
  // stub returned `undefined`, which made every render fall back silently and
  // hid a real bug where the component read `.button` off that function.
  bind(ns) {
    return (key) => {
      for (const [registeredNs, id, dict] of dictionaries) {
        if (registeredNs !== ns || id !== 'zh') continue
        if (dict[key] !== undefined) return dict[key]
      }
      return key
    }
  },
}

const commandsResult = { ok: true, value: { result: { kind: 'success', text: 'done' } } }

// The Client serves `remote.commands` as ONE flat name containing a dot — there
// is no `remote` parent object. Modelling it as nested (`{ remote: { commands } }`)
// is exactly what hid the real bug, so the stub keys it verbatim.
const commandsService = {
  async execute(sessionId, line, attachments) {
    executed.push({ sessionId, line, attachments })
    return commandsResult
  },
}

const pickerCalls = []
const uiWorkspace = {
  async pickDirectory() {
    pickerCalls.push('workspace')
    return 'D:\\会话导出'
  },
}

/**
 * Mirror the real Cordis context proxy: anything that is not injected throws on
 * plain property access with exactly the message the browser shows. An earlier
 * `?? ctx.remote` fallback only surfaced this at runtime, as a stray red note
 * next to the button, so the stub has to be strict for the suite to catch it.
 */
const services = { locale, uiWorkspace, 'remote.commands': commandsService }
const rawCtx = {
  get(key) {
    return services[key]
  },
  slots: {
    inject(_name, callback) {
      const result = callback()
      return () => result
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

// A plugin may read a service by plain property access only when it declared
// that exact name in `inject`; `get`/`effect` are context verbs, always allowed.
const INJECTED = new Set(['slots', 'remote.commands', 'get', 'effect'])

const ctx = new Proxy(rawCtx, {
  get(target, prop) {
    if (typeof prop === 'symbol') return Reflect.get(target, prop)
    if (INJECTED.has(prop) || Reflect.has(target, prop)) return Reflect.get(target, prop)
    // Cordis: `cannot get property "X" without inject`
    throw new Error(`cannot get property "${prop}" without inject`)
  },
})

// --- drive it ----------------------------------------------------------------
console.log('client bundle')
eval(source)
check('factory returned a plugin', moduleExports != null && typeof moduleExports.apply === 'function')

const inject = moduleExports.inject ?? []
console.log('  inject:', JSON.stringify(inject))
check('injects slots', inject.includes('slots'))
// `remote.commands` is a flat Client service name; declaring it is how the
// facade permits reading it at all.
check('injects remote.commands', inject.includes('remote.commands'))
check('injects exactly the two services it needs', inject.length === 2, JSON.stringify(inject))

moduleExports.apply(ctx)

console.log('slot registration')
check('registered one entry', registration != null)
check(
  'targets conversation.composer.dock',
  registration?.options?.name === 'conversation.composer.dock',
  registration?.options?.name,
)
check('uses its own cell id', registration?.options?.id === 'md-export', registration?.options?.id)
check('declares a label thunk', typeof registration?.options?.label === 'function')

console.log('locale')
check('registered zh dictionary', dictionaries.some(([, id]) => id === 'zh'))
check('registered en dictionary', dictionaries.some(([, id]) => id === 'en'))

// Render once, then simulate the click handler.
console.log('component')
stateCursor = 0
stateSlots.length = 0
const tree = registration.component({ sessionId: 'session-abc' })
check('renders without throwing', tree != null)
const button = tree.children.find((child) => child?.type === 'button')
check('renders a button', button != null)

/** The label lives in a span beside the icon, so read it through the children. */
const labelOf = (node) => {
  const span = node?.children?.find((child) => child?.type === 'span')
  return span?.children?.[0]
}
check('renders an icon', button?.children?.some((child) => child?.type === 'svg'))
check('button label is the idle label', labelOf(button) === '导出会话', labelOf(button))
check('button has a tooltip', typeof button?.props?.title === 'string' && button.props.title.length > 0)

// Prove the locale lookup is actually consulted, not bypassed by the fallback.
// A sentinel registered under the same namespace must win over the built-in text.
{
  const original = dictionaries.slice()
  dictionaries.length = 0
  dictionaries.push(['md-export', 'zh', { button: 'SENTINEL-LABEL' }])
  stateCursor = 0
  const sentinelTree = registration.component({ sessionId: 'session-abc' })
  const sentinelButton = sentinelTree.children.find((child) => child?.type === 'button')
  check(
    'locale lookup overrides the built-in label',
    labelOf(sentinelButton) === 'SENTINEL-LABEL',
    labelOf(sentinelButton),
  )
  dictionaries.length = 0
  dictionaries.push(...original)
}

// The click handler is on the button props.
const click = button.props.onClick
check('button exposes onClick', typeof click === 'function')

const run = async () => {
  await click()
  check('asked the picker once', pickerCalls.length === 1, JSON.stringify(pickerCalls))
  check('executed one command', executed.length === 1, JSON.stringify(executed))
  const call = executed[0]
  check('addressed the right session', call?.sessionId === 'session-abc', call?.sessionId)
  check('used the md-export command', call?.line === '/md-export D:\\会话导出', call?.line)
  check('passed an attachments array', Array.isArray(call?.attachments) && call.attachments.length === 0)

  // Cancelling the dialog must not run any command.
  pickerCalls.length = 0
  executed.length = 0
  uiWorkspace.pickDirectory = async () => {
    pickerCalls.push('workspace')
    return null
  }
  stateCursor = 0
  const second = registration.component({ sessionId: 'session-abc' })
  const secondButton = second.children.find((child) => child?.type === 'button')
  await secondButton.props.onClick()
  check('cancel runs no command', executed.length === 0, JSON.stringify(executed))

  // No picker at all must surface a note, not throw.
  uiWorkspace.pickDirectory = undefined
  const savedBridge = globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
  delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
  pickerCalls.length = 0
  stateCursor = 0
  const third = registration.component({ sessionId: 'session-abc' })
  const thirdButton = third.children.find((child) => child?.type === 'button')
  await thirdButton.props.onClick()
  check('missing picker runs no command', executed.length === 0)
  if (savedBridge !== undefined) globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = savedBridge

  // A handler error must be surfaced as a note.
  pickerCalls.length = 0
  uiWorkspace.pickDirectory = async () => 'D:\\x'
  commandsResult.value = { result: { kind: 'error', text: '导出失败：磁盘已满' } }
  stateCursor = 0
  const fourth = registration.component({ sessionId: 'session-abc' })
  const fourthButton = fourth.children.find((child) => child?.type === 'button')
  await fourthButton.props.onClick()
  check('handler error becomes a note', stateSlots.some((value) => value === '导出失败：磁盘已满'))

  // Without a command channel the click must explain itself, not throw.
  pickerCalls.length = 0
  executed.length = 0
  stateSlots.length = 0
  const savedCommandsService = services['remote.commands']
  delete services['remote.commands']
  stateCursor = 0
  const fifth = registration.component({ sessionId: 'session-abc' })
  const fifthButton = fifth.children.find((child) => child?.type === 'button')
  await fifthButton.props.onClick()
  check('missing command channel runs nothing', executed.length === 0)
  check(
    'missing command channel explains itself',
    stateSlots.some((value) => typeof value === 'string' && value.includes('命令通道')),
    JSON.stringify(stateSlots.filter((v) => typeof v === 'string')),
  )
  services['remote.commands'] = savedCommandsService

  // The bug the strict proxy exists to catch: a `?? ctx.remote` fallback turns a
  // missing service into a thrown error instead of a handled absence.
  {
    const savedLocale = services.locale
    delete services.locale
    stateCursor = 0
    let threw = null
    try {
      registration.component({ sessionId: 'session-abc' })
    } catch (error) {
      threw = error
    }
    check(
      'renders with no locale service',
      threw === null,
      threw?.message,
    )
    services.locale = savedLocale
  }

  // Absent `remote.commands` must not be reached through bare property access
  // either — the flat name has no `remote` parent to walk through.
  {
    delete services['remote.commands']
    // A `remote` object exists here only to prove the component never reaches
    // for `.commands` on it; the real Client has no such service at all.
    services.remote = {}
    let touched = null
    stateCursor = 0
    const probeTree = registration.component({ sessionId: 'session-abc' })
    const probeButton = probeTree.children.find((child) => child?.type === 'button')
    try {
      await probeButton.props.onClick()
    } catch (error) {
      touched = error
    }
    check('missing remote.commands throws no property error', touched === null, touched?.message)
    delete services.remote
    services['remote.commands'] = savedCommandsService
  }

  console.log()
  if (failures === 0) {
    console.log('all client checks passed')
  } else {
    console.log(`${failures} client check(s) failed`)
    process.exitCode = 1
  }
}

await run()
