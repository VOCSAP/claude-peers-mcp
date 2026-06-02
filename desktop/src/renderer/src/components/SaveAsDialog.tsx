import { useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'

/** Prompt window for "Save as": a free-text name + Save. Enter commits, Escape cancels. */
export function SaveAsDialog(): React.JSX.Element {
  const t = useT()
  const saveAs = useDeck((s) => s.saveAs)
  const openSaveAs = useDeck((s) => s.openSaveAs)
  const [name, setName] = useState('')

  const commit = (): void => {
    if (name.trim()) void saveAs(name)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openSaveAs(false)}>
      <div className="modal modal-confirm" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('saveas.title')}</h2>
        <label className="field">
          <input
            autoFocus
            value={name}
            placeholder={t('workspaces.saveAsPrompt')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') openSaveAs(false)
            }}
          />
        </label>
        <div className="modal-actions">
          <button onClick={() => openSaveAs(false)}>{t('common.cancel')}</button>
          <button className="primary" onClick={commit} disabled={!name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
