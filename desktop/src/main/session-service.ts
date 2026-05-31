import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  AppConfig,
  CreateSessionInput,
  SessionDef,
  SessionRuntime,
  SessionStatus
} from '@shared/types'
import { PtyManager } from './pty-manager'
import { resolvePeerId } from './peer-state'
import { loadSessions, saveSessions } from './store'
import { buildSessionCommandLine, type SpawnMode } from './session-command'

interface RuntimeState {
  status: SessionStatus
  exitCode: number | null
  peerId: string | null
}

const PEER_POLL_MS = 4000

/**
 * Coordinates the persisted session list, the live PTYs and the resolved
 * peer_id. Emits `data` / `exit` (forwarded to the renderer verbatim) and
 * `changed` (a fresh SessionRuntime[] whenever status/peer_id moves).
 */
export class SessionService extends EventEmitter {
  private defs: SessionDef[]
  private runtime = new Map<string, RuntimeState>()
  private pty = new PtyManager()
  private pollTimer: NodeJS.Timeout | null = null

  constructor(
    private getConfig: () => AppConfig,
    /** Forced-group scope env merged into every spawned PTY (see scope.ts). */
    private scopeEnv: Record<string, string> = {},
    /** Resolved base command (launch-config) used when a session has no override. */
    private launchCommand = ''
  ) {
    super()
    // Normalize older persisted sessions that predate args/sessionId.
    this.defs = loadSessions().map((d) => ({ command: '', args: '', sessionId: '', ...d }))
    for (const d of this.defs) {
      this.runtime.set(d.id, { status: 'exited', exitCode: null, peerId: null })
    }

    this.pty.on('data', (e) => this.emit('data', e))
    this.pty.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
      const r = this.runtime.get(id)
      if (r) {
        r.status = 'exited'
        r.exitCode = exitCode
      }
      this.emit('exit', { id, exitCode })
      this.broadcast()
    })
  }

  /** Spawn persisted sessions (if enabled) and start the peer_id poll. */
  start(): void {
    if (this.getConfig().restoreSessions) {
      // Restore = fork-on-resume from each session's last id.
      for (const d of this.defs) this.startPty(d, 'resume')
    }
    this.pollTimer = setInterval(() => this.pollPeerIds(), PEER_POLL_MS)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pty.killAll()
  }

  list(): SessionRuntime[] {
    return this.defs.map((d) => this.toRuntime(d))
  }

  create(input: CreateSessionInput): SessionRuntime {
    const cfg = this.getConfig()
    const def: SessionDef = {
      id: randomUUID(),
      name: input.name?.trim() || this.defaultName(),
      cwd: input.cwd?.trim() || cfg.projectDir,
      // Empty => the resolved launchCommand; a non-empty value overrides it.
      command: input.command?.trim() || '',
      args: input.args?.trim() || '',
      sessionId: '',
      createdAt: Date.now()
    }
    this.defs.push(def)
    this.runtime.set(def.id, { status: 'starting', exitCode: null, peerId: null })
    this.startPty(def, 'fresh')
    this.broadcast()
    return this.toRuntime(def)
  }

  remove(id: string): void {
    this.pty.kill(id)
    this.defs = this.defs.filter((d) => d.id !== id)
    this.runtime.delete(id)
    this.persist()
    this.broadcast()
  }

  rename(id: string, name: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def) return
    def.name = name.trim() || def.name
    this.persist()
    this.broadcast()
  }

  /** Fork-resume a session: forks its last claude session id into a fresh one. */
  restart(id: string): SessionRuntime {
    const def = this.defs.find((d) => d.id === id)
    if (!def) throw new Error(`unknown session ${id}`)
    this.startPty(def, 'resume')
    this.broadcast()
    return this.toRuntime(def)
  }

  write(id: string, data: string): void {
    this.pty.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.pty.resize(id, cols, rows)
  }

  // ----- internals -----

  private startPty(def: SessionDef, mode: SpawnMode): void {
    const cfg = this.getConfig()
    const base = def.command.trim() || this.launchCommand

    let command: string
    if (mode === 'resume' && def.sessionId) {
      // Fork the previous claude session into a fresh id (collision avoidance).
      const prev = def.sessionId
      def.sessionId = randomUUID()
      command = buildSessionCommandLine({
        baseCommand: base,
        sessionId: def.sessionId,
        prevSessionId: prev,
        mode: 'resume'
      })
    } else {
      // Fresh launch (or a session that has never spawned yet).
      if (!def.sessionId) def.sessionId = randomUUID()
      command = buildSessionCommandLine({
        baseCommand: base,
        sessionId: def.sessionId,
        args: def.args,
        mode: 'fresh'
      })
    }

    const r = this.runtime.get(def.id)
    if (r) {
      r.status = 'running'
      r.exitCode = null
    }
    // sessionId may have just changed (fork-resume) -> persist before/after spawn.
    this.persist()
    this.pty.spawn(
      def.id,
      def.cwd,
      { command, shell: cfg.shell, interactive: cfg.interactiveShell },
      this.scopeEnv
    )
  }

  private toRuntime(def: SessionDef): SessionRuntime {
    const r = this.runtime.get(def.id)
    const alive = this.pty.isAlive(def.id)
    return {
      ...def,
      status: alive ? (r?.status === 'starting' ? 'starting' : 'running') : 'exited',
      exitCode: r?.exitCode ?? null,
      pid: this.pty.pid(def.id),
      peerId: r?.peerId ?? null
    }
  }

  private pollPeerIds(): void {
    let changed = false
    for (const def of this.defs) {
      const r = this.runtime.get(def.id)
      if (!r) continue
      const next = this.pty.isAlive(def.id) ? resolvePeerId(def.cwd) : null
      if (next !== r.peerId) {
        r.peerId = next
        changed = true
      }
    }
    if (changed) this.broadcast()
  }

  private defaultName(): string {
    const n = this.defs.length + 1
    return `peer ${n}`
  }

  private persist(): void {
    saveSessions(this.defs)
  }

  private broadcast(): void {
    this.emit('changed', this.list())
  }
}
