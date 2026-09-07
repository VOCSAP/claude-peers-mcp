// Plain JSON on purpose: these messages transit the broker's unencrypted SQLite
// anyway, so encrypting the local copy would protect nothing.
// The journal is the only durable copy of what was already shown: a session_id
// is minted in-memory and never persisted, so a restart starts a brand new
// session whose cursor seeds at the box's current max id, unable to replay
// anything from the broker either.
// SESSION scope: every function takes the WINDOW's directory
// (session-state.ts's sessionStateDir), never the shared state root. Two Kory
// windows share userData, and an inbox written at the root is read by both.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'
import { inboxEntryKey, type InboxAckStatus, type InboxMessage } from '../shared/types'

export const INBOX_HISTORY_CAP = 500
const FILE = 'inbox-history.json'

export function inboxHistoryFile(sessionDir: string): string {
  return join(sessionDir, FILE)
}

/** Load the persisted history (oldest first). Corrupt/missing file -> []. */
export function loadInboxHistory(sessionDir: string): InboxMessage[] {
  try {
    const raw = JSON.parse(readFileSync(inboxHistoryFile(sessionDir), 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (m): m is InboxMessage =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as InboxMessage).id === 'number' &&
        typeof (m as InboxMessage).from === 'string' &&
        typeof (m as InboxMessage).text === 'string' &&
        typeof (m as InboxMessage).sentAt === 'string'
    )
  } catch {
    return []
  }
}

/**
 * Append a drained batch and persist, deduplicating by broker message id
 * (defensive: a crash between drain and write can re-deliver nothing, but a
 * double append from a retry must not duplicate). Oldest entries fall off
 * past the cap. Returns the merged history (oldest first).
 */
export function appendInboxHistory(
  sessionDir: string,
  batch: InboxMessage[],
  cap = INBOX_HISTORY_CAP,
  onPersistError?: (e: unknown) => void
): InboxMessage[] {
  const current = loadInboxHistory(sessionDir)
  const known = new Set(current.map((m) => m.id))
  const merged = [...current, ...batch.filter((m) => !known.has(m.id))].slice(-cap)
  try {
    mkdirSync(sessionDir, { recursive: true })
    // Atomic (temp + rename): the inbox drain is destructive, so a torn write
    // would lose the only durable copy of the drained operator messages.
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify(merged))
  } catch (e) {
    // Persistence failure: the in-memory inbox still works this run, but the
    // broker drain was destructive -- the caller must know (O6) so it can
    // retry the batch instead of silently losing the only durable copy.
    onPersistError?.(e)
  }
  return merged
}

/**
 * Courrier lot 1D (card 1e81ee7b, design doc section 6.1/8): truncate the
 * WHOLE local journal to empty, at the SAME instant as the broker-side
 * session-scope purge (ipc.ts's app:new-clear / workspace:restore /
 * template:apply-replace handlers). Skipping this half is the exact trap the
 * design doc names: deleting broker-side without truncating here leaves the
 * dead entries ON SCREEN, so the bug would read as unfixed.
 */
export function clearInboxHistory(sessionDir: string, onPersistError?: (e: unknown) => void): void {
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify([]))
  } catch (e) {
    onPersistError?.(e)
  }
}

/**
 * Courrier lot 1E (card 1e81ee7b): remove specific entries by broker message
 * id -- the manual "delete this one" gesture, distinct from clearInboxHistory
 * above (a session-scope reset) and from ack (a read-state change that never
 * removes the entry). Returns the remaining history (oldest first) so the
 * caller can re-broadcast it without a second disk read.
 */
export function deleteInboxHistoryEntries(
  sessionDir: string,
  ids: number[],
  onPersistError?: (e: unknown) => void
): InboxMessage[] {
  const idSet = new Set(ids)
  const remaining = loadInboxHistory(sessionDir).filter((m) => !idSet.has(m.id))
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify(remaining))
  } catch (e) {
    onPersistError?.(e)
  }
  return remaining
}

// Three read-states, never folded to two: absent from both sets is unread, in
// `seen` is opened but not resolved, in `acked` is dismissed; `seen` never
// regresses an `acked` entry.
// Keyed by (id, sentAt) rather than the bare broker id: messages.id can collide
// after the broker's DB is wiped or swapped to a shared broker, and sentAt
// disambiguates a replayed id.

export const INBOX_ACK_CAP = 2000
const ACK_FILE = 'inbox-ack.json'

interface AckFileShape {
  seen: string[]
  acked: string[]
}

