import { useT } from '../i18n'

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-confirm" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="confirm-msg">{message}</p>
        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button className="primary danger" onClick={onConfirm} autoFocus>
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
