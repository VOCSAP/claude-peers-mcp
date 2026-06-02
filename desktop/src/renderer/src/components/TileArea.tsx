import { useRef } from 'react'
import type { DisplayMode } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { TerminalTile } from './TerminalTile'

/** Visible columns/rows for the grid modes (1x1 is rendered as a carousel). */
function gridShape(mode: DisplayMode, cols: number, rows: number): { cols: number; rows: number } {
  switch (mode) {
    case '1x2':
      return { cols: 2, rows: 1 }
    case '2x2':
      return { cols: 2, rows: 2 }
    case 'custom':
      return { cols: Math.max(1, cols), rows: Math.max(1, rows) }
    default:
      return { cols: 1, rows: 1 }
  }
}

export function TileArea(): React.JSX.Element {
  const t = useT()
  const sessions = useDeck((s) => s.sessions)
  const config = useDeck((s) => s.config!)
  const maximizedId = useDeck((s) => s.maximizedId)
  const createSession = useDeck((s) => s.createSession)
  const workspaces = useDeck((s) => s.workspaces)
  const restoreWorkspace = useDeck((s) => s.restoreWorkspace)
  const carouselRef = useRef<HTMLDivElement>(null)

  if (sessions.length === 0) {
    const previous = workspaces[0]
    return (
      <main className="area area-empty">
        <div className="empty-card">
          <h2>{t('area.emptyTitle')}</h2>
          <p>{t('area.emptyBody')}</p>
          <div className="empty-actions">
            <button className="primary" onClick={() => void createSession({})}>
              {t('area.addTerminal')}
            </button>
            {previous && (
              <button className="secondary" onClick={() => void restoreWorkspace(previous.id)}>
                {t('area.restorePrevious')}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  // Maximized: a single tile fills the area; the rest stay mounted but hidden.
  if (maximizedId) {
    return (
      <main className="area area-maximized">
        {sessions.map((s) => (
          <TerminalTile key={s.id} session={s} hidden={s.id !== maximizedId} />
        ))}
      </main>
    )
  }

  // 1x1 = horizontal carousel: one tile per view, wheel scrolls sideways.
  if (config.displayMode === '1x1') {
    return (
      <main
        className="area area-carousel"
        ref={carouselRef}
        onWheel={(e) => {
          if (carouselRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            carouselRef.current.scrollLeft += e.deltaY
          }
        }}
      >
        {sessions.map((s) => (
          <TerminalTile key={s.id} session={s} hidden={false} />
        ))}
      </main>
    )
  }

  // Grid modes: cols x rows visible, extra tiles overflow vertically.
  const { cols, rows } = gridShape(config.displayMode, config.gridCols, config.gridRows)
  return (
    <main
      className="area area-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: `calc((100% - ${rows - 1} * var(--gap)) / ${rows})`
      }}
    >
      {sessions.map((s) => (
        <TerminalTile key={s.id} session={s} hidden={false} />
      ))}
    </main>
  )
}
