import { useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Outbound megaphone: a free-text box + Send button that broadcasts an operator
 * message to every peer in the active group (via the broker /announce endpoint).
 * One-way -- peers receive it as a no-reply announcement. Enter sends;
 * Shift+Enter inserts a newline.
 */
export function MessageBar(): React.JSX.Element {
  const t = useT()
  const broadcastAnnounce = useDeck((s) => s.broadcastAnnounce)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const canSend = text.trim().length > 0 && !sending

  const send = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      await broadcastAnnounce(text)
      setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="message-bar">
      <textarea
        className="message-input"
        rows={2}
        value={text}
        placeholder={t('message.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button
        className="send-btn"
        title={t('message.sendTitle')}
        aria-label={t('message.send')}
        disabled={!canSend}
        onClick={() => void send()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
        </svg>
      </button>
    </div>
  )
}
