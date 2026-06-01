// Locate a Claude Code session transcript and test its existence -- the
// deterministic "expired session" pre-check (DESIGN 6.1/6.6). The --resume exit
// code is unreliable (CC 2.1.158 exits 0 on a missing id), so the app checks the
// transcript file BEFORE spawning instead.
//
// Claude stores transcripts at ~/.claude/projects/<encoded-cwd>/<id>.jsonl, where
// the cwd is encoded by replacing every non-alphanumeric char with a hyphen
// (existing hyphens are preserved). Verified against this repo's own folder:
//   D:\AI\MCPServer\claude-peers-mcp  ->  D--AI-MCPServer-claude-peers-mcp
//
// Pure: node fs/path only, with `home` injected, so it is unit-testable.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Encode a working directory into Claude's ~/.claude/projects folder name. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Absolute path of a session transcript for `cwd` + claude session `id`. */
export function transcriptPath(home: string, cwd: string, id: string): string {
  return join(home, '.claude', 'projects', encodeProjectDir(cwd), `${id}.jsonl`)
}

/** True if the transcript exists (i.e. the session can be resumed). */
export function transcriptExists(home: string, cwd: string, id: string): boolean {
  if (!id) return false
  return existsSync(transcriptPath(home, cwd, id))
}

export interface TranscriptEntry {
  /** Claude session id (the .jsonl basename). */
  id: string
  mtimeMs: number
}

/** List the session transcripts present under `cwd`'s projects folder. */
export function listTranscriptIds(home: string, cwd: string): TranscriptEntry[] {
  const dir = join(home, '.claude', 'projects', encodeProjectDir(cwd))
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: TranscriptEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    try {
      out.push({ id, mtimeMs: statSync(join(dir, name)).mtimeMs })
    } catch {
      // raced unlink -> skip
    }
  }
  return out
}

/**
 * Pick the real session id Claude minted for a just-spawned session: the newest
 * transcript that did NOT exist before the spawn (`before`) and is not already
 * claimed by another live session (`claimed`). Returns null if none yet.
 * Pure -- the testable core of the discovery track (DESIGN 6.2).
 */
export function pickDiscoveredId(
  entries: TranscriptEntry[],
  before: ReadonlySet<string>,
  claimed: ReadonlySet<string>
): string | null {
  const fresh = entries
    .filter((e) => !before.has(e.id) && !claimed.has(e.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return fresh[0]?.id ?? null
}
