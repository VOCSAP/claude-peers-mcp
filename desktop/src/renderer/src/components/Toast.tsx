import { useDeck } from '../store'
import { useT } from '../i18n'

/** Bottom-of-window transient status message. `toast` holds an i18n key. */
export function Toast(): React.JSX.Element | null {
  const t = useT()
  const toast = useDeck((s) => s.toast)
  const variant = useDeck((s) => s.toastVariant)
  if (!toast) return null
  return (
    <div className={`toast toast-${variant}`} role="status">
      {t(toast)}
    </div>
  )
}
