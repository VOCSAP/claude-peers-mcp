import { useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Export the current sessions as a portable team template: a name and a "local
 * template" checkbox (unchecked = global, the default). Enter commits, Escape
 * cancels.
 */
export function ExportTemplateDialog(): React.JSX.Element {
  const t = useT()
  const exportTemplate = useDeck((s) => s.exportTemplate)
  const openExportTemplate = useDeck((s) => s.openExportTemplate)
  const currentWorkspaceName = useDeck((s) => s.currentWorkspaceName)
  const [name, setName] = useState(currentWorkspaceName ?? '')
  const [local, setLocal] = useState(false)

  const canSave = name.trim().length > 0
  const commit = (): void => {
    if (canSave) void exportTemplate(name.trim(), local)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openExportTemplate(false)}>
      <div className="modal modal-confirm" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('template.exportTitle')}</h2>
        <label className="field">
          <span>{t('template.name')}</span>
          <input
            autoFocus
            value={name}
            placeholder={t('template.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') openExportTemplate(false)
            }}
          />
        </label>
        <label className="field field-check">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          <span>{t('template.localCheckbox')}</span>
        </label>
        <small className="field-check-help">
          {local ? t('template.localHelp') : t('template.globalHelp')}
        </small>
        <div className="modal-actions">
          <button onClick={() => openExportTemplate(false)}>{t('common.cancel')}</button>
          <button className="primary" onClick={commit} disabled={!canSave}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
