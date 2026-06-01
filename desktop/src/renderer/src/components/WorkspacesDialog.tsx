import { useState } from 'react'
import type { WorkspaceSummary } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Workspace manager: Save (keeps the auto name) / Save As (named + pinned), and
 * the list of this project's saved workspaces with Restore / Delete and
 * current / locked / pinned badges. Restore swaps the live sessions; the list
 * refreshes after each mutation (store methods).
 */
export function WorkspacesDialog(): React.JSX.Element {
  const t = useT()
  const workspaces = useDeck((s) => s.workspaces)
  const openWorkspaces = useDeck((s) => s.openWorkspaces)
  const saveWorkspace = useDeck((s) => s.saveWorkspace)
  const restoreWorkspace = useDeck((s) => s.restoreWorkspace)
  const removeWorkspace = useDeck((s) => s.removeWorkspace)

  const [saveAsName, setSaveAsName] = useState('')
  const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null)

  const doSaveAs = (): void => {
    const name = saveAsName.trim()
    if (!name) return
    void saveWorkspace(name)
    setSaveAsName('')
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openWorkspaces(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('workspaces.title')}</h2>

        <div className="ws-actions">
          <button className="primary" onClick={() => void saveWorkspace()}>
            {t('workspaces.save')}
          </button>
          <div className="ws-saveas">
            <input
              value={saveAsName}
              placeholder={t('workspaces.saveAsPrompt')}
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSaveAs()
              }}
            />
            <button onClick={doSaveAs} disabled={!saveAsName.trim()}>
              {t('workspaces.saveAs')}
            </button>
          </div>
        </div>

        <ul className="ws-list">
          {workspaces.map((ws) => (
            <li key={ws.id} className={`ws-row ${ws.current ? 'ws-row-current' : ''}`}>
              <div className="ws-main">
                <span className="ws-name">{ws.name}</span>
                <span className="ws-sub">
                  {ws.scopeName} · {t('workspaces.sessions', { n: ws.sessionCount })}
                </span>
              </div>
              <div className="ws-badges">
                {ws.current && <span className="ws-badge ws-badge-current">{t('workspaces.current')}</span>}
                {ws.pinned && <span className="ws-badge">{t('workspaces.pinned')}</span>}
                {ws.locked && <span className="ws-badge ws-badge-locked">{t('workspaces.locked')}</span>}
              </div>
              <button
                className="ws-btn"
                disabled={ws.current}
                onClick={() => void restoreWorkspace(ws.id)}
              >
                {t('workspaces.restore')}
              </button>
              <button className="ws-btn ws-btn-danger" onClick={() => setDeleting(ws)}>
                {t('workspaces.delete')}
              </button>
            </li>
          ))}
          {workspaces.length === 0 && <li className="ws-empty">{t('workspaces.empty')}</li>}
        </ul>

        <div className="modal-actions">
          <button onClick={() => openWorkspaces(false)}>{t('common.close')}</button>
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          title={t('confirm.deleteWorkspaceTitle')}
          message={t('confirm.deleteWorkspaceMessage', { name: deleting.name })}
          confirmLabel={t('workspaces.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id
            setDeleting(null)
            void removeWorkspace(id)
          }}
        />
      )}
    </div>
  )
}
