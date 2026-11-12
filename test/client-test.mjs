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

/**
 * `react-dom` is a seeded module in the real shell, so the bundle may require
 * it. The stub records portal calls instead of touching a DOM.
 */
const portalCalls = []
const ReactDOM = {
  createPortal(node, container) {
    portalCalls.push({ node, container })
    return { __portal: true, node, container }
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      check('bundle id equals the package name', id === '@cnhenaihui/dsh-session-export', id)
      moduleExports = factory((spec) => {
        if (spec === 'react') return React
        if (spec === 'react-dom') return ReactDOM
        throw new Error(`unexpected require("${spec}")`)
      })
    },
  },
  innerHeight: 900,
}

// The portal target: `createPortal(..., document.body)`.
globalThis.document = { body: { __isBody: true } }

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
const listingCalls = []

/** One fake Host filesystem level, keyed by directory path. */
const LISTINGS = {
  'C:\\Users\\me\\ws': {
    path: 'C:\\Users\\me\\ws',
    home: 'C:\\Users\\me',
    crumbs: [
      { name: 'C:', path: 'C:\\', hidden: false },
      { name: 'ws', path: 'C:\\Users\\me\\ws', hidden: false },
    ],
    entries: [
      { name: 'exports', path: 'C:\\Users\\me\\ws\\exports', hidden: false },
      { name: '归档', path: 'C:\\Users\\me\\ws\\归档', hidden: false },
    ],
    truncated: false,
  },
  'C:\\Users\\me\\ws\\归档': {
    path: 'C:\\Users\\me\\ws\\归档',
    home: 'C:\\Users\\me',
    crumbs: [
      { name: 'C:', path: 'C:\\', hidden: false },
      { name: 'ws', path: 'C:\\Users\\me\\ws', hidden: false },
      { name: '归档', path: 'C:\\Users\\me\\ws\\归档', hidden: false },
    ],
    entries: [],
    truncated: false,
  },
}

const uiWorkspace = {
  async pickDirectory() {
    pickerCalls.push('workspace')
    // Mirrors the browse-only Host picker, which refuses native picks.
    throw new Error('directoryPicker.pick needs the native capability; the composed picker serves "browse"')
  },
  async listDirectory(target) {
    listingCalls.push(target)
    const key = target ?? 'C:\\Users\\me\\ws'
    const listing = LISTINGS[key]
    if (!listing) throw new Error(`cannot list "${key}"`)
    return listing
  },
}

/**
 * Mirror the real Cordis context proxy: anything that is not injected throws on
 * plain property access with exactly the message the browser shows. An earlier
 * `?? ctx.remote` fallback only surfaced this at runtime, as a stray red note
 * next to the button, so the stub has to be strict for the suite to catch it.
 */
const services = { locale, uiWorkspace, 'remote.commands': commandsService }

/**
 * `sessions.scope(id)` exposes the session's working directory; the browser uses
 * it as its first level instead of the Host home.
 */
const sessions = {
  scope() {
    return { cwd: 'C:\\Users\\me\\ws' }
  },
}
services.sessions = sessions
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

/**
 * The in-app browser is an anonymous function component, so it is identified by
 * the props it receives rather than by identity. `onNavigate` + `onCommit` +
 * `onClose` only exist on that node.
 */
const isBrowserNode = (node) =>
  node != null &&
  typeof node === 'object' &&
  typeof node.props?.onNavigate === 'function' &&
  typeof node.props?.onCommit === 'function' &&
  typeof node.props?.onClose === 'function'

