// The Deck starts the loopback broker itself when no session has: without it
// a Deck opened before any tile cannot read the roadmap (local or replica),
// and a replica cannot replicate or federate. Same contract as server.ts's
// ensureBroker: loopback only, a remote broker is never spawned here.
//
// The broker script is located from GLOBAL configuration only -- the user's
// ~/.claude.json `claude-peers` MCP entry (what every session launches, so the
// Deck spawns the same version), then the repository the Deck itself lives
// in. A project's .mcp.json is never read: a cloned repo must not decide what
// this process executes.

import { resolve } from 'node:path'

export type DeckBrokerModeLike = 'local' | 'remote' | 'replica'

export interface BrokerScriptLocation {
  script: string
  /** The executable the MCP entry names for server.ts, reused for broker.ts. */
  command: string
  source: 'claude-json' | 'app-root'
}

export interface LocateDeps {
  readFile: (path: string) => string | null
  exists: (path: string) => boolean
  /** Trace sink for a claude.json that cannot be parsed (the fallback still runs). */
  warn: (message: string) => void
}

/**
 * The claude-peers entry of the user-scope ~/.claude.json, when it names a
 * server.ts: broker.ts is its sibling. Only `command` and `args` are read, only
 * a string arg ending in server.ts qualifies, and the sibling must exist.
 */
export function locateBrokerScript(
  claudeJsonPath: string,
  appRoot: string,
  deps: LocateDeps
): BrokerScriptLocation | null {
  const raw = deps.readFile(claudeJsonPath)
  if (raw !== null) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      deps.warn(`${claudeJsonPath} is not valid JSON, the claude-peers MCP entry cannot be read: ${e instanceof Error ? e.message : String(e)}`)
      parsed = null
    }
    const entry = mcpEntry(parsed, 'claude-peers')
    if (entry) {
      const serverArg = entry.args.find((a) => /(^|[\\/])server\.ts$/.test(a))
      if (serverArg) {
        // Suffix swap rather than dirname/join: the entry was written on the
        // machine it names, in that platform's separator, which the posix
        // path module of a Linux CI run would not recognise.
        const script = serverArg.slice(0, -'server.ts'.length) + 'broker.ts'
        if (deps.exists(script)) return { script, command: entry.command, source: 'claude-json' }
      }
    }
  }
  const sibling = resolve(appRoot, '..', 'broker.ts')
  if (deps.exists(sibling)) return { script: sibling, command: 'bun', source: 'app-root' }
  return null
}

function mcpEntry(parsed: unknown, name: string): { command: string; args: string[] } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (!servers || typeof servers !== 'object') return null
  const entry = (servers as Record<string, unknown>)[name]
  if (!entry || typeof entry !== 'object') return null
  const command = (entry as { command?: unknown }).command
  const args = (entry as { args?: unknown }).args
  if (typeof command !== 'string' || !command) return null
  if (!Array.isArray(args)) return null
  return { command, args: args.filter((a): a is string => typeof a === 'string') }
}

export type EnsureOutcome =
  | { action: 'skipped'; reason: 'remote-mode' }
  | { action: 'already-running' }
  | { action: 'not-found' }
  | { action: 'started'; script: string; source: BrokerScriptLocation['source'] }
  | { action: 'failed'; script: string; reason: string }

export interface EnsureDeps {
  /** GET <url>/health: true when the broker answers 2xx. */
  isAlive: (url: string) => Promise<boolean>
  locate: () => BrokerScriptLocation | null
  /** Spawn detached, stdio ignored, unref'd; throws when the executable is missing. */
  spawn: (command: string, script: string) => void
  sleep: (ms: number) => Promise<void>
  /** Poll attempts after a spawn, each preceded by one sleep of `pollMs`. */
  attempts?: number
  pollMs?: number
}

/**
 * server.ts's ensureBroker, Deck-side: a remote endpoint is never spawned for
 * (a loopback process would not serve that URL), an answering broker is left
 * alone, otherwise the script is spawned and /health polled for ~6 s.
 */
export async function ensureLoopbackBroker(
  mode: DeckBrokerModeLike,
  url: string,
  deps: EnsureDeps
): Promise<EnsureOutcome> {
  if (mode === 'remote') return { action: 'skipped', reason: 'remote-mode' }
  if (await deps.isAlive(url)) return { action: 'already-running' }
  const located = deps.locate()
  if (!located) return { action: 'not-found' }
  try {
    deps.spawn(located.command, located.script)
  } catch (e) {
    return { action: 'failed', script: located.script, reason: e instanceof Error ? e.message : String(e) }
  }
  const attempts = deps.attempts ?? 30
  const pollMs = deps.pollMs ?? 200
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(pollMs)
    if (await deps.isAlive(url)) return { action: 'started', script: located.script, source: located.source }
  }
  return {
    action: 'failed',
    script: located.script,
    reason: `no /health answer ${(attempts * pollMs) / 1000}s after spawning`
  }
}

/**
 * A down-flip of the health tracker may mean the broker died: one respawn
 * attempt per outage, never more often than `minIntervalMs`, so a broker that
 * refuses to start does not get relaunched on every failing poll.
 */
export class RespawnThrottle {
  private lastAt: number | null = null

  constructor(
    private minIntervalMs: number,
    private now: () => number = Date.now
  ) {}

  /** True when a respawn may be attempted now; records the attempt. */
  allow(): boolean {
    const t = this.now()
    if (this.lastAt !== null && t - this.lastAt < this.minIntervalMs) return false
    this.lastAt = t
    return true
  }
}
