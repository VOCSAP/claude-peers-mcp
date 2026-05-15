import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Compute the cwd_key used by ~/.claude/status-line.sh:get_peer_id.
 *
 * Must match the bash logic exactly:
 *   sanitized=$(printf '%s' "$CWD" | sed 's/[^a-zA-Z0-9-]/_/g')
 *   len=${#sanitized}
 *   offset=$(( len > 40 ? len - 40 : 0 ))
 *   cwd_key="${sanitized:$offset}"
 *
 * Replaces every non-[A-Za-z0-9-] char with "_", then keeps the last 40 chars
 * (or the whole string if shorter). The explicit offset avoids the MSYS2 bash
 * 5.2 quirk where ${str: -40} returns empty when len(str) < 40.
 */
export function computeCwdKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, "_");
  return sanitized.length > 40 ? sanitized.slice(sanitized.length - 40) : sanitized;
}

/**
 * Returns true when the env var CLAUDE_PEERS_STATUS_LINE_CACHE is set to a
 * truthy value ("1", "true", "yes", "on" -- case-insensitive). Off by default
 * because the cache file is only useful for users who wire a status-line script
 * (e.g. vocsap/claude-config status-line.sh) and most users will not want
 * server.ts to litter $HOME.
 */
export function isPeerIdCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.CLAUDE_PEERS_STATUS_LINE_CACHE;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Write the current peer_id to the cache file consumed by status-line.sh,
 * when opt-in via CLAUDE_PEERS_STATUS_LINE_CACHE.
 *
 * No-op when the env var is unset/falsy. Otherwise the cache lives at
 *   $HOME/.claude/peers/peer-id-<cwdKey>.txt
 * and is overwritten on every /register so a stale value from a previous
 * version is replaced as soon as the session reconnects. Best-effort: failures
 * are silent so a transient FS issue never breaks the /register flow.
 */
export async function writePeerIdCache(
  cwd: string,
  peerId: string,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!isPeerIdCacheEnabled(env)) return;
  try {
    const cacheDir = join(home, ".claude", "peers");
    const key = computeCwdKey(cwd);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `peer-id-${key}.txt`), peerId, "utf-8");
  } catch {
    // best-effort: status-line cache is non-critical
  }
}
