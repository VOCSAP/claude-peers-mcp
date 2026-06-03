// Pure helpers for the Deck's outbound peer announcements (no electron/node-pty
// imports, so they can be unit-tested under `bun test`). The Deck broadcasts
// these via the broker /announce endpoint; peers receive them as one-way,
// no-reply operator messages.

/** What the Deck needs, captured at create time, to compose a join announce. */
export interface JoinAnnounceIntent {
  /**
   * Operator-edited free text from the advanced create menu (pre-filled with the
   * agent/model/effort summary). Null/empty => compose the structured default.
   */
  custom: string | null
  agent: string
  model: string
  effort: string
}

/**
 * The editable default the advanced create menu pre-fills its announce field
 * with. The peer_id is unknown at create time, so it is injected later by
 * composeJoinAnnounce; this is only the agent/model/effort note.
 */
export function defaultAnnounceDraft(intent: Omit<JoinAnnounceIntent, 'custom'>): string {
  return [
    `agent: ${intent.agent || 'default'}`,
    `model: ${intent.model || 'default'}`,
    `effort: ${intent.effort || 'auto'}`
  ].join(', ')
}

/**
 * Compose the final join-announce text broadcast once a fresh session's peer_id
 * resolves. The peer_id is always present (so peers can recognise the newcomer);
 * a custom note is appended after it, otherwise the structured default is used.
 */
export function composeJoinAnnounce(peerId: string, intent: JoinAnnounceIntent): string {
  const head = `New peer "${peerId}" joined the group`
  const custom = intent.custom?.trim()
  if (custom) return `${head}. ${custom}`
  return `${head} (${defaultAnnounceDraft(intent)}).`
}
