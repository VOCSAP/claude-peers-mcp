// Pure builder for the per-session claude command line. No node-pty / electron
// imports so it is unit-testable under bun.
//
// Fork-on-every-resume (DESIGN §6.2 / §11): a new session is launched with its
// own --session-id; resuming forks the previous session into a fresh id so two
// live processes never share a session id. The resume form deliberately omits
// the stored args and never re-passes --agent / --model, which Claude Code
// auto-restores on --fork-session (verified CC 2.1.158, DESIGN §14.3).

export type SpawnMode = 'fresh' | 'resume'

export interface SessionCommandInput {
  /** Base launch command (resolved launchCommand or a per-session override). */
  baseCommand: string
  /** The session id to launch under. For resume this is the NEW (forked) id. */
  sessionId: string
  /** For resume: the previous session id to --resume from. */
  prevSessionId?: string
  /** Extra launch args appended on a fresh launch only (e.g. "--agent foo"). */
  args?: string
  mode: SpawnMode
}

export function buildSessionCommandLine(input: SessionCommandInput): string {
  const base = input.baseCommand.trim()

  if (input.mode === 'resume' && input.prevSessionId) {
    // No args / --agent / --model: Claude auto-restores them on --fork-session.
    return `${base} --resume ${input.prevSessionId} --fork-session --session-id ${input.sessionId}`
  }

  let line = `${base} --session-id ${input.sessionId}`
  const extra = input.args?.trim()
  if (extra) line += ` ${extra}`
  return line
}