/** Find the browser node anywhere in a rendered tree, including through a portal. */
const findBrowser = (node) => {
  if (node == null || typeof node !== 'object') return null
  // A portal wrapper produced by the react-dom stub.
  if (node.__portal) return findBrowser(node.node)
  if (isBrowserNode(node)) return node
  for (const child of node.children ?? []) {
    const found = findBrowser(child)
    if (found) return found
  }
  return null
}

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
  /** Render the registered component and return the button node. */
  const render = () => {
    stateCursor = 0
    return registration.component({ sessionId: 'session-abc' })
  }
  const mount = () => render().children.find((child) => child?.type === 'button')

  /** The in-app browser currently in the tree, or null. */
  const browserState = () => {
    const node = findBrowser(render())
    return node ? node.props.state : null
  }
  const browserNavigate = async (target) => {
    const node = findBrowser(render())
    if (!node) throw new Error('no browser rendered')
    await node.props.onNavigate(target)
  }
  const browserCommit = () => {
    const node = findBrowser(render())
    if (!node) throw new Error('no browser rendered')
    node.props.onCommit()
  }
  /** Let queued promise continuations run. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  // --- path 1: a real OS dialog exists and succeeds -------------------------
  globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'D:\\会话导出'
  executed.length = 0
  await mount().props.onClick()
  check('bridge pick executes one command', executed.length === 1, JSON.stringify(executed))
  check(
    'bridge pick passes the chosen directory',
    executed[0]?.line === '/md-export D:\\会话导出',
    executed[0]?.line,
  )
  check('bridge pick addresses the right session', executed[0]?.sessionId === 'session-abc', executed[0]?.sessionId)
  check(
    'bridge pick passes an attachments array',
    Array.isArray(executed[0]?.attachments) && executed[0].attachments.length === 0,
  )
  delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__

  // --- path 2: browse-only Host picker falls back to the in-app browser -----
  executed.length = 0
  listingCalls.length = 0
  await mount().props.onClick()
  check('browse-only picker falls back instead of erroring', listingCalls.length === 1, JSON.stringify(listingCalls))
  // The browser must not start at the Host home: on Windows that level usually
  // contains junctions the Host cannot `opendir`, failing the whole listing.
  check(
    'browser starts at the session working directory',
    listingCalls[0] === 'C:\\Users\\me\\ws',
    JSON.stringify(listingCalls),
  )
  check('fallback runs no export yet', executed.length === 0, JSON.stringify(executed))
  check('fallback opened the in-app browser', browserState() !== null)
  // This build's dock slot docs require fixed overlays to portal out of the
  // scrolling composer, so the browser must render into document.body.
  check('browser portals out of the composer', portalCalls.length > 0, `${portalCalls.length} portal call(s)`)
  check(
    'browser portals into document.body',
    portalCalls.at(-1)?.container === globalThis.document.body,
    JSON.stringify(portalCalls.at(-1)?.container),
  )
  check(
    'fallback shows no picker complaint',
    !stateSlots.some((value) => typeof value === 'string' && value.includes('native capability')),
    JSON.stringify(stateSlots.filter((v) => typeof v === 'string')),
  )

  // Walking into a folder and committing it exports to that folder.
  await browserNavigate('C:\\Users\\me\\ws\\归档')
  check('navigated into a child folder', browserState()?.listing?.path === 'C:\\Users\\me\\ws\\归档')
  browserCommit()
  await flush()
  check('commit runs one export', executed.length === 1, JSON.stringify(executed))
  check(
    'commit exports into the browsed folder',
    executed[0]?.line === '/md-export C:\\Users\\me\\ws\\归档',
    executed[0]?.line,
  )
  check('commit closes the browser', browserState() === null)

  // --- path 3: no picker service at all ------------------------------------
  executed.length = 0
  const savedList = uiWorkspace.listDirectory
  const savedPick = uiWorkspace.pickDirectory
  delete uiWorkspace.listDirectory
  delete uiWorkspace.pickDirectory
  stateSlots.length = 0
  await mount().props.onClick()
  check('no picker service runs no export', executed.length === 0, JSON.stringify(executed))
  check(
    'no picker service explains itself',
    stateSlots.some((value) => typeof value === 'string' && value.includes('目录选择')),
    JSON.stringify(stateSlots.filter((v) => typeof v === 'string')),
  )
  uiWorkspace.listDirectory = savedList
  uiWorkspace.pickDirectory = savedPick

  // --- a handler error must be surfaced as a note --------------------------
  globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'D:\\x'
  commandsResult.value = { result: { kind: 'error', text: '导出失败：磁盘已满' } }
  stateSlots.length = 0
  await mount().props.onClick()
  check('handler error becomes a note', stateSlots.some((value) => value === '导出失败：磁盘已满'))
  delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
  commandsResult.value = { result: { kind: 'success', text: 'done' } }

  // Cancelling the OS dialog must not run any command.
  globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => null
  executed.length = 0
  await mount().props.onClick()
  check('cancel runs no command', executed.length === 0, JSON.stringify(executed))
  delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__

  // --- a missing command channel explains itself ---------------------------
  executed.length = 0
  stateSlots.length = 0
  const savedCommandsService = services['remote.commands']
  delete services['remote.commands']
  globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'D:\\y'
  await mount().props.onClick()
  check('missing command channel runs nothing', executed.length === 0)
  check(
    'missing command channel explains itself',
    stateSlots.some((value) => typeof value === 'string' && value.includes('命令通道')),
    JSON.stringify(stateSlots.filter((v) => typeof v === 'string')),
  )
  services['remote.commands'] = savedCommandsService
  delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__

  // --- the strictness checks the earlier bugs taught us --------------------
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
    check('renders with no locale service', threw === null, threw?.message)
    services.locale = savedLocale
  }

  {
    delete services['remote.commands']
    // A `remote` object exists here only to prove the component never reaches
    // for `.commands` on it; the real Client has no such service at all.
    services.remote = {}
    let touched = null
    stateCursor = 0
    globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ = async () => 'D:\\z'
    const probeTree = registration.component({ sessionId: 'session-abc' })
    const probeButton = probeTree.children.find((child) => child?.type === 'button')
    try {
      await probeButton.props.onClick()
    } catch (error) {
      touched = error
    }
    check('missing remote.commands throws no property error', touched === null, touched?.message)
    delete services.remote
    delete globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
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
