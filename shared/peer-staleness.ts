// A mirror's last_seen is refreshed by the federation link, not a heartbeat of
// its own, so its floor must outlive the worst backoff between passes, never
// the operator's plain ACTIVE_STALE_SEC cutoff used for locally-heartbeating rows.

/** Fallback used whenever an input fails validation, so the sweep never gets 0. */
export const DEFAULT_ACTIVE_STALE_SEC = 120;
const DEFAULT_SYNC_BACKOFF_MAX_MS = 60_000;

function sanitizeSeconds(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sanitizeMs(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Seconds a mirror row (a replica's copy of an upstream peer, refreshed once
 * per federation pass) may go without an update before the sweep marks it
 * dormant. Never below twice the longest interval between two passes: the
 * failure backoff ceiling when the link is down, the sync tick when it is up
 * (the tick has no ceiling, an operator may set it to minutes). The factor 2
 * is a one-pass margin. Invalid input (NaN, non-finite, <= 0) falls back to
 * the documented default rather than to 0, which would make the sweep flip
 * every active row on the next tick.
 */
export function mirrorStaleSec(activeStaleSec: number, syncBackoffMaxMs: number, syncTickMs = 0): number {
  const staleSec = sanitizeSeconds(activeStaleSec, DEFAULT_ACTIVE_STALE_SEC);
  const backoffMs = sanitizeMs(syncBackoffMaxMs, DEFAULT_SYNC_BACKOFF_MAX_MS);
  const tickMs = Number.isFinite(syncTickMs) && syncTickMs > 0 ? syncTickMs : 0;
  return Math.max(staleSec, (2 * Math.max(backoffMs, tickMs)) / 1000);
}

/**
 * A one-line startup warning whenever the floor actually raises the
 * operator's `CLAUDE_PEERS_ACTIVE_STALE_SEC` for mirrors on a replica broker:
 * a value applied silently is a setting the operator believes is in force and
 * is not. Returns null when there is nothing to say: not in replica mode, or
 * the configured value already reaches the floor. Invalid input always warns
 * (in replica mode) since the fallback it applies is itself worth surfacing.
 */
export function mirrorStaleWarning(
  activeStaleSec: number,
  syncBackoffMaxMs: number,
  replicaMode: boolean,
  syncTickMs = 0
): string | null {
  if (!replicaMode) return null;
  const invalid = !Number.isFinite(activeStaleSec) || activeStaleSec <= 0;
  const floorSec = mirrorStaleSec(activeStaleSec, syncBackoffMaxMs, syncTickMs);
  if (invalid) {
    return (
      `CLAUDE_PEERS_ACTIVE_STALE_SEC=${activeStaleSec} is not a valid positive number: ` +
      `the mirror floor assumes the ${DEFAULT_ACTIVE_STALE_SEC}s default (${floorSec}s applied); ` +
      `fix the value, the heartbeat sweep itself cannot run on it.`
    );
  }
  const staleSec = sanitizeSeconds(activeStaleSec, DEFAULT_ACTIVE_STALE_SEC);
  if (staleSec >= floorSec) return null;
  const backoffSec = sanitizeMs(syncBackoffMaxMs, DEFAULT_SYNC_BACKOFF_MAX_MS) / 1000;
  return (
    `CLAUDE_PEERS_ACTIVE_STALE_SEC=${staleSec}s is below twice the longest interval between two sync passes ` +
    `(backoff ceiling ${backoffSec}s, tick ${syncTickMs / 1000}s): mirror rows ` +
    `(peers relayed from the upstream, with no heartbeat of their own) are floored to ` +
    `${floorSec}s so a sync pass that is late cannot flip them dormant mid-grace.`
  );
}
