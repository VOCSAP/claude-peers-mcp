// Convert between the runtime SessionDef (session-service) and the persisted
// WorkspaceSession (workspace-store). Pure: no imports beyond the local types,
// so it is unit-testable under bun. SessionDef carries `args` as a single
// string (how the UI builds it); WorkspaceSession stores it as a string[].

import { randomUUID } from 'node:crypto'
// Relative import (not the @shared alias) so this module resolves cleanly when
// the bun test imports it directly, per the pure-module testing convention.
import type { SessionDef } from '../shared/types'
import type { WorkspaceSession } from './workspace-store'

/** Split a free-form args string into tokens on whitespace. */
export function splitArgs(args: string): string[] {
  return args.trim().length === 0 ? [] : args.trim().split(/\s+/)
}

/** Join arg tokens back into the single-string form SessionDef uses. */
export function joinArgs(args: string[]): string {
  return args.join(' ')
}

/** Snapshot live session defs as persisted workspace sessions (order preserved). */
export function toWorkspaceSessions(defs: SessionDef[]): WorkspaceSession[] {
  return defs.map((d, i) => ({
    claudeSessionId: d.sessionId,
    name: d.name,
    cwd: d.cwd,
    args: splitArgs(d.args),
    color: d.color,
    position: i
  }))
}

/** Rebuild session defs from a persisted workspace (fresh local ids; ordered). */
export function fromWorkspaceSessions(sessions: WorkspaceSession[]): SessionDef[] {
  return [...sessions]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      id: randomUUID(),
      name: s.name,
      cwd: s.cwd,
      command: '',
      args: joinArgs(s.args),
      sessionId: s.claudeSessionId,
      color: s.color,
      createdAt: Date.now()
    }))
}
