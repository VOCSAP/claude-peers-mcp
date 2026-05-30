import { useState } from 'react'
import type { SessionRuntime } from '@shared/types'
import { useDeck } from '../store'

function SessionRow({ session }: { session: SessionRuntime }): React.JSX.Element {
  const selectedId = useDeck((s) => s.selectedId)
  const setSelected = useDeck((s) => s.setSelected)
  const setMaximized = useDeck((s) => s.setMaximized)
  const removeSession = useDeck((s) => s.removeSession)
  const renameSession = useDeck((s) => s.renameSession)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)

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
      <span className={`dot dot-${session.status}`} title={session.status} />
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
        <span className="row-sub">{session.peerId ?? session.cwd}</span>
      </div>
      <button
        className="row-btn"
        title="Maximize"
        onClick={(e) => {
          e.stopPropagation()
          setSelected(session.id)
          setMaximized(session.id)
        }}
      >
        ⤢
      </button>
      <button
        className="row-btn row-btn-danger"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation()
          removeSession(session.id)
        }}
      >
        ✕
      </button>
    </li>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useDeck((s) => s.sessions)
  const config = useDeck((s) => s.config!)
  const createSession = useDeck((s) => s.createSession)
  const openSettings = useDeck((s) => s.openSettings)

  const addWithDir = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) createSession({ cwd: dir })
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
        <button className="primary" onClick={() => createSession({})} title="Add in project dir">
          ＋ Add peer
        </button>
        <button className="icon-btn" title="Add in another folder…" onClick={addWithDir}>
          📁
        </button>
      </div>

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
    </aside>
  )
}
