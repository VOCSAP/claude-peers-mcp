import { useEffect } from 'react'
import { useDeck } from '../store'
import { Sidebar } from './Sidebar'
import { TileGrid } from './TileGrid'
import { SettingsDialog } from './SettingsDialog'

export function App(): React.JSX.Element {
  const init = useDeck((s) => s.init)
  const config = useDeck((s) => s.config)
  const settingsOpen = useDeck((s) => s.settingsOpen)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (config) document.documentElement.dataset.theme = config.theme
  }, [config])

  if (!config) {
    return <div className="loading">Loading…</div>
  }

  return (
    <div className="app">
      <Sidebar />
      <TileGrid />
      {settingsOpen && <SettingsDialog />}
    </div>
  )
}
