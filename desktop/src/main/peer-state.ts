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
 * Resolve the peer_id for a session. When `sessionId` is known (M3+), read the
 * exact per-session cache file first; otherwise (or if it is missing) fall back
 * to the newest `peer-id-<cwdKey>-*.txt` for this cwd.
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
      if (exact) return exact
    }

    // Fallback: newest matching file (legacy layout, or pre-register race).
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
