import { useDeck } from '../store'
import { TerminalTile } from './TerminalTile'

export function TileGrid(): React.JSX.Element {
  const sessions = useDeck((s) => s.sessions)
  const config = useDeck((s) => s.config!)
  const maximizedId = useDeck((s) => s.maximizedId)
  const createSession = useDeck((s) => s.createSession)

  if (sessions.length === 0) {
    return (
      <main className="grid-empty">
        <div className="empty-card">
          <h2>No peer terminals yet</h2>
          <p>
            Add a Claude Code peer session to dock it here. Each tile runs your{' '}
            <code>{config.peerCommand}</code> command in a real terminal, so OAuth works
            normally.
          </p>
          <button className="primary" onClick={() => createSession({})}>
            ＋ Add peer terminal
          </button>
        </div>
      </main>
    )
  }

  const columns = maximizedId ? 1 : Math.max(1, config.columns)

  return (
    <main
      className={`grid ${maximizedId ? 'grid-maximized' : ''}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {sessions.map((s) => (
        <TerminalTile
          key={s.id}
          session={s}
          hidden={maximizedId !== null && maximizedId !== s.id}
        />
      ))}
    </main>
  )
}
