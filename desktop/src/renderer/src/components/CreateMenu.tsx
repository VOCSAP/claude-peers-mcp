import { useEffect, useState } from 'react'
import type { LaunchPreset } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Advanced create popover: pick a subagent, free args, a preset, an optional
 * custom colour, and (advanced) a different working folder. Builds a single
 * CreateSessionInput and spawns the session.
 */
export function CreateMenu({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const createSession = useDeck((s) => s.createSession)

  const [agents, setAgents] = useState<string[]>([])
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [agent, setAgent] = useState('')
  const [extraArgs, setExtraArgs] = useState('')
  const [useColor, setUseColor] = useState(false)
  const [color, setColor] = useState('#4f86ff')
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listAgents().then(setAgents)
    void window.api.getLaunchConfig().then((c) => setPresets(c.presets))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const applyPreset = (p: LaunchPreset): void => {
    setExtraArgs((prev) => [prev.trim(), p.args.trim()].filter(Boolean).join(' '))
  }

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setFolder(dir)
  }

  const submit = (): void => {
    const args = [agent ? `--agent ${agent}` : '', extraArgs.trim()].filter(Boolean).join(' ')
    void createSession({
      args: args || undefined,
      cwd: folder ?? undefined,
      color: useColor ? color : undefined
    })
    onClose()
  }

  return (
    <div className="popover-backdrop" onMouseDown={onClose}>
      <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('create.title')}</h3>

        <label className="field">
          <span>{t('create.agent')}</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{t('create.agentDefault')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('create.extraArgs')}</span>
          <input
            value={extraArgs}
            placeholder={t('create.extraArgsPlaceholder')}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </label>

        {presets.length > 0 && (
          <div className="field">
            <span>{t('create.presets')}</span>
            <div className="preset-row">
              {presets.map((p) => (
                <button key={p.label} className="chip" onClick={() => applyPreset(p)} title={p.args}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="field field-check">
          <input type="checkbox" checked={useColor} onChange={(e) => setUseColor(e.target.checked)} />
          <span>{t('create.customColour')}</span>
          {useColor && (
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          )}
        </label>

        <details className="advanced">
          <summary>{t('create.advanced')}</summary>
          <div className="field">
            <span>{t('create.workingFolder')}</span>
            <div className="field-row">
              <input
                value={folder ?? ''}
                placeholder={t('create.workingFolderPlaceholder')}
                onChange={(e) => setFolder(e.target.value || null)}
              />
              <button className="icon-btn" onClick={browse} title={t('common.browse')}>
                📁
              </button>
            </div>
            <small>{t('create.workingFolderHelp')}</small>
          </div>
        </details>

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
