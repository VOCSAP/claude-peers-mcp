// Claude Code SessionStart hook -- keeps the Deck back-channel in sync with the
// REAL current session id across in-process id rotations (notably /clear and
// compaction), which server.ts cannot observe (its CLAUDE_CODE_SESSION_ID env is
// frozen for the process lifetime, and /clear does not re-register the MCP).
//
// Install it as a SessionStart hook (matchers startup|resume|clear|compact) in a
// settings.json that the Deck's claude sessions load. It is gated on
// CLAUDE_PEERS_DESK_SESSION (the per-tile token the Deck injects), so any non-Deck
// claude session runs it as a silent no-op.
//
// On each fire it reads the SessionStart JSON payload on stdin, takes the REAL
// resumable id from `transcript_path` (its .jsonl basename -- the file --resume
// actually reloads) and overwrites ~/.claude/peers/desk-session-<token>.txt. The
// Deck re-reads that file at workspace save (SessionService.refreshLiveSessionIds)
// so the persisted id is the post-/clear one, not the stale pre-/clear id.
//
// Run with bun (already on PATH for Deck sessions, since .mcp.json launches the
// core via bun). Imports resolve relative to THIS file, so the cwd of the claude
// session is irrelevant.

import { sanitizeSessionId, writeDeskSessionFile } from "../../shared/peer-cache.ts";

/** SessionStart payload fields this hook consumes (others ignored). */
export interface SessionStartPayload {
  transcript_path?: string;
  session_id?: string;
}

/**
 * Resolve the resumable session id from a SessionStart payload. Prefers the
 * transcript basename (the exact id `--resume` reloads) over `session_id`, which
 * the docs show can diverge in the interactive PTY + MCP context. Returns "" when
 * neither is usable.
 */
export function deriveSessionId(payload: SessionStartPayload): string {
  const tp = payload.transcript_path?.trim();
  if (tp) {
    // Split on both separators so a Windows "C:\...\id.jsonl" path works under a
    // posix node:path too (the hook runs under bun on every platform).
    const file = tp.split(/[/\\]/).pop() ?? "";
    return file.replace(/\.jsonl$/i, "");
  }
  return (payload.session_id ?? "").trim();
}

/** Read all of stdin as a UTF-8 string (the hook payload). */
async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main(): Promise<void> {
  // Gate: only Deck tiles carry the token. Non-Deck sessions write nothing.
  const token = sanitizeSessionId(process.env.CLAUDE_PEERS_DESK_SESSION);
  if (!token) return;

  let payload: SessionStartPayload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}") as SessionStartPayload;
  } catch {
    return; // malformed payload -> best-effort no-op
  }

  const id = deriveSessionId(payload);
  if (!id) return;
  await writeDeskSessionFile(token, id);
}

// Only run when executed directly (so tests can import deriveSessionId cleanly).
if (import.meta.main) {
  void main().finally(() => process.exit(0));
}
