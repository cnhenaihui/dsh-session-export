window.__ModuleLoader__.load({
  id: '@cnhenaihui/dsh-session-export',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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
         * Ask for a destination directory, in order of fidelity:
         *   1. `__DSH_DESKTOP_PICK_DIRECTORY__` — DSH Desktop publishes this
         *      bridge and it drives the real Windows folder dialog. It works
         *      even when the Host resolved the `browse` picker backend.
         *   2. `uiWorkspace.pickDirectory()` — whatever this composition
         *      composed; throws on a browse-only backend (it has no `pick`).
         *
         * @returns an absolute path, `null` when the operator cancelled, or
         *   `undefined` when this composition has no picker at all.
         */
        const pickDirectory = async () => {
          const bridge = globalThis.__DSH_DESKTOP_PICK_DIRECTORY__
          if (typeof bridge === 'function') {
            const picked = await bridge()
            return typeof picked === 'string' && picked ? picked : null
          }
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
            const picked = await uiWorkspace.pickDirectory()
            return typeof picked === 'string' && picked ? picked : null
          }
          return undefined
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

        function ExportButton(props) {
          const sessionId = props.sessionId
          const [phase, setPhase] = React.useState('idle')
          const [note, setNote] = React.useState(null)
          const [hover, setHover] = React.useState(false)
          const busy = phase !== 'idle'

          const onClick = React.useCallback(async () => {
            if (busy) return
            setNote(null)
            setPhase('picking')
            try {
              const dir = await pickDirectory()
              const words = translate()

              if (dir === undefined) {
                setNote(words.noPicker)
                return
              }
              // Cancelling the dialog is not an error: stay quiet.
              if (dir === null) return

              setPhase('running')
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
          }, [busy, sessionId])

          const words = translate()
          const label = phase === 'picking' ? words.picking : phase === 'running' ? words.running : words.button

          return h(
            'div',
            {
              style: {
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
            ExportButton,
          ),
        )
      },
    }
  },
})
