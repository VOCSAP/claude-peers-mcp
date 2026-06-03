import { useEffect, useState } from 'react'
import type { LaunchPreset, ModelOption } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Advanced create popover: pick a subagent, a custom name + colour, a model, a
 * reasoning-effort level, free args, a preset, and (advanced) a different working
 * folder. Builds a single CreateSessionInput and spawns the session.
 */

/** Effort slider stops. Index 0 = Auto (omit --effort), then the CLI levels. */
const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function CreateMenu({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const createSession = useDeck((s) => s.createSession)

  const [agents, setAgents] = useState<string[]>([])
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [agent, setAgent] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effortIdx, setEffortIdx] = useState(0)
  const [extraArgs, setExtraArgs] = useState('')
  const [color, setColor] = useState('#4f86ff')
  const [customColor, setCustomColor] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listAgents().then(setAgents)
    void window.api.getLaunchConfig().then((c) => {
      setPresets(c.presets)
      setModels(c.models)
    })
    // Seed the colour swatch with the real colour the session would receive, so
    // the preview is honest even when the user does not pick a custom colour.
    void window.api.peekNextColor().then(setColor)
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

  // Auto-name preview: the agent name, else "peer". The main process appends the
  // smallest free numeric suffix when this collides with a live session.
  const namePreview = agent.trim() || 'peer'
  const effortLevel = EFFORT_LEVELS[effortIdx]

  const submit = (): void => {
    void createSession({
      name: name.trim() || undefined,
      agent: agent || undefined,
      model: model || undefined,
      effort: effortLevel || undefined,
      args: extraArgs.trim() || undefined,
      cwd: folder ?? undefined,
      // Only force a colour when the user explicitly picked one; otherwise the
      // main process assigns the next palette colour at spawn time.
      color: customColor ? color : undefined
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

        <div className="field create-name-row">
          <label className="field create-name-field">
            <span>{t('create.name')}</span>
            <input value={name} placeholder={namePreview} onChange={(e) => setName(e.target.value)} />
          </label>
          {/* Colour control: a palette swatch + label painted in the chosen
              colour. Clicking opens the native picker (label wraps the input). */}
          <label className="colour-btn" title={t('create.colourTitle')}>
            <span className="colour-dot" style={{ background: color }} />
            <span style={{ color }}>{t('create.customColour')}</span>
            <input
              type="color"
              className="colour-hidden"
              value={color}
              onChange={(e) => {
                setColor(e.target.value)
                setCustomColor(true)
              }}
            />
          </label>
        </div>

        <label className="field">
          <span>{t('create.model')}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t('create.modelDefault')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>
            {t('create.effort')}: <strong>{effortLevel || t('create.effortAuto')}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={EFFORT_LEVELS.length - 1}
            step={1}
            value={effortIdx}
            onChange={(e) => setEffortIdx(Number(e.target.value))}
          />
          <div className="effort-ends">
            <span>{t('create.effortFaster')}</span>
            <span>{t('create.effortSmarter')}</span>
          </div>
        </div>

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

        <label className="field">
          <span>{t('create.extraArgs')}</span>
          <input
            value={extraArgs}
            placeholder={t('create.extraArgsPlaceholder')}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
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
