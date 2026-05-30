import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the display `peer_id` a session is currently registered under, by
 * reading the claude-peers status-line cache files written by `server.ts`:
 *   $HOME/.claude/peers/peer-id-<cwdKey>[-<sessionId>].txt
 *
 * The Deck spawns peer terminals with CLAUDE_PEERS_STATUS_LINE_CACHE=1 so this
 * cache is populated even for users who never wired a status-line script.
 *
 * Best-effort: any failure resolves to null (the tile simply shows no peer_id).
 */

const PEERS_DIR = join(homedir(), '.claude', 'peers')

/** Mirror of shared/peer-cache.ts:computeCwdKey -- must stay in sync. */
export function computeCwdKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, '_')
  return sanitized.length > 40 ? sanitized.slice(sanitized.length - 40) : sanitized
}

export function resolvePeerId(cwd: string): string | null {
  try {
    if (!existsSync(PEERS_DIR)) return null
    const key = computeCwdKey(cwd)
    const prefix = `peer-id-${key}`
    const matches = readdirSync(PEERS_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
      .map((f) => {
        const full = join(PEERS_DIR, f)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    const newest = matches[0]
    if (!newest) return null
    const value = readFileSync(newest.full, 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}
