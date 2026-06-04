// One-time consolidation onto a single "claude-peers-desk" app-data root.
//
// History: Electron's userData lived in "claude-peers-deck" (the npm package
// name) while the launch config + templates lived in "claude-peers-desk" (see
// launch-config.ts) -- two near-identical folders that looked like a typo of one
// another. Harmonizing userData onto "claude-peers-desk" makes it share the
// launch-config folder on Windows/Linux, so the app's OWN state moves under a
// `config/` subfolder to avoid colliding with the launch `config.json` that
// sits at the root.
//
// This migration copies the app state the old deck folder still holds
// (config.json + sessions.json) into <userData>/config, never overwriting an
// existing file. Best-effort and idempotent: any error is swallowed so a failed
// migration can never stop the app from launching with defaults. Scope secrets
// are intentionally NOT migrated -- a custom group secret is cheap to re-supply
// and its on-disk name is owned by scope-secrets.
//
// Pure node builtins only (no electron) so it stays unit-testable under bun,
// like launch-config.ts and template-store.ts.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** App-state files worth carrying over from the legacy userData folder. */
const MIGRATE_FILES = ['config.json', 'sessions.json'] as const

/**
 * Subfolder under userData where the app keeps its own state, kept separate
 * from the launch `config.json` that lives at the userData root. Single source
 * of truth shared by store.ts (writer) and the migration below.
 */
export const APP_STATE_SUBDIR = 'config'

/**
 * Copy legacy "claude-peers-deck" userData files into <userDataDir>/config.
 * No-op when the legacy folder is absent or when a destination file already
 * exists (idempotent).
 */
export function migrateUserDataDir(userDataDir: string): void {
  try {
    const deckDir = join(dirname(userDataDir), 'claude-peers-deck')
    if (deckDir === userDataDir || !existsSync(deckDir)) return
    const destDir = join(userDataDir, APP_STATE_SUBDIR)
    for (const name of MIGRATE_FILES) {
      const from = join(deckDir, name)
      const to = join(destDir, name)
      if (!existsSync(from) || existsSync(to)) continue
      try {
        mkdirSync(destDir, { recursive: true })
        copyFileSync(from, to)
      } catch {
        // Skip a single unreadable/unwritable entry.
      }
    }
  } catch {
    // Migration must never break startup.
  }
}

/** Run the full app-data consolidation. */
export function runDataMigration(opts: { userDataDir: string }): void {
  migrateUserDataDir(opts.userDataDir)
}