export function inboxAckFile(sessionDir: string): string {
  return join(sessionDir, ACK_FILE)
}

function loadAckFile(sessionDir: string): AckFileShape {
  try {
    const raw = JSON.parse(readFileSync(inboxAckFile(sessionDir), 'utf-8'))
    const seen = Array.isArray(raw?.seen)
      ? raw.seen.filter((k: unknown): k is string => typeof k === 'string')
      : []
    const acked = Array.isArray(raw?.acked)
      ? raw.acked.filter((k: unknown): k is string => typeof k === 'string')
      : []
    return { seen, acked }
  } catch {
    return { seen: [], acked: [] }
  }
}

function saveAckFile(
  sessionDir: string,
  state: AckFileShape,
  onPersistError?: (e: unknown) => void
): void {
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxAckFile(sessionDir), JSON.stringify(state))
  } catch (e) {
    onPersistError?.(e)
  }
}

/** Merged read-state map for startup hydration: key -> 'seen' | 'acked'. */
export function loadAckState(sessionDir: string): Record<string, InboxAckStatus> {
  const { seen, acked } = loadAckFile(sessionDir)
  const out: Record<string, InboxAckStatus> = {}
  for (const k of seen) out[k] = 'seen'
  for (const k of acked) out[k] = 'acked' // acked always wins over a stale seen entry
  return out
}

/**
 * Triggers only on absence of the ack file, checked with existsSync before any
 * read, never inferred from a read failure -- a corrupt file must never be
 * treated as missing, or a disk incident would silently mass-acknowledge real
 * unacked state.
 * Writes the file unconditionally on first read, even when empty, so the
 * existence check alone makes this idempotent.
 */
export function loadAckStateWithMigrationSeed(
  sessionDir: string,
  onPersistError?: (e: unknown) => void
): Record<string, InboxAckStatus> {
  if (!existsSync(inboxAckFile(sessionDir))) {
    const seedKeys = loadInboxHistory(sessionDir).map((m) =>
      inboxEntryKey({ kind: 'message', message: m })
    )
    saveAckFile(sessionDir, { seen: [], acked: seedKeys }, onPersistError)
  }
  return loadAckState(sessionDir)
}

/**
 * Mark one key seen (idempotent) and persist. A no-op if the key is already
 * 'acked' — seen must never regress an ack.
 */
export function appendSeenKey(
  sessionDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(sessionDir)
  if (state.acked.includes(key) || state.seen.includes(key)) return
  state.seen = [...state.seen, key].slice(-cap)
  saveAckFile(sessionDir, state, onPersistError)
}

/**
 * Mark one key acked and persist (idempotent). Removed from `seen` if
 * present there — the two sets stay disjoint on disk, `loadAckState`'s
 * override order is defense in depth, not the only guard.
 */
export function appendAckedKey(
  sessionDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(sessionDir)
  if (state.acked.includes(key)) return
  state.seen = state.seen.filter((k) => k !== key)
  state.acked = [...state.acked, key].slice(-cap)
  saveAckFile(sessionDir, state, onPersistError)
}

export interface UnscopedInboxDiscard {
  /** History entries thrown away with the unkeyed file. */
  historyEntries: number
  /** seen + acked keys thrown away with the unkeyed ack file. */
  ackKeys: number
}

/**
 * Remove the unkeyed inbox files an earlier layout wrote at the state ROOT
 * (`<stateDir>/inbox-history.json`, `<stateDir>/inbox-ack.json`). Their
 * content is an unattributable mix of every window that ever ran here, so it
 * is discarded rather than split across groups by guesswork; the caller logs
 * the returned counts. Returns null when neither file exists (the steady
 * state after the first run). A removal failure propagates: the caller
 * reports it and the next start retries.
 */
export function discardUnscopedInboxFiles(stateDir: string): UnscopedInboxDiscard | null {
  const historyFile = join(stateDir, FILE)
  const ackFile = join(stateDir, ACK_FILE)
  const hadHistory = existsSync(historyFile)
  const hadAck = existsSync(ackFile)
  if (!hadHistory && !hadAck) return null
  const historyEntries = hadHistory ? loadInboxHistory(stateDir).length : 0
  let ackKeys = 0
  if (hadAck) {
    const { seen, acked } = loadAckFile(stateDir)
    ackKeys = seen.length + acked.length
  }
  if (hadHistory) rmSync(historyFile)
  if (hadAck) rmSync(ackFile)
  return { historyEntries, ackKeys }
}
