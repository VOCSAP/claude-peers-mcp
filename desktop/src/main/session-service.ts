import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AppConfig,
  CreateSessionInput,
  SessionDef,
  SessionRuntime,
  SessionStatus
} from '@shared/types'
import { PtyManager } from './pty-manager'
import { resolvePeerId } from './peer-state'
import { saveSessions } from './store'
import { buildSessionCommandLine, type SpawnMode } from './session-command'
import { ThinkingDetector, type ThinkingEvent } from './thinking'
import { OpenIdRegistry } from './open-id-registry'
import { listTranscriptIds, pickDiscoveredId, transcriptExists } from './session-transcript'

interface RuntimeState {
  status: SessionStatus
  exitCode: number | null
  peerId: string | null
  thinking: boolean
  /** Restore-time: persisted id had no transcript, so it was not resumed. */
  expired: boolean
}

const PEER_POLL_MS = 4000
/** Discovery: poll cadence + deadline to capture Claude's real (minted) session id. */
const DISCOVERY_POLL_MS = 800
const DISCOVERY_DEADLINE_MS = 30_000

/** Rotating palette for auto-assigned session colours. */
const PALETTE = [
  '#4f86ff',
  '#3ec46d',
  '#e0b341',
  '#e0655b',
  '#a06bff',
  '#26b8c4',
  '#e08a3c',
  '#d45ec4',
  '#6aa84f',
  '#5b8def'
]

function paletteColor(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] as string
}

/**
 * Coordinates the persisted session list, the live PTYs and the resolved
 * peer_id. Emits `data` / `exit` (forwarded to the renderer verbatim) and
 * `changed` (a fresh SessionRuntime[] whenever status/peer_id moves).
 */
export class SessionService extends EventEmitter {
  private defs: SessionDef[]
  private runtime = new Map<string, RuntimeState>()
  private pty = new PtyManager()
  private thinkingDetector = new ThinkingDetector()
  private pollTimer: NodeJS.Timeout | null = null

  /** Live (post-fork) claude session ids open in this process; double-resume guard. */
  private registry = new OpenIdRegistry()

