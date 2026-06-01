// Orchestrates workspace persistence/restore on top of the pure store + lock
// modules and the SessionService. Lives in the main process (consumes electron-
// adjacent singletons via injected deps), so it is not bun-tested directly --
// its pure pieces (store, lock, session-map, scope adoption) are tested
// separately. Owns: the current workspace, its lock + heartbeat, auto-save, and
// scope adoption on restore.

import { hostname } from 'node:os'
import type { AppConfig, DisplayMode, WorkspaceSummary } from '@shared/types'
import type { Scope } from './scope'
import type { SessionService } from './session-service'
import {
  type Workspace,
  type WorkspaceDisplayMode,
  autoName,
  deleteWorkspace,
  listWorkspaces,
  loadWorkspace,
  newWorkspaceId,
  saveWorkspace
} from './workspace-store'
import { acquireLock, isLockLive, readLock, refreshLock, releaseLock } from './workspace-lock'
import { fromWorkspaceSessions, toWorkspaceSessions } from './workspace-session-map'

const HEARTBEAT_MS = 30_000
/** Cross-host lock is stale after this without a heartbeat (best-effort, DESIGN 15). */
const LOCK_STALE_MS = 120_000

/** True if `pid` is a live process on this machine (EPERM still means alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function toDisplayMode(cfg: AppConfig): WorkspaceDisplayMode {
  switch (cfg.displayMode) {
    case '1x1':
      return { kind: 'carousel', x: 1, y: 1 }
    case '1x2':
      return { kind: 'grid', x: 2, y: 1 }
    case '2x2':
      return { kind: 'grid', x: 2, y: 2 }
    default:
      return { kind: 'grid', x: cfg.gridCols, y: cfg.gridRows }
  }
}

/** Map a persisted display mode back onto AppConfig fields. */
function fromDisplayMode(dm: WorkspaceDisplayMode): Partial<AppConfig> {
  if (dm.kind === 'carousel') return { displayMode: '1x1' }
  if (dm.x === 2 && dm.y === 1) return { displayMode: '1x2' as DisplayMode }
  if (dm.x === 2 && dm.y === 2) return { displayMode: '2x2' as DisplayMode }
  return { displayMode: 'custom' as DisplayMode, gridCols: dm.x, gridRows: dm.y }
}

export interface WorkspaceDeps {
  projectDir: string
  service: SessionService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => void
  getScope: () => Scope
  /** Adopt a workspace's scope (no-op if a session is already running). */
  adoptScope: (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }) => void
  pid?: number
  host?: string
}

export class WorkspaceService {
  private readonly host: string
  private readonly pid: number
  private currentId: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(private deps: WorkspaceDeps) {
    this.host = deps.host ?? hostname()
    this.pid = deps.pid ?? process.pid
  }

  get currentWorkspaceId(): string | null {
    return this.currentId
  }

  /**
   * Attach a workspace on launch. The empty/legacy app gets a fresh auto-save
   * workspace that captures whatever sessions the SessionService already restored
   * from userData. The restore PICKER (renderer, M6b-3) drives `restore()`.
   */
  start(): void {
    this.currentId = newWorkspaceId()
    this.saveAuto()
    acquireLock(this.deps.projectDir, this.currentId, {
      pid: this.pid,
      host: this.host,
      now: Date.now(),
      isPidAlive: pidAlive,
      staleMs: LOCK_STALE_MS
    })
    this.heartbeatTimer = setInterval(() => {
      if (this.currentId) refreshLock(this.deps.projectDir, this.currentId, Date.now())
    }, HEARTBEAT_MS)
  }

  /** Persist the live state under the current workspace id (auto name kept). */
  saveAuto(): WorkspaceSummary {
    return this.persist(undefined, false)
  }

  /** Persist under a user-chosen name and pin it (explicit Save As). */
  saveNamed(name: string): WorkspaceSummary {
    return this.persist(name.trim() || undefined, true)
  }

  /** Restore a workspace: adopt its scope, swap the session set, set the layout. */
  restore(id: string): void {
    const ws = loadWorkspace(this.deps.projectDir, id)
    if (!ws) return
    this.deps.adoptScope({ groupId: ws.groupId, scopeKind: ws.scopeKind })
    this.deps.setConfig(fromDisplayMode(ws.displayMode))
    this.deps.service.restoreFrom(fromWorkspaceSessions(ws.sessions))
    // Hand ownership of the lock from the old workspace to this one.
    if (this.currentId && this.currentId !== id) {
      releaseLock(this.deps.projectDir, this.currentId)
    }
    this.currentId = id
    acquireLock(this.deps.projectDir, id, {
      pid: this.pid,
      host: this.host,
      now: Date.now(),
      isPidAlive: pidAlive,
      staleMs: LOCK_STALE_MS
    })
    this.saveAuto()
  }

  deleteWs(id: string): void {
    if (id === this.currentId) this.currentId = null
    deleteWorkspace(this.deps.projectDir, id)
  }

  /** All workspaces for this project, with lock + current flags, newest first. */
  listForCwd(): WorkspaceSummary[] {
    const now = Date.now()
    return listWorkspaces(this.deps.projectDir).map((ws) => {
      const lock = readLock(this.deps.projectDir, ws.id)
      const lockedByOther =
        ws.id !== this.currentId &&
        !!lock &&
        isLockLive(lock, { host: this.host, now, isPidAlive: pidAlive, staleMs: LOCK_STALE_MS })
      return {
        id: ws.id,
        name: ws.name,
        pinned: ws.pinned,
        scopeName: ws.scopeName,
        sessionCount: ws.sessions.length,
        updatedAt: ws.updatedAt,
        locked: lockedByOther,
        current: ws.id === this.currentId
      }
    })
  }

  /** Final auto-save + lock release on quit. */
  releaseOnQuit(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (!this.currentId) return
    this.saveAuto()
    releaseLock(this.deps.projectDir, this.currentId)
  }

  // ----- internals -----

  private persist(name: string | undefined, pin: boolean): WorkspaceSummary {
    if (!this.currentId) this.currentId = newWorkspaceId()
    const scope = this.deps.getScope()
    const existing = loadWorkspace(this.deps.projectDir, this.currentId)
    const ws: Workspace = {
      id: this.currentId,
      name: name ?? existing?.name ?? autoName(scope.name, new Date()),
      pinned: pin || existing?.pinned || false,
      cwd: this.deps.projectDir,
      groupId: scope.groupId,
      scopeName: scope.name,
      scopeKind: scope.scopeKind,
      displayMode: toDisplayMode(this.deps.getConfig()),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      sessions: toWorkspaceSessions(this.deps.service.captureSessions())
    }
    const saved = saveWorkspace(this.deps.projectDir, ws)
    return {
      id: saved.id,
      name: saved.name,
      pinned: saved.pinned,
      scopeName: saved.scopeName,
      sessionCount: saved.sessions.length,
      updatedAt: saved.updatedAt,
      locked: false,
      current: true
    }
  }
}
