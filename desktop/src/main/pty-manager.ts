import { EventEmitter } from 'node:events'
import { platform } from 'node:os'
import * as pty from 'node-pty'
import type { AppConfig } from '@shared/types'

export interface PtyDataPayload {
  id: string
  data: string
}
export interface PtyExitPayload {
  id: string
  exitCode: number
}

interface Spawned {
  proc: pty.IPty
  cols: number
  rows: number
}

/**
 * Build the (file, args) used to launch the peer command inside a real PTY.
 *
 * The command (e.g. the `claudepeers` alias) only resolves when run through the
 * user's shell with its rc loaded, so we wrap it:
 *   - Unix:    <shell> -l -i -c "<command>"   (login + interactive => aliases load)
 *   - Windows: powershell -NoLogo -Command "<command>"   (profile loads the alias)
 *
 * `config.shell` overrides the default shell when set.
 */
function buildSpawn(config: AppConfig): { file: string; args: string[] } {
  const command = config.peerCommand.trim() || 'claudepeers'
  if (platform() === 'win32') {
    const file = config.shell || 'powershell.exe'
    return { file, args: ['-NoLogo', '-Command', command] }
  }
  const shell = config.shell || process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l', '-i', '-c', command] }
}

/** Owns every live PTY. One instance for the whole app. */
export class PtyManager extends EventEmitter {
  private procs = new Map<string, Spawned>()

  /** Spawn a peer terminal for `id`. Replaces any existing PTY for that id. */
  spawn(id: string, cwd: string, config: AppConfig): number {
    this.kill(id)
    const { file, args } = buildSpawn(config)

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        // Populate the status-line peer_id cache so the Deck can show peer_id.
        CLAUDE_PEERS_STATUS_LINE_CACHE: '1',
        TERM: 'xterm-256color'
      }
    })

    this.procs.set(id, { proc, cols: 80, rows: 24 })

    proc.onData((data) => this.emit('data', { id, data } satisfies PtyDataPayload))
    proc.onExit(({ exitCode }) => {
      this.procs.delete(id)
      this.emit('exit', { id, exitCode } satisfies PtyExitPayload)
    })

    return proc.pid
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.procs.get(id)
    if (!s || cols < 1 || rows < 1) return
    s.cols = cols
    s.rows = rows
    try {
      s.proc.resize(cols, rows)
    } catch {
      // PTY may have just exited; ignore.
    }
  }

  isAlive(id: string): boolean {
    return this.procs.has(id)
  }

  pid(id: string): number | null {
    return this.procs.get(id)?.proc.pid ?? null
  }

  kill(id: string): void {
    const s = this.procs.get(id)
    if (!s) return
    this.procs.delete(id)
    try {
      s.proc.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}
