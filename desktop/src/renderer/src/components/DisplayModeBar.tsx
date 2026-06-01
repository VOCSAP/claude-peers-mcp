import type { DisplayMode } from '@shared/types'
import { useDeck } from '../store'

const MODES: { mode: DisplayMode; label: string; title: string }[] = [
  { mode: '1x1', label: '1×1', title: 'Carousel (one at a time)' },
  { mode: '1x2', label: '1×2', title: 'One row, two columns' },
  { mode: '2x2', label: '2×2', title: 'Two by two grid' },
  { mode: 'custom', label: 'X×Y', title: 'Custom grid' }
]

export function DisplayModeBar(): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const sessions = useDeck((s) => s.sessions)

  const clamp = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1)

  return (
    <div className="modebar">
      <div className="modebar-group">
        {MODES.map(({ mode, label, title }) => (
          <button
            key={mode}
            className={`mode-btn ${config.displayMode === mode ? 'mode-btn-active' : ''}`}
            title={title}
            onClick={() => void updateConfig({ displayMode: mode })}
          >
            {label}
          </button>
        ))}
      </div>

      {config.displayMode === 'custom' && (
        <div className="modebar-custom">
          <input
            type="number"
            min={1}
            max={12}
            value={config.gridCols}
            title="Columns"
            onChange={(e) => void updateConfig({ gridCols: clamp(Number(e.target.value)) })}
          />
          <span className="modebar-x">×</span>
          <input
            type="number"
            min={1}
            max={12}
            value={config.gridRows}
            title="Rows"
            onChange={(e) => void updateConfig({ gridRows: clamp(Number(e.target.value)) })}
          />
        </div>
      )}

      <span className="modebar-spacer" />
      <span className="modebar-count">
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </span>
    </div>
  )
}
