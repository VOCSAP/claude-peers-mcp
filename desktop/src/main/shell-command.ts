// Pure shell-invocation builder, kept free of node-pty so it is unit-testable
// under bun without the native addon. pty-manager.ts consumes buildShellInvocation.
//
// Default = a *login, non-interactive* shell (Unix `-l -c`, Windows
// `-NoProfile`). The login shell sets PATH; we deliberately avoid the
// interactive shell (`-i` / a loaded profile) because rc files (oh-my-zsh, NVM,
// conda, pyenv, PowerShell profile banners) spew noise into the PTY (DESIGN §7).
//
// Interactive mode is opt-in for users whose launch command is a shell alias
// that only resolves with rc loaded. To hide the rc noise we prepend a unique
// *start marker* and PtyManager strips everything up to and including it.

import { randomBytes } from 'node:crypto'
import { platform } from 'node:os'

export interface SpawnOpts {
  /** Full command line to run (already includes --session-id etc.). */
  command: string
  /** Shell override; empty => OS default ($SHELL / bash on Unix, powershell on Windows). */
  shell: string
  /** Load the interactive shell / profile (alias resolution) with marker stripping. */
  interactive: boolean
}

export interface ShellInvocation {
  file: string
  args: string[]
  /** Start marker to strip from PTY output, or null when not interactive. */
  marker: string | null
}

function makeMarker(): string {
  return `__CLAUDE_PEERS_START_${randomBytes(6).toString('hex')}__`
}

export function buildShellInvocation(
  opts: SpawnOpts,
  plat: NodeJS.Platform = platform()
): ShellInvocation {
  const marker = opts.interactive ? makeMarker() : null

  if (plat === 'win32') {
    const file = opts.shell || 'powershell.exe'
    const command = marker ? `Write-Output '${marker}'; ${opts.command}` : opts.command
    // PowerShell has no `-i`; the profile loads by default. -NoProfile is the
    // non-interactive (clean) path; interactive lets the profile (aliases) load.
    const args = opts.interactive
      ? ['-NoLogo', '-Command', command]
      : ['-NoLogo', '-NoProfile', '-Command', command]
    return { file, args, marker }
  }

  const shell = opts.shell || process.env.SHELL || '/bin/bash'
  const command = marker ? `echo '${marker}'; ${opts.command}` : opts.command
  const args = opts.interactive ? ['-l', '-i', '-c', command] : ['-l', '-c', command]
  return { file: shell, args, marker }
}
