import { useState } from 'react'
import type { SessionRuntime } from '@shared/types'
import { useDeck } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
import { CreateMenu } from './CreateMenu'

function SessionRow({ session }: { session: SessionRuntime }): React.JSX.Element {
  const selectedId = useDeck((s) => s.selectedId)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setSelected = useDeck((s) => s.setSelected)
  const setMaximized = useDeck((s) => s.setMaximized)
  const removeSession = useDeck((s) => s.removeSession)
  const renameSession = useDeck((s) => s.renameSession)
  const setColor = useDeck((s) => s.setColor)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== session.name) renameSession(session.id, draft.trim())
    else setDraft(session.name)
  }

  return (
    <li
      className={`row ${selectedId === session.id ? 'row-selected' : ''}`}
      onClick={() => setSelected(session.id)}
    >
      <input
        type="color"
        className="swatch"
        value={session.color || '#4f86ff'}
        title="Session colour"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => void setColor(session.id, e.target.value)}
      />
      <span
        className={`dot dot-${session.status}${session.thinking ? ' dot-thinking' : ''}`}
        title={session.thinking ? 'thinking…' : session.status}
      />
      <div className="row-main">
        {editing ? (
          <input
            className="row-edit"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(session.name)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="row-name"
            title={session.cwd}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraft(session.name)
              setEditing(true)
            }}
          >
            {session.name}
          </span>
        )}
        <span className="row-sub" title={session.cwd}>
          {session.peerId ?? `Session ${(session.sessionId || session.id).slice(0, 8)}`}
        </span>
      </div>
      <button
        className="row-btn"
        title={maximizedId === session.id ? 'Restore' : 'Maximize'}
        onClick={(e) => {
          e.stopPropagation()
          setSelected(session.id)
          setMaximized(maximizedId === session.id ? null : session.id)
        }}
      >
        {maximizedId === session.id ? '⤡' : '⤢'}
      </button>
      <button
        className="row-btn row-btn-danger"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation()
          setConfirmingDelete(true)
        }}
      >
        ✕
      </button>
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete session?"
          message={`Remove "${session.name}"? Its terminal is closed; the underlying Claude session can still be resumed later from history.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void removeSession(session.id)
          }}
        />
      )}
    </li>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useDeck((s) => s.sessions)
  const config = useDeck((s) => s.config!)
  const createSession = useDeck((s) => s.createSession)
  const openSettings = useDeck((s) => s.openSettings)
  const setSidebarWidth = useDeck((s) => s.setSidebarWidth)
  const updateConfig = useDeck((s) => s.updateConfig)
  const [createOpen, setCreateOpen] = useState(false)

  // Drag the right edge to resize; persist the final width on mouse-up.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => setSidebarWidth(ev.clientX)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      void updateConfig({ sidebarWidth: useDeck.getState().sidebarWidth })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="brand">Claude Peers Deck</span>
        <button className="icon-btn" title="Settings" onClick={() => openSettings(true)}>
          ⚙
        </button>
      </header>

      <div className="sidebar-actions">
        <button className="primary" onClick={() => void createSession({})} title="Add in project dir">
          ＋ Add peer
        </button>
        <button
          className="icon-btn"
          title="Advanced: agent, args, presets, folder…"
          onClick={() => setCreateOpen(true)}
        >
          ▾
        </button>
      </div>
      {createOpen && <CreateMenu onClose={() => setCreateOpen(false)} />}

      <ul className="rows">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
        {sessions.length === 0 && <li className="rows-empty">No sessions</li>}
      </ul>

      <footer className="sidebar-foot" title={config.projectDir}>
        <span className="foot-label">project</span>
        <span className="foot-path">{config.projectDir}</span>
      </footer>

      <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
    </aside>
  )
}
