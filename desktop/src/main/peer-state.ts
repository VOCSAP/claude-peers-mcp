import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the display `peer_id` a session is currently registered under, by
 * reading the claude-peers status-line cache files written by `server.ts`:
 *   $HOME/.claude/peers/peer-id-<cwdKey>[-<sessionId>].txt
 *
 * The Deck spawns peer terminals with CLAUDE_PEERS_STATUS_LINE_CACHE=1 so this
 * cache is populated even for users who never wired a status-line script. Since
 * M3 the Deck launches each session with a known `--session-id`, so we can read
 * the exact per-session file deterministically instead of guessing the newest.
 *
 * Best-effort: any failure resolves to null (the tile simply shows no peer_id).
 */

const PEERS_DIR = join(homedir(), '.claude', 'peers')

/** Mirror of shared/peer-cache.ts:computeCwdKey -- must stay in sync. */
export function computeCwdKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, '_')
  return sanitized.length > 40 ? sanitized.slice(sanitized.length - 40) : sanitized
}

/** Mirror of shared/peer-cache.ts:sanitizeSessionId -- replace non-[A-Za-z0-9-] with '_', cap 64. */
export function sanitizeSessionId(sessionId: string | undefined | null): string {
  if (!sessionId) return ''
  const clean = sessionId.replace(/[^A-Za-z0-9-]/g, '_')
  return clean.length > 64 ? clean.slice(0, 64) : clean
}

function readPeerIdFile(full: string): string | null {
  try {
    const value = readFileSync(full, 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

/**
 * Resolve the peer_id for a session. When `sessionId` is known (M3+), read
 * ONLY the exact per-session cache file for it -- on a miss, return null,
 * NEVER borrow a neighbouring tile's cache file for the same cwdKey (card
 * aa8d6b5f: that neighbour-borrowing fail-open let a /clear'd tile silently
 * adopt another tile's identity). The newest-file-by-mtime fallback applies
 * only when no `sessionId` is known at all (legacy layout).
 * No production caller today: resolvePeerIdAmong (below) resolves every live
 * tile instead. Kept as a single-id resolver for a future caller, and because
 * its own test is the living record of the aa8d6b5f arbitration.
 */
export function resolvePeerId(
  cwd: string,
  sessionId?: string,
  peersDir: string = PEERS_DIR
): string | null {
  try {
    if (!existsSync(peersDir)) return null
    const key = computeCwdKey(cwd)

    // Deterministic: the exact file this session writes.
    const suffix = sanitizeSessionId(sessionId)
    if (suffix) {
      const exact = readPeerIdFile(join(peersDir, `peer-id-${key}-${suffix}.txt`))
      // A sessionId was given but its exact cache file is missing (e.g. a
      // /clear rotated CLAUDE_CODE_SESSION_ID in-process without
      // re-registering, card aa8d6b5f). Fail CLOSED: never borrow the newest
      // sibling file for this cwdKey, which may belong to a different tile.
      return exact
    }

    // Fallback: newest matching file. Legacy layout only (no sessionId known
    // at all) -- the mtime guess is never applied once a sessionId is given.
    const prefix = `peer-id-${key}`
    const matches = readdirSync(peersDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
      .map((f) => {
        const full = join(peersDir, f)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    const newest = matches[0]
    return newest ? readPeerIdFile(newest.full) : null
  } catch {
    return null
  }
}

function peerIdCacheFileName(cwd: string, sessionId: string): string {
  return `peer-id-${computeCwdKey(cwd)}-${sessionId}.txt`
}

/**
 * Rejects only what a torn or truncated read can produce (whitespace, a
 * control character), not what the broker's own peer_id policy would --
 * this module does not own that policy and must not need to agree with it
 * to accept a value the broker legitimately minted.
 */
const PLAUSIBLE_CACHE_VALUE_RE = /^[\x21-\x7e]{1,64}$/

/**
 * Resolve the peer_id among every real session id one tile has itself
 * adopted (SessionDef.sessionIdHistory), taking whichever of THEIR cache
 * files was written most recently.
 * The mtime comparison, forbidden in resolvePeerId (card aa8d6b5f) between
 * different tiles' files, is safe here for the opposite reason: every id
 * compared is proven to belong to THIS one tile, so there is no sibling
 * left to borrow from. No known path ever rewrites a cache file under
 * anything but the earliest id a tile registered under, but even if one
 * did, the mtime comparison would already prefer it -- the design does not
 * depend on that premise holding.
 * A read value that fails the plausibility check is treated as absent, so a
 * torn or truncated-but-non-empty file is never surfaced as an identity.
 */
export function resolvePeerIdAmong(
  cwd: string,
  sessionIds: readonly string[],
  peersDir: string = PEERS_DIR
): string | null {
  try {
    if (!existsSync(peersDir)) return null
    let best: { value: string; mtime: number } | null = null
    for (const id of sessionIds) {
      const suffix = sanitizeSessionId(id)
      if (!suffix) continue
      const full = join(peersDir, peerIdCacheFileName(cwd, suffix))
      if (!existsSync(full)) continue
      const value = readFileSync(full, 'utf8').trim()
      if (!value || !PLAUSIBLE_CACHE_VALUE_RE.test(value)) continue
      const mtime = statSync(full).mtimeMs
      if (!best || mtime > best.mtime) best = { value, mtime }
    }
    return best ? best.value : null
  } catch {
    return null
  }
}
