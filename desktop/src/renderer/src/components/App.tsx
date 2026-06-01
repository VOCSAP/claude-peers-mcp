import { useEffect } from 'react'
import { useDeck } from '../store'
import { Sidebar } from './Sidebar'
import { TileArea } from './TileArea'
import { DisplayModeBar } from './DisplayModeBar'
import { SettingsDialog } from './SettingsDialog'
import { WorkspacesDialog } from './WorkspacesDialog'

export function App(): React.JSX.Element {
  const init = useDeck((s) => s.init)
  const config = useDeck((s) => s.config)
  const settingsOpen = useDeck((s) => s.settingsOpen)
  const workspacesOpen = useDeck((s) => s.workspacesOpen)
  const selectedId = useDeck((s) => s.selectedId)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setMaximized = useDeck((s) => s.setMaximized)
  const sidebarWidth = useDeck((s) => s.sidebarWidth)

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
    // Bootstrap splash shown before init() resolves (config + locale dict load
    // together), so there is no dictionary to translate against yet.
    return <div className="loading" aria-busy="true" />
  }

  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}>
      <Sidebar />
      <div className="main-pane">
        <DisplayModeBar />
        <TileArea />
      </div>
      {settingsOpen && <SettingsDialog />}
      {workspacesOpen && <WorkspacesDialog />}
    </div>
  )
}
