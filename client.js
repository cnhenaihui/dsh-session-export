window.__ModuleLoader__.load({
  id: '@cnhenaihui/dsh-session-export',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // The shell seeds `react-dom` into the module table, so a fixed overlay can
    // portal to the document body as this build's dock slot requires.
    const { createPortal } = require('react-dom')

    /**
     * Client-side dictionaries. Kept beside the component because the Client
     * runs in the browser bundle and cannot read the package's `locale/*.json`
     * (those describe the Host bundle row).
     */
    const LOCALE_NS = 'md-export'
    const DICTIONARIES = [
      [
        'zh',
        {
          button: '导出会话',
          picking: '选择位置…',
          running: '导出中…',
          tooltip: '把当前会话及其全部子代理导出为 Markdown（摘要 + 原始存档）',
          noPicker: '没有可用的目录选择器，请用 /md-export 命令',
          rejected: '命令未被接受',
          unknown: '未知命令：md-export 未注册',
          failed: '导出失败',
          noChannel: '这个界面没有可用的命令通道，请改用 /md-export 命令',
          pickingTitle: '选择保存位置',
          loading: '读取目录…',
          emptyDir: '（没有子目录）',
          useThisFolder: '使用此文件夹',
          cancel: '取消',
          pathPlaceholder: '直接输入路径，如 D:\\会话导出',
          go: '前往',
        },
      ],
      [
        'en',
        {
          button: 'Export session',
          picking: 'Choose location…',
          running: 'Exporting…',
          tooltip: 'Export this session and its whole subagent fleet as Markdown (narrative summary + raw archive)',
          noPicker: 'No directory picker available — use the /md-export command',
          rejected: 'Command was not accepted',
          unknown: 'Unknown command: md-export is not registered',
          failed: 'Export failed',
          noChannel: 'This surface has no command channel — use the /md-export command',
          pickingTitle: 'Choose where to save',
          loading: 'Reading folder…',
          emptyDir: '(no subfolders)',
          useThisFolder: 'Use this folder',
          cancel: 'Cancel',
          pathPlaceholder: 'Type a path, e.g. D:\\session-exports',
          go: 'Go',
        },
      ],
    ]

    return {
      // `slots` mounts the button; `remote.commands` runs the export. Both are
      // real Client-side service names — `dsh-client-ui-commands` and
      // `dsh-client-ui-plan` declare `remote.commands` the same way — so they
      // belong in `inject` rather than being probed at click time.
      //
      // `remote.commands` is a FLAT name containing a dot, not a member of a
      // `remote` service. Reading `ctx.get('remote').commands` was the actual
      // bug behind `cannot get property "remote.commands" without inject`: the
      // Client facade only serves names a plugin declared, and no `remote`
      // parent exists to walk through.
      inject: ['slots', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => {
          const locale = ctx.get?.('locale')
          if (!locale || typeof locale.register !== 'function') return
          const disposers = []
          for (const [id, dict] of DICTIONARIES) {
            try {
              disposers.push(locale.register(LOCALE_NS, id, dict))
            } catch {
              // A locale that refuses this namespace must not break the button.
            }
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.()
              } catch {
                // disposal is best effort
              }
            }
          }
        }, 'md-export: client dictionaries')

        /**
         * Build the word table for this render.
         *
         * `locale.bind(ns)` returns a *lookup function* `(key, params) => string`,
         * not a dictionary object — reading `bound.button` yields undefined and
         * renders an empty button. So every string goes through the function,
         * with the built-in dictionary as a fallback for a key the active locale
         * does not define.
         */
        const translate = () => {
          const fallback = DICTIONARIES[0][1]
          const locale = ctx.get?.('locale')
          let lookup
          if (locale && typeof locale.bind === 'function') {
            try {
              const bound = locale.bind(LOCALE_NS)
              if (typeof bound === 'function') lookup = bound
            } catch {
              // fall through to the built-in dictionary
            }
          }
          const words = {}
          for (const key of Object.keys(fallback)) {
            let value
            if (lookup) {
              try {
                value = lookup(key)
              } catch {
                value = undefined
              }
            }
            // `translate` echoes the key back when it has no entry; either that
            // or a non-string means "use the built-in wording".
            words[key] = typeof value === 'string' && value && value !== key ? value : fallback[key]
          }
          return words
        }

        /**
         * Can this composition open a real OS folder dialog?
         *
         * Two different mechanisms, and which one exists depends on the build:
         *   - `__DSH_DESKTOP_PICK_DIRECTORY__`, published only by some Desktop
         *     builds (the DSH NEXT build ships no writer for it at all)
         *   - `uiWorkspace.pickDirectory()`, which forwards to the Host picker
         *     and throws when that picker is `browse`-only
         *
         * @returns `'bridge'`, `'workspace'`, or `null` for the in-app browser.
         */
        const nativePickerKind = () => {
          if (typeof globalThis.__DSH_DESKTOP_PICK_DIRECTORY__ === 'function') return 'bridge'
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') return 'workspace'
          return null
        }

        /** Open the OS dialog, translating cancellation into `null`. */
        const pickNative = async () => {
          const bridge = globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
          if (typeof bridge === 'function') {
            const picked = await bridge()
            return typeof picked === 'string' && picked ? picked : null
          }
          const uiWorkspace = ctx.get?.('uiWorkspace')
          const picked = await uiWorkspace.pickDirectory()
          return typeof picked === 'string' && picked ? picked : null
        }

        /** The browse service behind the in-app tree, or `undefined` when absent. */
        const browseService = () => {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (!uiWorkspace || typeof uiWorkspace.listDirectory !== 'function') return undefined
          return uiWorkspace
        }

        /**
         * Run the export through the session command, which is the one shared
         * implementation the Host half also uses.
         *
         * The service is a flat name (`remote.commands`), so it is read as one
         * key — never as `remote.commands` on a `remote` object.
         *
         * @returns the command outcome, or `undefined` when no channel exists.
         */
        const executeExport = async (sessionId, line) => {
          const commands = ctx.get?.('remote.commands')
          if (!commands || typeof commands.execute !== 'function') return undefined
          return await commands.execute(sessionId, line, [])
        }

        /**
         * An in-app folder browser, used when no OS dialog can be opened.
         *
         * This build ships no renderer-facing native picker: `dialog.showOpenDialog`
         * exists in the Electron main process only for the data-directory
         * choice, so the button has to offer a browser of its own.
         *
         * It walks `uiWorkspace.listDirectory` one level at a time, but also
         * accepts a typed path. That matters because the Host lists a directory
         * with a single `opendir`, so ONE unreadable child (a Windows junction
         * such as `My Documents` raises EPERM) fails the whole level. A typed
         * path lets the operator step past a broken parent.
         */
        function DirectoryBrowser({ state, onNavigate, onCommit, onClose, words }) {
          const listing = state.listing
          const rows = listing?.entries ?? []
          const crumbs = listing?.crumbs ?? []
          const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null
          const [typed, setTyped] = React.useState('')

          const rowStyle = {
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            width: '100%',
            padding: '5px 8px',
            border: 'none',
            background: 'transparent',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            textAlign: 'left',
            color: 'var(--dsw-alias-label-primary, #222)',
            borderRadius: 4,
            cursor: 'pointer',
          }

          const FolderGlyph = ({ muted }) =>
            h(
              'svg',
              {
                viewBox: '0 0 16 16',
                width: 13,
                height: 13,
                'aria-hidden': true,
                focusable: 'false',
                style: { flex: 'none', opacity: muted ? 0.55 : 0.85 },
              },
              h('path', {
                d: 'M1.8 4.2a1 1 0 0 1 1-1h3l1.3 1.6h6.1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.2Z',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.3,
                strokeLinejoin: 'round',
              }),
            )

          const submitTyped = () => {
            const target = typed.trim()
            if (!target) return
            setTyped('')
            onNavigate(target)
          }

          return h(
            'div',
            {
              style: {
                // Fixed + anchored to the trigger rect: this build's dock sits in
                // a scrolling composer that would clip an absolutely positioned
                // child, and its slot docs require fixed overlays to portal out.
                position: 'fixed',
                left: Math.max(8, state.anchor?.left ?? 8),
                bottom: Math.max(8, state.anchor?.bottom ?? 8),
                zIndex: 9000,
                width: 440,
                maxHeight: 400,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--dsw-alias-bg-l1, #fff)',
                color: 'var(--dsw-alias-label-primary, #222)',
                border: '1px solid var(--dsw-alias-border-l3, #dcdcdc)',
                borderRadius: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06)',
                overflow: 'hidden',
                fontFamily: 'inherit',
              },
            },
            // Title row
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px 8px',
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: '.01em',
                },
              },
              h('span', { style: { flex: 1, minWidth: 0 } }, words.pickingTitle),
              h(
                'button',
                {
                  type: 'button',
                  onClick: onClose,
                  title: words.cancel,
                  style: {
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-tertiary, #888)',
                    cursor: 'pointer',
                    fontSize: 15,
                    lineHeight: '18px',
                    padding: '0 2px',
                    borderRadius: 4,
                  },
                },
                '×',
              ),
            ),
            // Breadcrumb trail
            crumbs.length > 0
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 2,
                      padding: '0 12px 8px',
                      fontSize: 11.5,
                      color: 'var(--dsw-alias-label-tertiary, #777)',
                    },
                  },
                  ...crumbs.flatMap((crumb, index) => {
                    const isLast = index === crumbs.length - 1
                    const node = h(
                      'button',
                      {
                        key: `crumb-${crumb.path}`,
                        type: 'button',
                        onClick: () => {
                          if (!isLast) onNavigate(crumb.path)
                        },
                        style: {
                          border: 'none',
                          background: 'transparent',
                          font: 'inherit',
                          color: isLast
                            ? 'var(--dsw-alias-label-primary, #222)'
                            : 'var(--dsw-alias-label-tertiary, #777)',
                          cursor: isLast ? 'default' : 'pointer',
                          padding: '1px 2px',
                          borderRadius: 3,
                          maxWidth: 130,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      crumb.name,
                    )
                    return index === 0
                      ? [node]
                      : [
                          h(
                            'span',
                            { key: `sep-${crumb.path}`, style: { opacity: 0.45 } },
                            '›',
                          ),
                          node,
                        ]
                  }),
                )
              : null,
            // List
            h(
              'div',
              {
                style: {
                  // `flex: 1 1 auto` with `maxHeight` on the panel lets the list
                  // take its natural height until the panel cap, then scroll.
                  // A fixed `minHeight` here made short panels pad while tall
                  // ones clipped rows.
                  flex: '1 1 auto',
                  overflowY: 'auto',
                  padding: '4px 8px 6px',
                  borderTop: '1px solid var(--dsw-alias-border-l3, #ececec)',
                },
              },
              state.error
                ? h(
                    'div',
                    {
                      style: {
                        padding: '7px 8px',
                        margin: '0 0 4px',
                        fontSize: 11.5,
                        lineHeight: '16px',
                        color: 'var(--dsw-alias-state-error-primary, #c33)',
                        background: 'var(--dsw-alias-state-error-l1, rgba(220,50,50,.07))',
                        border: '1px solid var(--dsw-alias-state-error-l2, rgba(220,50,50,.18))',
                        borderRadius: 6,
                      },
                    },
                    state.error,
                  )
                : null,
              state.loading && rows.length === 0
                ? h('div', { style: { padding: '7px 8px', fontSize: 11.5, opacity: 0.6 } }, words.loading)
                : null,
              parent
                ? h(
                    'button',
                    { type: 'button', onClick: () => onNavigate(parent.path), style: rowStyle },
                    h('span', { style: { width: 13, textAlign: 'center', opacity: 0.55, fontSize: 11 } }, '↰'),
                    h('span', { style: { opacity: 0.7 } }, '..'),
                  )
                : null,
              rows.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.path,
                    type: 'button',
                    onClick: () => onNavigate(entry.path),
                    style: rowStyle,
                  },
                  h(FolderGlyph, { muted: false }),
                  h(
                    'span',
                    {
                      style: {
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    entry.name,
                  ),
                ),
              ),
              !state.loading && !state.error && rows.length === 0 && !parent
                ? h('div', { style: { padding: '7px 8px', fontSize: 11.5, opacity: 0.6 } }, words.emptyDir)
                : null,
            ),
            // Typed path escape hatch
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 6,
                  padding: '8px 12px',
                  borderTop: '1px solid var(--dsw-alias-border-l3, #ececec)',
                },
              },
              h('input', {
                type: 'text',
                value: typed,
                placeholder: words.pathPlaceholder,
                onChange: (event) => setTyped(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitTyped()
                },
                spellCheck: false,
                style: {
                  flex: 1,
                  minWidth: 0,
                  height: 24,
                  padding: '0 7px',
                  font: 'inherit',
                  fontSize: 11.5,
                  color: 'inherit',
                  background: 'var(--dsw-alias-bg-l2, #f5f5f5)',
                  border: '1px solid var(--dsw-alias-border-l3, #dcdcdc)',
                  borderRadius: 5,
                  outline: 'none',
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: submitTyped,
                  disabled: typed.trim().length === 0,
                  style: {
                    border: '1px solid var(--dsw-alias-border-l3, #dcdcdc)',
                    background: 'transparent',
                    color: 'inherit',
                    borderRadius: 5,
                    padding: '0 9px',
                    font: 'inherit',
                    fontSize: 11.5,
                    cursor: typed.trim() ? 'pointer' : 'default',
                    opacity: typed.trim() ? 1 : 0.5,
                    height: 24,
                  },
                },
                words.go,
              ),
            ),
            // Footer actions
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  padding: '0 12px 10px',
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  onClick: onClose,
                  style: {
                    border: '1px solid var(--dsw-alias-border-l3, #dcdcdc)',
                    background: 'transparent',
                    color: 'inherit',
                    borderRadius: 5,
                    padding: '4px 12px',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                    height: 26,
                  },
                },
                words.cancel,
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: onCommit,
                  disabled: state.loading || !listing?.path,
                  style: {
                    border: 'none',
                    background: 'var(--dsw-alias-state-business-primary, #247bbf)',
                    color: '#fff',
                    borderRadius: 5,
                    padding: '4px 12px',
                    font: 'inherit',
                    fontSize: 12,
                    fontWeight: 550,
                    cursor: state.loading || !listing?.path ? 'default' : 'pointer',
                    opacity: state.loading || !listing?.path ? 0.55 : 1,
                    height: 26,
                  },
                },
                words.useThisFolder,
              ),
            ),
          )
        }

        function ExportButton(props) {
          const sessionId = props.sessionId
          const [phase, setPhase] = React.useState('idle')
          const [note, setNote] = React.useState(null)
          const [hover, setHover] = React.useState(false)
          const [browser, setBrowser] = React.useState(null)
          const buttonRef = React.useRef(null)
          const busy = phase !== 'idle' || browser !== null

          /**
           * A reasonable first directory for the in-app browser.
           *
           * The session's working directory is the natural starting point and, on
           * Windows, avoids the home directory's junctions (`My Documents` and
           * friends), which the Host cannot list. `undefined` asks the Host for
           * its own default.
           */
          const startDirectory = React.useCallback(() => {
            try {
              const sessions = ctx.get?.('sessions')
              const scope = sessions?.scope?.(sessionId)
              const directory =
                scope?.cwd ??
                scope?.workingDirectory ??
                scope?.session?.cwd ??
                scope?.snapshot?.cwd
              if (typeof directory === 'string' && directory) return directory
            } catch {
              // A missing or differently shaped snapshot just means "no hint".
            }
            return undefined
          }, [sessionId])

          /**
           * Where the portal should sit: just above the button.
           *
           * The portal is anchored from a measured rect rather than a CSS offset
           * because it renders into `document.body`, outside the button's
           * containing block.
           */
          const anchorFromButton = () => {
            const node = buttonRef.current
            if (!node || typeof node.getBoundingClientRect !== 'function') return undefined
            const rect = node.getBoundingClientRect()
            return { left: rect.left, bottom: window.innerHeight - rect.top + 6 }
          }

          /** Walk one directory level into the in-app browser. */
          const navigate = React.useCallback(async (target) => {
            const service = browseService()
            if (!service) {
              setBrowser((prev) => (prev ? { ...prev, error: translate().noPicker, loading: false } : prev))
              return
            }
            setBrowser((prev) => ({
              ...(prev ?? { listing: null, error: null }),
              error: null,
              loading: true,
            }))
            try {
              const listing = await service.listDirectory(target)
              // A newer navigation or a close may have landed first.
              setBrowser((prev) => (prev === null ? prev : { ...prev, listing, error: null, loading: false }))
            } catch (error) {
              setBrowser((prev) =>
                prev === null
                  ? prev
                  : {
                      ...prev,
                      error: error instanceof Error ? error.message : String(error),
                      loading: false,
                    },
              )
            }
          }, [])

          const openBrowser = React.useCallback(async () => {
            setBrowser({ listing: null, error: null, loading: true, anchor: anchorFromButton() })
            // Start where the work actually is. `navigate(undefined)` would ask
            // the Host for the home directory, and a home directory on Windows
            // usually holds junctions such as `My Documents` whose `opendir`
            // fails with EPERM — one unreadable child fails the whole level.
            await navigate(startDirectory())
          }, [navigate, startDirectory])

          /** Run the export into a chosen directory and report plainly. */
          const runExport = React.useCallback(
            async (dir) => {
              const words = translate()
              setNote(null)
              setPhase('running')
              try {
                const result = await executeExport(sessionId, '/md-export ' + dir)
                if (result === undefined) {
                  setNote(words.noChannel)
                  return
                }
                if (!result || result.ok !== true) {
                  setNote(result?.error?.message ?? words.rejected)
                  return
                }
                const outcome = result.value?.result
                if (outcome === undefined) {
                  setNote(words.unknown)
                  return
                }
                if (outcome.kind === 'error') setNote(outcome.text ?? words.failed)
              } catch (error) {
                setNote(error instanceof Error ? error.message : String(error))
              } finally {
                setPhase('idle')
              }
            },
            [sessionId],
          )

          const onClick = React.useCallback(async () => {
            if (busy) return
            setNote(null)
            const words = translate()

            // Prefer a real OS dialog when this build can open one.
            if (nativePickerKind() !== null) {
              setPhase('picking')
              try {
                const dir = await pickNative()
                if (dir === null) return
                await runExport(dir)
              } catch (error) {
                // A browse-only Host picker throws here; fall back to the
                // in-app tree rather than surfacing a picker complaint.
                setPhase('idle')
                if (!browseService()) {
                  setNote(error instanceof Error ? error.message : String(error))
                  return
                }
                await openBrowser()
              }
              return
            }

            if (!browseService()) {
              setNote(words.noPicker)
              return
            }
            await openBrowser()
          }, [busy, openBrowser, runExport])

          const words = translate()
          const label = phase === 'picking' ? words.picking : phase === 'running' ? words.running : words.button

          return h(
            'div',
            {
              style: {
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                fontSize: 12,
                lineHeight: '20px',
              },
            },
            h(
              'button',
              {
                type: 'button',
                ref: buttonRef,
                onClick,
                disabled: busy,
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
                title: words.tooltip,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 22,
                  padding: '0 6px',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  lineHeight: '20px',
                  whiteSpace: 'nowrap',
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-sm, 4px)',
                  cursor: busy ? 'default' : 'pointer',
                  background: hover && !busy ? 'var(--dsw-alias-bg-l2, transparent)' : 'transparent',
                  color: busy
                    ? 'var(--dsw-alias-label-tertiary, #8a8a8a)'
                    : hover
                      ? 'var(--dsw-alias-label-primary, inherit)'
                      : 'var(--dsw-alias-label-secondary, inherit)',
                },
              },
              // A document sheet with a folded corner: the export result. At this
              // size (14px) a speech bubble plus an arrow reads as mush, so the
              // icon stays to three strokes and the label carries the rest.
              h(
                'svg',
                {
                  viewBox: '0 0 16 16',
                  width: 14,
                  height: 14,
                  'aria-hidden': true,
                  focusable: 'false',
                  style: { display: 'block', flex: 'none', marginRight: 5 },
                },
                h('path', {
                  d: 'M4.5 1.8h4.4l3.4 3.4v8.2a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.35,
                  strokeLinejoin: 'round',
                }),
                h('path', {
                  d: 'M8.9 1.8v3.4h3.4',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.35,
                  strokeLinejoin: 'round',
                }),
                h('path', {
                  d: 'M5.9 9.7h4.2',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.35,
                  strokeLinecap: 'round',
                }),
              ),
              h('span', { style: { display: 'block', minWidth: 0 } }, label),
            ),
            note
              ? h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  note,
                )
              : null,
            browser
              ? createPortal(
                  h(DirectoryBrowser, {
                    state: browser,
                    words,
                    onNavigate: (target) => {
                      void navigate(target)
                    },
                    onCommit: () => {
                      const dir = browser.listing?.path
                      setBrowser(null)
                      if (typeof dir === 'string' && dir) void runExport(dir)
                    },
                    onClose: () => setBrowser(null),
                  }),
                  document.body,
                )
              : null,
          )
        }

        // `slots.inject` returns its own disposer, owned by this plugin fiber;
        // wrapping it in another `ctx.effect` would dispose it twice on unload.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'md-export',
              order: 50,
              label: () => translate().button,
            },
            // Exposed as a static so the offline harness can render the panel on
            // its own; nothing in the app path reads it.
            Object.assign(ExportButton, {
              DirectoryBrowser,
            }),
          ),
        )
      },
    }
  },
})
