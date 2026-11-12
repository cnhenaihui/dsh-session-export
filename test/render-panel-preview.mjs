/**
 * Render the export directory browser to standalone HTML for a visual check.
 *
 * The panel is normally created through the Client bundle, but the layout can be
 * verified without the harness: this drives the same component tree through a
 * tiny HTML serializer and prints a page with representative Host data,
 * including the EPERM error state seen in the real app.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// A minimal React stand-in that produces plain data, then serializes to HTML.
const stateSlots = []
let stateCursor = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) }
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

let bundle = null
globalThis.window = {
  innerHeight: 900,
  __ModuleLoader__: {
    load({ factory }) {
      bundle = factory((spec) => {
        if (spec === 'react') return React
        if (spec === 'react-dom') return { createPortal: (node) => node }
        throw new Error(`unexpected require(${spec})`)
      })
    },
  },
}
globalThis.document = { body: {} }

eval(readFileSync(join(root, 'client.js'), 'utf8'))

// Capture the registered component.
let registration = null
const services = {
  locale: { register: () => () => {}, bind: () => (key) => key },
  uiWorkspace: { listDirectory: async () => null, pickDirectory: async () => null },
  'remote.commands': { execute: async () => ({ ok: true, value: { result: { kind: 'success' } } }) },
}
const ctx = {
  get: (key) => services[key],
  slots: {
    inject: (_name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
  effect: (fn) => fn(),
}
bundle.apply(ctx)
const DirectoryBrowser = registration.component.DirectoryBrowser

// --- serialize a rendered tree to HTML --------------------------------------
const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ESCAPE[c])

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr'])
const toCss = (style) =>
  Object.entries(style ?? {})
    .map(([key, value]) => {
      const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      return `${name}:${typeof value === 'number' ? `${value}px` : value}`
    })
    .join(';')

const serialize = (node) => {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node.type === 'function') {
    // Render the sub-component with its props, restoring the state cursor so a
    // nested component's useState does not disturb the parent's slots.
    const saved = stateCursor
    stateCursor = 0
    const rendered = node.type(node.props ?? {})
    stateCursor = saved
    return serialize(rendered)
  }
  const props = node.props ?? {}
  const attrs = Object.entries(props)
    .filter(([key]) => !['onClick', 'onChange', 'onKeyDown', 'onMouseEnter', 'onMouseLeave', 'children', 'key', 'ref'].includes(key))
    .map(([key, value]) => {
      if (key === 'style') return `style="${esc(toCss(value))}"`
      if (value === true) return key
      if (value === false || value == null) return ''
      return `${key}="${esc(value)}"`
    })
    .filter(Boolean)
    .join(' ')
  const open = `<${node.type}${attrs ? ` ${attrs}` : ''}${VOID_TAGS.has(node.type) ? '/>' : '>'}`
  if (VOID_TAGS.has(node.type)) return open
  return `${open}${node.children.map(serialize).join('')}</${node.type}>`
}

// --- representative states ---------------------------------------------------
const listing = {
  path: 'C:\\Users\\user\\Documents\\projects\\demo-workspace',
  home: 'C:\\Users\\user',
  crumbs: [
    { name: 'C:', path: 'C:\\', hidden: false },
    { name: 'Users', path: 'C:\\Users', hidden: false },
    { name: 'user', path: 'C:\\Users\\user', hidden: false },
    { name: 'Documents', path: 'C:\\Users\\user\\Documents', hidden: false },
    { name: 'projects', path: 'C:\\Users\\user\\Documents\\projects', hidden: false },
    { name: 'demo-workspace', path: 'C:\\Users\\user\\Documents\\projects\\demo-workspace', hidden: false },
  ],
  entries: [
    { name: 'dsh-session-export', path: 'C:\\…\\dsh-session-export', hidden: false },
    { name: 'exports', path: 'C:\\…\\exports', hidden: false },
    { name: 'export-test', path: 'C:\\…\\export-test', hidden: false },
    { name: 'emp_platform', path: 'C:\\…\\emp_platform', hidden: false },
  ],
  truncated: false,
}

const words = {
  pickingTitle: '选择保存位置',
  loading: '读取目录…',
  emptyDir: '（没有子目录）',
  useThisFolder: '使用此文件夹',
  cancel: '取消',
  pathPlaceholder: '直接输入路径，如 D:\\会话导出',
  go: '前往',
}

const renderPanel = (state) => {
  stateCursor = 0
  stateSlots.length = 0
  return serialize(DirectoryBrowser({ state, words, onNavigate() {}, onCommit() {}, onClose() {} }))
}

const okPanel = renderPanel({ listing, error: null, loading: false, anchor: { left: 40, bottom: 120 } })
const errPanel = renderPanel({
  listing: { ...listing, path: 'C:\\Users\\user', crumbs: listing.crumbs.slice(0, 3) },
  error:
    'directory browse failed: directory-picker/unreadable: cannot list C:\\Users\\user\\Documents: EPERM: operation not permitted',
  loading: false,
  anchor: { left: 40, bottom: 120 },
})

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; padding:24px; background:#eef1f5; font:13px/1.5 "Segoe UI",system-ui,sans-serif; color:#222; }
  h2 { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8a8f98; margin:0 0 8px; }
  /* Let the panel take its natural height: a fixed stage height would squeeze
     the scroll area and misrepresent what the operator sees. */
  .stage { position:relative; margin-bottom:26px; padding:12px; background:#e7ebf1; border-radius:10px; }
  .stage > div { position:static !important; left:auto !important; bottom:auto !important; }
</style></head><body>
<h2>Normal listing</h2>
<div class="stage">${okPanel}</div>
<h2>Unreadable child (EPERM junction)</h2>
<div class="stage">${errPanel}</div>
</body></html>`

const out = join(root, 'preview', 'browser-preview.html')
writeFileSync(out, page, 'utf8')
console.log(out)
