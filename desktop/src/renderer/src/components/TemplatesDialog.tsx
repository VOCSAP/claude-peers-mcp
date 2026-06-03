import { useState } from 'react'
import type { TemplateSummary } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Template picker. Lists global + local templates; the selected one can be
 * Used (append to the current sessions) or Applied (replace, confirmed first
 * when sessions are open). Opened from File > Import template and the home
 * "Use template" button.
 */
export function TemplatesDialog(): React.JSX.Element {
  const t = useT()
  const templates = useDeck((s) => s.templates)
  const sessions = useDeck((s) => s.sessions)
  const manage = useDeck((s) => s.templatesManage)
  const applyTemplate = useDeck((s) => s.applyTemplate)
  const removeTemplate = useDeck((s) => s.removeTemplate)
  const openTemplates = useDeck((s) => s.openTemplates)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null)

  const use = (): void => {
    if (selected) void applyTemplate(selected, 'append')
  }
  const apply = (): void => {
    if (!selected) return
    // Replacing is destructive of the current layout -> confirm when non-empty.
    if (sessions.length > 0) setConfirmReplace(true)
    else void applyTemplate(selected, 'replace')
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openTemplates(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('template.pickTitle')}</h2>

        {templates.length === 0 ? (
          <p className="confirm-msg">{t('template.empty')}</p>
        ) : (
          <ul className="template-list">
            {templates.map((tpl) => (
              <li
                key={tpl.path}
                className={`template-row ${selected === tpl.path ? 'template-row-selected' : ''}`}
                onClick={() => setSelected(tpl.path)}
                title={tpl.path}
              >
                <span className="template-name">{tpl.name}</span>
                <span className={`template-source template-source-${tpl.source}`}>
                  {t(`template.source.${tpl.source}`)}
                </span>
                <span className="template-count">{t('template.sessions', { n: tpl.sessionCount })}</span>
                {/* Delete only in manage mode (File > Import template), never from
                    the home "Use template" path. */}
                {manage && (
                  <button
                    className="template-del"
                    title={t('template.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleting(tpl)
                    }}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions template-actions">
          <button className="btn-cancel" onClick={() => openTemplates(false)}>
            {t('common.cancel')}
          </button>
          {/* Replace only makes sense when there are sessions to replace; with an
              empty window (e.g. opened from the home "Use template" button) Apply
              would equal Use, so it is hidden. */}
          {sessions.length > 0 && (
            <button className="btn-apply" onClick={apply} disabled={!selected}>
              {t('template.apply')}
            </button>
          )}
          <button className="btn-use" onClick={use} disabled={!selected}>
            {t('template.use')}
          </button>
        </div>
      </div>

      {confirmReplace && selected && (
        <ConfirmDialog
          title={t('confirm.applyTemplateTitle')}
          message={t('confirm.applyTemplateMessage')}
          confirmLabel={t('template.apply')}
          onCancel={() => setConfirmReplace(false)}
          onConfirm={() => {
            setConfirmReplace(false)
            void applyTemplate(selected, 'replace')
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('confirm.deleteTemplateTitle')}
          message={t('confirm.deleteTemplateMessage', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const path = deleting.path
            setDeleting(null)
            if (selected === path) setSelected(null)
            void removeTemplate(path)
          }}
        />
      )}
    </div>
  )
}
