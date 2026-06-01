import { useEffect } from 'react'
import { useDeck } from '../store'
import { Sidebar } from './Sidebar'
import { TileArea } from './TileArea'
import { DisplayModeBar } from './DisplayModeBar'
import { SettingsDialog } from './SettingsDialog'

export function App(): React.JSX.Element {
  const init = useDeck((s) => s.init)
  const config = useDeck((s) => s.config)
  const settingsOpen = useDeck((s) => s.settingsOpen)
  const selectedId = useDeck((s) => s.selectedId)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setMaximized = useDeck((s) => s.setMaximized)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.theme
  }, [config])

  // Ctrl+Shift+M toggles fullscreen of the selected tile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault()
        if (maximizedId) setMaximized(null)
        else if (selectedId) setMaximized(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, maximizedId, setMaximized])

  if (!config) {
    return <div className="loading">Loading…</div>
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="main-pane">
        <DisplayModeBar />
        <TileArea />
      </div>
      {settingsOpen && <SettingsDialog />}
    </div>
  )
}
