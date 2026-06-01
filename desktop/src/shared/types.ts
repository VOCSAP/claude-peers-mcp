// Types shared across the main, preload and renderer processes.

export type SessionStatus = 'starting' | 'running' | 'exited'

/** Persisted definition of a peer session. PTY scrollback is NOT persisted. */
export interface SessionDef {
  id: string
  name: string
  /** Working directory the peer terminal is launched in. */
  cwd: string
  /** Base command override; empty => the resolved launchCommand (launch-config). */
  command: string
  /** Extra launch args appended after --session-id on a fresh launch. */
  args: string
  /** Current claude --session-id. Changes on every fork-resume. Empty until first spawn. */
  sessionId: string
  createdAt: number
}

/** Live runtime view of a session, sent to the renderer. */
export interface SessionRuntime extends SessionDef {
  status: SessionStatus
  exitCode: number | null
  pid: number | null
  /** Display peer_id resolved from the claude-peers status-line cache, if any. */
  peerId: string | null
  /** Heuristic busy/idle state (placeholder detector, see thinking.ts). */
  thinking: boolean
}

export interface AppConfig {
  /** Default working directory used as the base for new sessions. */
  projectDir: string
  /** Command launched inside each peer terminal (e.g. the `claudepeers` alias). */
  peerCommand: string
  /** Shell used to wrap the command so login/interactive aliases resolve. Empty = auto. */
  shell: string
  /** Load the interactive shell / profile (alias resolution) with start-marker stripping. */
  interactiveShell: boolean
  /** Number of columns in the tile grid. */
  columns: number
  theme: 'dark' | 'light'
  fontSize: number
  /** Re-spawn persisted sessions on launch. */
  restoreSessions: boolean
}

export interface CreateSessionInput {
  name?: string
  cwd?: string
  /** Base command override; empty => the resolved launchCommand. */
  command?: string
  /** Extra launch args (e.g. "--agent reviewer"). */
  args?: string
}

// ----- IPC channel payloads -----

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
}

export interface SessionThinkingEvent {
  id: string
  busy: boolean
}

/** The typed surface exposed on `window.api` by the preload script. */
export interface DeckApi {
  // sessions
  listSessions(): Promise<SessionRuntime[]>
  createSession(input: CreateSessionInput): Promise<SessionRuntime>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  restartSession(id: string): Promise<SessionRuntime>

  // pty io
  ptyInput(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void

  // config
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  pickDirectory(): Promise<string | null>

  // events (return an unsubscribe fn)
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void
  onSessionsChanged(cb: (sessions: SessionRuntime[]) => void): () => void
  onSessionThinking(cb: (e: SessionThinkingEvent) => void): () => void
  onConfigChanged(cb: (config: AppConfig) => void): () => void
}
