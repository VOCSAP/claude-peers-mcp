import { useEffect, useState } from 'react'
import type { AppConfig, DisplayMode, LaunchPreset, ModelOption } from '@shared/types'
import { DEFAULT_PALETTE } from '@shared/palette'
import { useDeck } from '../store'
import { useT } from '../i18n'

const DISPLAY_MODE_KEYS: { value: DisplayMode; key: string }[] = [
  { value: '1x1', key: 'mode.1x1' },
  { value: '1x2', key: 'mode.1x2' },
  { value: '2x2', key: 'mode.2x2' },
  { value: 'custom', key: 'mode.custom' }
]

export function SettingsDialog(): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const openSettings = useDeck((s) => s.openSettings)

  const [form, setForm] = useState<AppConfig>(config)
  // launchCommand lives in the (global) launch config, not AppConfig.
  const [launchCommand, setLaunchCommand] = useState('')
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  // Carried through unchanged on save so the model list survives a Settings save.
  const [models, setModels] = useState<ModelOption[]>([])

  useEffect(() => {
    void window.api.getLaunchConfig().then((c) => {
      setLaunchCommand(c.launchCommand)
      setPresets(c.presets)
      setModels(c.models)
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
    await window.api.saveLaunchConfig({ launchCommand: launchCommand.trim(), presets, models })
    openSettings(false)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openSettings(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('settings.title')}</h2>

        <label className="field">
          <span>{t('settings.projectDir')}</span>
          <div className="field-row">
            <input value={form.projectDir} onChange={(e) => set('projectDir', e.target.value)} />
            <button className="icon-btn" onClick={browse} title={t('common.browse')}>
              📁
            </button>
          </div>
          <small>{t('settings.projectDirHelp')}</small>
        </label>

        <label className="field">
          <span>{t('settings.launchCommand')}</span>
          <input value={launchCommand} onChange={(e) => setLaunchCommand(e.target.value)} />
          <small>{t('settings.launchCommandHelp')}</small>
        </label>

        <label className="field">
          <span>{t('settings.shellOverride')}</span>
          <input
            value={form.shell}
            placeholder={t('settings.shellPlaceholder')}
            onChange={(e) => set('shell', e.target.value)}
          />
          <small>{t('settings.shellHelp')}</small>
        </label>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.interactiveShell}
            onChange={(e) => set('interactiveShell', e.target.checked)}
          />
          <span>{t('settings.interactiveShell')}</span>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.displayMode')}</span>
            <select
              value={form.displayMode}
              onChange={(e) => set('displayMode', e.target.value as DisplayMode)}
            >
              {DISPLAY_MODE_KEYS.map((m) => (
                <option key={m.value} value={m.value}>
                  {t(m.key)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('settings.fontSize')}</span>
            <input
              type="number"
              min={8}
              max={32}
              value={form.fontSize}
              onChange={(e) => set('fontSize', Math.max(8, Number(e.target.value) || 13))}
            />
          </label>

          <label className="field">
            <span>{t('settings.theme')}</span>
            <select
              value={form.theme}
              onChange={(e) => set('theme', e.target.value as AppConfig['theme'])}
            >
              <option value="dark">{t('settings.themeDark')}</option>
              <option value="light">{t('settings.themeLight')}</option>
            </select>
          </label>

          <label className="field">
            <span>{t('settings.language')}</span>
            <select value={form.locale} onChange={(e) => set('locale', e.target.value)}>
              <option value="">{t('settings.languageAuto')}</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
          </label>
        </div>

        <div className="field">
          <span>{t('settings.palette')}</span>
          <div className="palette-row">
            {form.palette.map((c, i) => (
              <span key={i} className="palette-swatch">
                <input
                  type="color"
                  value={c}
                  onChange={(e) =>
                    set(
                      'palette',
                      form.palette.map((x, j) => (j === i ? e.target.value : x))
                    )
                  }
                />
                <button
                  className="palette-remove"
                  title={t('settings.paletteRemove')}
                  onClick={() =>
                    set(
                      'palette',
                      form.palette.filter((_, j) => j !== i)
                    )
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            <button className="chip" onClick={() => set('palette', [...form.palette, '#888888'])}>
              {t('settings.paletteAdd')}
            </button>
            <button className="chip" onClick={() => set('palette', [...DEFAULT_PALETTE])}>
              {t('settings.paletteReset')}
            </button>
          </div>
          <small>{t('settings.paletteHelp')}</small>
        </div>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.restoreSessions}
            onChange={(e) => set('restoreSessions', e.target.checked)}
          />
          <span>{t('settings.restoreSessions')}</span>
        </label>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.rememberScopeSecrets}
            onChange={(e) => set('rememberScopeSecrets', e.target.checked)}
          />
          <span>{t('settings.rememberScope')}</span>
        </label>
        <small className="field-check-help">{t('settings.rememberScopeHelp')}</small>

        <div className="modal-actions">
          <button onClick={() => openSettings(false)}>{t('common.cancel')}</button>
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
