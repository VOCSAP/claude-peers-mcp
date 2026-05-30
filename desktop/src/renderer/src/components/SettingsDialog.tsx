import { useState } from 'react'
import type { AppConfig } from '@shared/types'
import { useDeck } from '../store'

export function SettingsDialog(): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const openSettings = useDeck((s) => s.openSettings)

  const [form, setForm] = useState<AppConfig>(config)

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) set('projectDir', dir)
  }

  const save = async (): Promise<void> => {
    await updateConfig(form)
    openSettings(false)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openSettings(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label className="field">
          <span>Project directory</span>
          <div className="field-row">
            <input value={form.projectDir} onChange={(e) => set('projectDir', e.target.value)} />
            <button className="icon-btn" onClick={browse} title="Browse…">
              📁
            </button>
          </div>
          <small>Default working directory for new peer terminals.</small>
        </label>

        <label className="field">
          <span>Peer command</span>
          <input value={form.peerCommand} onChange={(e) => set('peerCommand', e.target.value)} />
          <small>
            Launched inside each terminal (e.g. your <code>claudepeers</code> alias). Resolved via
            your login shell so aliases load.
          </small>
        </label>

        <label className="field">
          <span>Shell override</span>
          <input
            value={form.shell}
            placeholder="auto ($SHELL / powershell.exe)"
            onChange={(e) => set('shell', e.target.value)}
          />
          <small>Leave empty to auto-detect per OS.</small>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Columns</span>
            <input
              type="number"
              min={1}
              max={6}
              value={form.columns}
              onChange={(e) => set('columns', Math.max(1, Number(e.target.value) || 1))}
            />
          </label>

          <label className="field">
            <span>Font size</span>
            <input
              type="number"
              min={8}
              max={32}
              value={form.fontSize}
              onChange={(e) => set('fontSize', Math.max(8, Number(e.target.value) || 13))}
            />
          </label>

          <label className="field">
            <span>Theme</span>
            <select
              value={form.theme}
              onChange={(e) => set('theme', e.target.value as AppConfig['theme'])}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.restoreSessions}
            onChange={(e) => set('restoreSessions', e.target.checked)}
          />
          <span>Re-open saved sessions on launch</span>
        </label>

        <div className="modal-actions">
          <button onClick={() => openSettings(false)}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
