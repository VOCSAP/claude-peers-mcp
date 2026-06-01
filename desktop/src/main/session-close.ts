// Graceful close routine for a peer session (DESIGN 6.6).
// Escalation: write "/exit" -> if still alive, Esc + Ctrl+C + retry "/exit" ->
// if still alive, SIGTERM (the peer side is cleaned by server.ts on its end).
//
// Pure: all IO (write to PTY, liveness check, kill, delay) is injected, so the
// escalation logic is unit-testable under bun without a real terminal.

export type CloseOutcome = 'exit' | 'interrupt' | 'sigterm'

export interface GracefulCloseOpts {
  /** Write raw bytes to the session PTY. */
  write: (data: string) => void
  /** Is the session process still alive? */
  isAlive: () => boolean
  /** Last resort: send SIGTERM. */
  kill: () => void
  /** Await a delay (real: setTimeout; tests: a controllable fake). */
  delay: (ms: number) => Promise<void>
  /** Grace after the first "/exit" before escalating. Default 1500ms. */
  exitGraceMs?: number
  /** Grace after Esc/Ctrl+C + retry "/exit" before SIGTERM. Default 1500ms. */
  interruptGraceMs?: number
}

const EXIT = '/exit\n'
const ESC = '\x1b'
const CTRL_C = '\x03'

/**
 * Close a session as gently as possible. Returns how it actually stopped:
 * 'exit' (died after /exit), 'interrupt' (died after Esc/Ctrl+C), or 'sigterm'
 * (only kill() stopped it). Stops early as soon as `isAlive()` reports false.
 */
export async function gracefulClose(opts: GracefulCloseOpts): Promise<CloseOutcome> {
  const exitGraceMs = opts.exitGraceMs ?? 1500
  const interruptGraceMs = opts.interruptGraceMs ?? 1500

  if (!opts.isAlive()) return 'exit'

  // 1. Ask Claude to exit cleanly.
  opts.write(EXIT)
  await opts.delay(exitGraceMs)
  if (!opts.isAlive()) return 'exit'

  // 2. Interrupt any in-progress prompt, then retry the clean exit.
  opts.write(ESC)
  opts.write(CTRL_C)
  opts.write(EXIT)
  await opts.delay(interruptGraceMs)
  if (!opts.isAlive()) return 'interrupt'

  // 3. Last resort.
  opts.kill()
  return 'sigterm'
}