  constructor(
    private getConfig: () => AppConfig,
    /**
     * Forced-group scope env merged into every spawned PTY (see scope.ts).
     * A getter (not a snapshot) so the app can ADOPT a different scope at restore
     * before any session has spawned (DESIGN 6.6).
     */
    private getScopeEnv: () => Record<string, string> = () => ({}),
    /** Resolved base command (launch-config) used when a session has no override. */
    private launchCommand = '',
    /** Home dir for transcript existence checks (injectable for tests). */
    private home: string = homedir()
  ) {
    super()
    // Start empty: the app no longer auto-restores the legacy sessions.json on
    // launch (operator request). The previous run is recovered explicitly via a
    // workspace restore.
    this.defs = []

    this.pty.on('data', (e: { id: string; data: string }) => {
      this.emit('data', e)
      this.thinkingDetector.feed(e.id, e.data)
    })
    this.pty.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
      const r = this.runtime.get(id)
      if (r) {
        r.status = 'exited'
        r.exitCode = exitCode
        r.thinking = false
      }
      // The id is no longer live -> free the double-resume guard (a later restart
      // re-registers the fresh forked id).
      const def = this.defs.find((d) => d.id === id)
      if (def?.sessionId) this.registry.release(def.sessionId)
      this.thinkingDetector.clear(id)
      this.emit('exit', { id, exitCode })
      this.broadcast()
    })

    // Forward busy/idle transitions as `thinking` (ipc -> session:thinking).
    this.thinkingDetector.on('thinking', ({ id, busy }: ThinkingEvent) => {
      const r = this.runtime.get(id)
      if (!r) return
      r.thinking = busy
      this.emit('thinking', { id, busy })
    })
  }

  /** Start the peer_id poll. No auto-restore: the app opens empty (see ctor). */
  start(): void {
    this.pollTimer = setInterval(() => this.pollPeerIds(), PEER_POLL_MS)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.thinkingDetector.stop()
    this.pty.killAll()
  }

  list(): SessionRuntime[] {
    return this.defs.map((d) => this.toRuntime(d))
  }

  /** True if any session PTY is currently alive (scope is locked once true). */
  hasLiveSessions(): boolean {
    return this.defs.some((d) => this.pty.isAlive(d.id))
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
      color: input.color?.trim() || paletteColor(this.defs.length),
      createdAt: Date.now()
    }
    this.defs.push(def)
    this.runtime.set(def.id, {
      status: 'starting',
      exitCode: null,
      peerId: null,
      thinking: false,
      expired: false
    })
    this.spawnSession(def, 'fresh')
    this.broadcast()
    return this.toRuntime(def)
  }

  remove(id: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (def?.sessionId) this.registry.release(def.sessionId)
    this.pty.kill(id)
    this.thinkingDetector.clear(id)
    this.defs = this.defs.filter((d) => d.id !== id)
    this.runtime.delete(id)
    this.persist()
    this.broadcast()
  }

  /** Snapshot the current persisted session defs (for a workspace save). */
  captureSessions(): SessionDef[] {
    return this.defs.map((d) => ({ ...d }))
  }

  /**
   * Replace the session set with a restored one and spawn them in parallel
   * (ids known up front, DESIGN 6.2). Each def is resume-forked unless its
   * transcript is missing (expired -> flagged, not spawned) or its id is already
   * open in this process (double-resume guard).
   */
  restoreFrom(defs: SessionDef[]): SessionRuntime[] {
    // Tear down whatever is currently live.
    this.pty.killAll()
    this.thinkingDetector.stop()
    for (const d of this.defs) {
      if (d.sessionId) this.registry.release(d.sessionId)
    }
    this.runtime.clear()
    this.defs = defs.map((d, i) => ({ ...d, color: d.color || paletteColor(i) }))
    for (const d of this.defs) {
      this.runtime.set(d.id, {
        status: 'exited',
        exitCode: null,
        peerId: null,
        thinking: false,
        expired: false
      })
    }
    this.persist()
    for (const d of this.defs) this.spawnSession(d, 'resume')
    this.broadcast()
    return this.list()
  }

  rename(id: string, name: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def) return
    def.name = name.trim() || def.name
    this.persist()
    this.broadcast()
  }

  setColor(id: string, color: string): void {
    const def = this.defs.find((d) => d.id === id)
    if (!def || !color.trim()) return
    def.color = color.trim()
    this.persist()
    this.broadcast()
  }

  /**
   * Restart a session. A normal session fork-resumes its last id; an EXPIRED one
   * (no transcript) starts fresh with the stored args (the "start new" action of
   * the expired overlay) by clearing its dead id first.
   */
  restart(id: string): SessionRuntime {
    const def = this.defs.find((d) => d.id === id)
    if (!def) throw new Error(`unknown session ${id}`)
    const r = this.runtime.get(id)
    if (r?.expired) {
      def.sessionId = '' // drop the dead lineage -> spawn fresh
      if (r) r.expired = false
      this.spawnSession(def, 'fresh')
    } else {
      this.spawnSession(def, 'resume')
    }
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

  /**
   * Spawn a session's PTY IMMEDIATELY (terminal visible at once), then discover
   * Claude's real (minted) session id in the BACKGROUND -- it ignores our
   * --session-id in an interactive PTY + MCP context (see session-transcript).
   * The spawn is never gated behind another session's discovery, so adding /
   * restoring multiple sessions is instant and parallel. A resume whose stored
   * REAL id has no transcript is flagged expired and not spawned.
   */
  private spawnSession(def: SessionDef, mode: SpawnMode): void {
    const r = this.runtime.get(def.id)
    if (!r) return // removed before we got here

    if (mode === 'resume' && def.sessionId) {
      if (this.registry.has(def.sessionId)) return // same lineage already live
      if (!transcriptExists(this.home, def.cwd, def.sessionId)) {
        // Transcript gone (expired / pruned) -> "start new" overlay, no resume.
        r.status = 'exited'
        r.exitCode = null
        r.expired = true
        this.broadcast()
        return
      }
    }

    const before = new Set(listTranscriptIds(this.home, def.cwd).map((e) => e.id))
    this.startPty(def, mode) // INSTANT
    // Fire-and-forget: discovery must never block terminal visibility.
    void this.discoverRealId(def, before)
  }

  /**
   * Poll the project's transcript dir until the new (Claude-minted) id appears,
   * then adopt it as def.sessionId so the next resume targets the right transcript.
   * Aborts if the PTY dies first or the deadline passes.
   */
  private async discoverRealId(def: SessionDef, before: Set<string>): Promise<void> {
    const placeholder = def.sessionId
    const deadline = Date.now() + DISCOVERY_DEADLINE_MS
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, DISCOVERY_POLL_MS))
      if (!this.pty.isAlive(def.id)) return // died before writing a transcript
      const claimed = this.registry.snapshot()
      claimed.delete(placeholder) // our own placeholder must not block the match
      const realId = pickDiscoveredId(listTranscriptIds(this.home, def.cwd), before, claimed)
      if (realId && realId !== def.sessionId) {
        this.registry.release(placeholder)
        def.sessionId = realId
        this.registry.add(realId)
        this.persist()
        this.broadcast()
        return
      }
    }
  }

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

    // Track the live (post-fork) id for the double-resume guard.
    this.registry.add(def.sessionId)

    const r = this.runtime.get(def.id)
    if (r) {
      r.status = 'running'
      r.exitCode = null
      r.expired = false
    }
    // sessionId may have just changed (fork-resume) -> persist before/after spawn.
    this.persist()
    this.pty.spawn(
      def.id,
      def.cwd,
      { command, shell: cfg.shell, interactive: cfg.interactiveShell },
      this.getScopeEnv()
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
      peerId: r?.peerId ?? null,
      thinking: r?.thinking ?? false,
      expired: r?.expired ?? false
    }
  }

  private pollPeerIds(): void {
    let changed = false
    for (const def of this.defs) {
      const r = this.runtime.get(def.id)
      if (!r) continue
      const next = this.pty.isAlive(def.id) ? resolvePeerId(def.cwd, def.sessionId) : null
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
