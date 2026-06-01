import { useEffect, useState } from 'react'
import type { AppConfig, DisplayMode, LaunchPreset } from '@shared/types'
import { useDeck } from '../store'

const DISPLAY_MODES: { value: DisplayMode; label: string }[] = [
  { value: '1x1', label: '1×1 (carousel)' },
  { value: '1x2', label: '1×2' },
  { value: '2x2', label: '2×2' },
  { value: 'custom', label: 'Custom' }
]

export function SettingsDialog(): React.JSX.Element {
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const openSettings = useDeck((s) => s.openSettings)

  const [form, setForm] = useState<AppConfig>(config)
  // launchCommand lives in the (global) launch config, not AppConfig.
  const [launchCommand, setLaunchCommand] = useState('')
  const [presets, setPresets] = useState<LaunchPreset[]>([])

  useEffect(() => {
    void window.api.getLaunchConfig().then((c) => {
      setLaunchCommand(c.launchCommand)
      setPresets(c.presets)
    })
  }, [])

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) set('projectDir', dir)
  }

  const save = async (): Promise<void> => {
    await updateConfig(form)
    await window.api.saveLaunchConfig({ launchCommand: launchCommand.trim(), presets })
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
          <span>Launch command</span>
          <input value={launchCommand} onChange={(e) => setLaunchCommand(e.target.value)} />
          <small>
            Run in each terminal, with <code>--session-id</code> appended. Saved to the global
            launch config; a project <code>.claude/claude-peers/config.json</code> overrides it.
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

        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.interactiveShell}
            onChange={(e) => set('interactiveShell', e.target.checked)}
          />
          <span>Interactive shell (load rc/profile for aliases)</span>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Display mode</span>
            <select
              value={form.displayMode}
              onChange={(e) => set('displayMode', e.target.value as DisplayMode)}
            >
              {DISPLAY_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
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
