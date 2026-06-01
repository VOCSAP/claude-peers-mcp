// Types shared across the main, preload and renderer processes.

export type SessionStatus = 'starting' | 'running' | 'exited'

/** Tile layout mode. '1x1' is a horizontal carousel; the rest are cols x rows grids. */
export type DisplayMode = '1x1' | '1x2' | '2x2' | 'custom'

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
  /** Display colour (hex) framing the tile + sidebar swatch. Auto-assigned, overridable. */
  color: string
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
  /**
   * Restore-time flag: the persisted claude session id has no transcript on disk
   * (expired / pruned), so it was not resumed. The tile shows a "start new"
   * overlay instead of a dead terminal. Always false for live/fresh sessions.
   */
  expired: boolean
}

/** Lightweight workspace row for the restore picker (no sessions payload). */
export interface WorkspaceSummary {
  id: string
  name: string
  pinned: boolean
  scopeName: string
  sessionCount: number
  updatedAt: number
  /** True if another live owner currently holds this workspace's lock. */
  locked: boolean
  /** True if this is the workspace the running app currently owns. */
  current: boolean
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
  /** Number of columns in the tile grid (legacy; custom mode uses gridCols/gridRows). */
  columns: number
  /** Tile layout mode. */
  displayMode: DisplayMode
  /** Columns for the custom display mode (>= 1). */
  gridCols: number
  /** Rows for the custom display mode (>= 1). */
  gridRows: number
  /** Sidebar width in px (resizable, persisted). */
  sidebarWidth: number
  theme: 'dark' | 'light'
  fontSize: number
  /** Re-spawn persisted sessions on launch. */
  restoreSessions: boolean
  /** UI language: '' = auto (OS), 'en' or 'fr'. Resolved by main/i18n.ts. */
  locale: string
}

/** Active locale + flattened translation dict, sent to the renderer. */
export interface I18nPayload {
  locale: string
  dict: Record<string, string>
}

/**
 * Launch config shapes for the IPC contract. Structurally identical to the ones
 * in main/launch-config.ts (kept separate so that module stays import-free for
 * its bun unit tests). Keep the two in sync.
 */
export interface LaunchPreset {
  label: string
  args: string
  prompt?: string
}

export interface LaunchConfig {
  launchCommand: string
  presets: LaunchPreset[]
}

export interface CreateSessionInput {
  name?: string
  cwd?: string
  /** Base command override; empty => the resolved launchCommand. */
  command?: string
  /** Extra launch args (e.g. "--agent reviewer"). */
  args?: string
  /** Optional explicit colour (hex); falls back to the rotating palette. */
  color?: string
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
  setSessionColor(id: string, color: string): Promise<void>
  restartSession(id: string): Promise<SessionRuntime>

  // pty io
  ptyInput(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void

  // config
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  pickDirectory(): Promise<string | null>

  // i18n
  getI18n(): Promise<I18nPayload>

  // workspaces (persistence / restore)
  listWorkspaces(): Promise<WorkspaceSummary[]>
  saveWorkspace(name?: string): Promise<WorkspaceSummary>
  restoreWorkspace(id: string): Promise<void>
  deleteWorkspace(id: string): Promise<void>
  currentWorkspace(): Promise<string | null>

  // create-menu data
  listAgents(): Promise<string[]>
  getLaunchConfig(): Promise<LaunchConfig>
  saveLaunchConfig(cfg: LaunchConfig): Promise<void>

  // events (return an unsubscribe fn)
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void
  onSessionsChanged(cb: (sessions: SessionRuntime[]) => void): () => void
  onSessionThinking(cb: (e: SessionThinkingEvent) => void): () => void
  onConfigChanged(cb: (config: AppConfig) => void): () => void
}
