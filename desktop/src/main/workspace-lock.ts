// Sidecar lock for a workspace owned by a running Deck (DESIGN 6.5).
// File: <project>/.claude/claude-peers/workspaces/<id>.lock
//
// Same-host liveness uses an injected `isPidAlive` predicate (real impl:
// process.kill(pid, 0)) -- reliable, no clock dependency. Cross-host liveness
// can only rely on heartbeat freshness across two clocks -> best-effort
// (documented DESIGN 15). A robust cross-host lock would delegate to the broker
// (single clock) -- a Phase 2 enhancement.
//
// Pure: node fs/path only (the pid predicate, host and clock are injected), so
// it is unit-testable under bun.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Lock {
  pid: number
  host: string
  startedAt: number
  heartbeat: number
}

export interface LivenessOpts {
  /** Hostname of THIS machine (to tell same-host from cross-host). */
  host: string
  /** Current epoch ms. */
  now: number
  /** True if `pid` is a live process on this machine (real: process.kill(pid,0)). */
  isPidAlive: (pid: number) => boolean
  /** Cross-host: a heartbeat older-or-equal to now-staleMs is considered stale. */
  staleMs: number
}

export function lockPath(projectDir: string, id: string): string {
  return join(projectDir, '.claude', 'claude-peers', 'workspaces', `${id}.lock`)
}

export function readLock(projectDir: string, id: string): Lock | null {
  const file = lockPath(projectDir, id)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Lock>
    if (typeof parsed.pid === 'number' && typeof parsed.host === 'string') {
      return {
        pid: parsed.pid,
        host: parsed.host,
        startedAt: parsed.startedAt ?? 0,
        heartbeat: parsed.heartbeat ?? 0
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Is a lock held by a LIVE owner?
 * - Same host: trust the OS process table via `isPidAlive`.
 * - Cross host: trust heartbeat freshness only (best-effort). A heartbeat
 *   older-or-equal to `now - staleMs` is stale (boundary treated as stale).
 */
export function isLockLive(lock: Lock, opts: LivenessOpts): boolean {
  if (lock.host === opts.host) {
    return opts.isPidAlive(lock.pid)
  }
  return lock.heartbeat > opts.now - opts.staleMs
}

function writeLock(projectDir: string, id: string, lock: Lock): void {
  writeFileSync(lockPath(projectDir, id), JSON.stringify(lock), 'utf8')
}

/**
 * Try to acquire the lock for `id`. Refuses if an existing lock is held by a
 * live owner; otherwise writes a fresh lock (reclaiming a stale one) and returns
 * true. `pid`/`host`/`now` describe THIS owner.
 */
export function acquireLock(
  projectDir: string,
  id: string,
  opts: LivenessOpts & { pid: number }
): boolean {
  const existing = readLock(projectDir, id)
  if (existing && isLockLive(existing, opts)) return false
  writeLock(projectDir, id, {
    pid: opts.pid,
    host: opts.host,
    startedAt: opts.now,
    heartbeat: opts.now
  })
  return true
}

/** Refresh the heartbeat of an owned lock (no-op if the file vanished). */
export function refreshLock(projectDir: string, id: string, now: number): void {
  const lock = readLock(projectDir, id)
  if (!lock) return
  writeLock(projectDir, id, { ...lock, heartbeat: now })
}

/** Release (delete) the lock file. Best-effort. */
export function releaseLock(projectDir: string, id: string): void {
  try {
    rmSync(lockPath(projectDir, id), { force: true })
  } catch {
    // already gone -> nothing to do
  }
}
