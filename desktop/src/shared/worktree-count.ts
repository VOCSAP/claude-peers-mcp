// The one place that decides WHICH worktrees the Git rail badge counts and how
// it adds them up. Two surfaces render that number -- the rail as a total, the
// Git view as one counter per line -- and the operator can only trust the badge
// if he can find what it counts, so the two must never own separate arithmetic.
//
// No React, no electron, no @shared alias: importable by a relative path from
// bun test, which is what lets a guard compare the total to the rendered terms
// without re-stating the formula.

import type { WorktreeRow } from './types'

/** Uncommitted changes across EVERY worktree of the project. */
export function sumDirty(rows: readonly WorktreeRow[]): number {
  return rows.reduce((n, w) => n + w.dirty, 0)
}
