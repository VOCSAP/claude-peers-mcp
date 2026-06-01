import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SessionRuntime } from '@shared/types'
import { useDeck } from '../store'
import { ConfirmDialog } from './ConfirmDialog'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#1f1f1f', cursor: '#1f1f1f', selectionBackground: '#add6ff' }
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export function TerminalTile({
  session,
  hidden
}: {
  session: SessionRuntime
  hidden: boolean
}): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const maximizedId = useDeck((s) => s.maximizedId)
  const selectedId = useDeck((s) => s.selectedId)
  const setMaximized = useDeck((s) => s.setMaximized)
  const setSelected = useDeck((s) => s.setSelected)
  const restartSession = useDeck((s) => s.restartSession)
  const removeSession = useDeck((s) => s.removeSession)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const id = session.id

  function doFit(): void {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    // Skip while collapsed/hidden -- fitting a 0-sized element corrupts dims.
    if (host.clientWidth < 4 || host.clientHeight < 4) return
    try {
      fit.fit()
      window.api.ptyResize(id, term.cols, term.rows)
    } catch {
      /* terminal mid-teardown */
    }
  }

  // Create the xterm instance once per session id.
  useEffect(() => {
    const term = new Terminal({
      fontSize: config.fontSize,
      fontFamily: FONT_STACK,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEMES[config.theme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    if (hostRef.current) term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit

    const onInput = term.onData((d) => window.api.ptyInput(id, d))
    const offData = window.api.onPtyData((e) => {
      if (e.id === id) term.write(e.data)
    })
    const offExit = window.api.onPtyExit((e) => {
      if (e.id === id) term.write('\r\n\x1b[2m[peer process exited]\x1b[0m\r\n')
    })

    const raf = requestAnimationFrame(doFit)
    return () => {
      cancelAnimationFrame(raf)
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Re-apply theme / font size live.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = THEMES[config.theme]
    term.options.fontSize = config.fontSize
    requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.theme, config.fontSize])

  // Refit on any container size change (maximize/restore, window resize, columns).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a tile becomes visible again, it needs a fresh fit.
  useEffect(() => {
    if (!hidden) requestAnimationFrame(doFit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden])

  const isMax = maximizedId === id
  const selected = selectedId === id

  return (
    <div
      className={[
        'tile',
        hidden ? 'tile-hidden' : '',
        selected ? 'tile-selected' : '',
        isMax ? 'tile-max' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--tile-color': session.color || 'transparent' } as React.CSSProperties}
      onMouseDown={() => setSelected(id)}
    >
      <div
        className="tile-head"
        onDoubleClick={(e) => {
          // Ignore double-clicks that land on a button (they have their own handler).
          if ((e.target as HTMLElement).closest('button')) return
          setMaximized(isMax ? null : id)
        }}
        title="Double-click to toggle fullscreen"
      >
        <span
          className={`dot dot-${session.status}${session.thinking ? ' dot-thinking' : ''}`}
          title={session.thinking ? 'thinking…' : session.status}
        />
        <span className="tile-title">{session.name}</span>
        {session.peerId ? (
          <span className="tile-peer">{session.peerId}</span>
        ) : (
          <span className="tile-peer tile-peer-pending">
            Session {(session.sessionId || session.id).slice(0, 8)}
          </span>
        )}
        <span className="tile-spacer" />
        {session.status === 'exited' && (
          <button
            type="button"
            className="tile-btn"
            title="Restart peer"
            onClick={(e) => {
              e.stopPropagation()
              void restartSession(id)
            }}
          >
            ↻
          </button>
        )}
        <button
          type="button"
          className="tile-btn"
          title={isMax ? 'Restore' : 'Maximize'}
          onClick={(e) => {
            e.stopPropagation()
            setMaximized(isMax ? null : id)
          }}
        >
          {isMax ? '⤡' : '⤢'}
        </button>
        <button
          type="button"
          className="tile-btn tile-btn-danger"
          title="Close session"
          onClick={(e) => {
            e.stopPropagation()
            setConfirmingDelete(true)
          }}
        >
          ✕
        </button>
      </div>
      <div className="tile-body" ref={hostRef} />
      {confirmingDelete && (
        <ConfirmDialog
          title="Close session?"
          message={`Close "${session.name}"? Its terminal stops; the underlying Claude session can still be resumed later from history.`}
          confirmLabel="Close"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void removeSession(id)
          }}
        />
      )}
    </div>
  )
}
