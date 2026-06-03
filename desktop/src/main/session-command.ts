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
  /**
   * Reasoning effort level for `--effort`. Re-passed on BOTH fresh and resume
   * (unlike --agent/--model, --effort is not auto-restored by --fork-session).
   * Empty/undefined => omit the flag entirely (Claude's default effort).
   */
  effort?: string
  mode: SpawnMode
}

/** ` --effort <e>` when an effort level is set, otherwise empty. */
function effortFlag(effort?: string): string {
  const e = effort?.trim()
  return e ? ` --effort ${e}` : ''
}

export function buildSessionCommandLine(input: SessionCommandInput): string {
  const base = input.baseCommand.trim()

  if (input.mode === 'resume' && input.prevSessionId) {
    // No args / --agent / --model: Claude auto-restores them on --fork-session.
    // --effort is the exception (not auto-restored) so it is re-passed here.
    return `${base} --resume ${input.prevSessionId} --fork-session --session-id ${input.sessionId}${effortFlag(input.effort)}`
  }

  let line = `${base} --session-id ${input.sessionId}`
  const extra = input.args?.trim()
  if (extra) line += ` ${extra}`
  line += effortFlag(input.effort)
  return line
}
