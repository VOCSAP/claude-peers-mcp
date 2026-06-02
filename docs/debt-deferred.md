# Deferred debt and design choices to revisit

A running log of known limitations, deliberate simplifications, and design
choices that may be reworked later. Each entry: what, why it was deferred, and
the planned direction. Add to this list whenever a "good enough for now" call is
made so nothing is silently lost.

Status legend: `OPEN` (to do) / `WATCHING` (acceptable, revisit if it bites) /
`PLANNED` (scheduled work).

---

## Desktop app (Claude Peers Deck)

### D1. Tile <-> conversation attribution under concurrent same-cwd restore  `WATCHING`
**What:** When several sessions in the **same working directory** are spawned or
restored at nearly the same instant, the app cannot deterministically tell which
new Claude transcript / session id belongs to which tile. Discovery picks the
newest unclaimed id (guarded by `OpenIdRegistry` so each tile gets a *distinct*
real id), so every conversation is preserved, but a tile's name / colour may end
up pointing at a different underlying conversation than intended.
**Why deferred:** Filesystem discovery is inherently ambiguous for simultaneous
same-cwd boots; the operator accepted a best-effort base first.
**Planned direction:** Deterministic back-channel. The app injects a unique
per-tile token in the PTY env (e.g. `CLAUDE_PEERS_DESK_SESSION=<tileId>`); the
claude-peers MCP `server.ts` writes `CLAUDE_CODE_SESSION_ID` to a file keyed by
that token **at register time (session init, before any interaction)**. The app
reads the exact id per tile. Touches core (`server.ts` / `shared/peer-cache.ts`),
additive and gated by the env var.

### D2. `--session-id` is not authoritative for interactive sessions  `WATCHING`
**What:** Claude Code ignores `--session-id` when run interactively in a real PTY
with an MCP loaded and mints its own id; it also writes the transcript / peer
cache only **after real activity**. The app therefore cannot rely on the id it
passes, and a session that is opened but never used leaves no artifact.
**Current handling:** On restore, resume only when a transcript exists, otherwise
start the session fresh (no scary "expired" overlay). Background discovery adopts
the real id when a transcript appears.
**Planned direction:** Same back-channel as D1 captures the real id at init,
making resume reliable even for lightly-used sessions.

### D4. Blocking startup New/Restore modal not implemented  `WATCHING`
**What:** DESIGN 6.6 envisaged a blocking startup picker. The app instead opens
empty with an on-demand "Restore previous session" button + a Workspaces dialog.
**Why deferred:** The on-demand affordance covers the need without reworking the
startup sequence. Revisit if a modal picker is preferred.

### D5. Workspace actions not in the native File menu  `WATCHING`
**What:** Workspace actions (Save / Save As / Restore / Delete) live in the
`WorkspacesDialog`, not a native File menu. (The "New (clear)" action is now
implemented in the File menu -- see Resolved.)
**Why deferred:** The dialog covers these flows; mirroring them in a native
menu is low value. Revisit if menu-driven workspace management is wanted.

### D7. Cross-host workspace lock is best-effort  `WATCHING`
**What:** Same-host lock liveness uses `process.kill(pid,0)` (reliable).
Cross-host relies on heartbeat freshness across two clocks (clock-skew
dependent, DESIGN 15).
**Planned direction:** Delegate cross-host locking to the broker (single
authoritative clock) -- a Phase 2 enhancement.

### D8. Custom-scope secret is not cached (`safeStorage`)  `OPEN`
**What:** A custom (shared) scope's secret must be re-supplied via the launch arg
to rejoin the same group on restore. The optional `safeStorage` "remember on this
machine" convenience (DESIGN 6.8) is not implemented.

### D9. "Thinking" indicator is a placeholder heuristic  `PLANNED` (Phase 2)
**What:** The busy/idle dot uses a fragile PTY-output heuristic that does not
reliably match real Claude Code output (the dot tends to stay green).
**Planned direction:** A hook-based, deterministic signal in Phase 2.

### D10. Discovery timeout leaves a placeholder id for never-written sessions  `WATCHING`
**What:** `discoverRealId` polls ~30s; a session that never writes a transcript
within that window keeps its placeholder id. Harmless (such a session has no
resumable content) but means no background re-capture after the window.
**Planned direction:** Subsumed by the D1/D2 back-channel.

---

## Resolved

### D5 (part). "New (clear)" action  `RESOLVED`
**Was:** No way to close all sessions and return to the empty add-peers state.
**Resolution:** A `File > New (clear)` menu item (CmdOrCtrl+Shift+N) sends
`menu:new-clear` to the renderer, which confirms then invokes `app:new-clear`.
Main runs `WorkspaceService.startNew()` (final auto-save + lock release + detach,
so the prior workspace stays restorable) then `SessionService.closeAll()` (kills
all PTYs, clears the set, broadcasts empty -- the auto-save guard ignores the
empty list so nothing is clobbered). The window keeps its launch group (no
silent scope change). New `confirm.newClear*` i18n keys (en/fr). The remaining
D5 bit (workspace actions in a native File menu) stays `WATCHING`. Spec
`spec_2416bad2`.

### D12. Palette editor in Settings  `RESOLVED`
**Was:** Session colours came from a hardcoded rotating palette with no way to
edit it.
**Resolution:** The palette moved to a pure `src/shared/palette.ts`
(`DEFAULT_PALETTE` + `paletteColor`), is now an `AppConfig.palette` field
(default = `DEFAULT_PALETTE`, read by `session-service`), and Settings gained an
editor (per-colour input + remove, add-colour, reset-to-default). New
`settings.palette*` i18n keys (en/fr). An empty palette safely falls back to the
default. `@shared` alias added to the main/preload vite builds for the value
import. Spec `spec_23842072`.

### D11. Double-click gesture reconciled  `RESOLVED`
**Was:** Double-click meant rename on a sidebar row but fullscreen on a tile.
**Resolution:** Double-click on a sidebar row now toggles maximize (mirrors the
tile head, guarded to ignore clicks on buttons/inputs); rename moved to an
explicit pencil (✎) button in the row. New i18n key `sidebar.renameTitle`
(en/fr) keeps the parity tests green. Spec `spec_23d449df`.

### D6. Auto-save pruning implemented  `RESOLVED`
**Was:** Old unpinned auto-saved workspaces were never pruned (DESIGN 6.7).
**Resolution:** `workspace-store.ts` gained a pure `selectPrunableWorkspaces`
(unpinned + older than `maxAgeMs` + not in `keepIds`); `WorkspaceService.pruneStale`
deletes the selected ids, skipping the current workspace and any workspace whose
sidecar lock is live for another instance. It runs at `start()` and every 6h
(timer cleared in `releaseOnQuit`); `PRUNE_MAX_AGE_MS` is 30 days, aligned with
Claude's session retention. Spec `spec_7bdc3be9`.

### D3. Locales now shipped as packaged resources  `RESOLVED` (M7)
**Was:** `locales/en.json` + `fr.json` were read from the app dir in dev only;
a packaged build silently fell back to the embedded English base for `fr`.
**Resolution (M7):** `electron-builder.yml` now ships `locales/` via
`extraResources` (`from: locales`, `to: locales`). The runtime resolution in
`ipc.ts` `buildI18n` was already packaged-aware
(`app.isPackaged ? process.resourcesPath/locales : appPath/locales`), so no code
change was needed beyond the builder config. Spec `spec_2067c881`.

---

## How to use this file

- When you defer something, add an entry here in the same change, with a stable
  `Dn` id.
- When you implement / resolve one, move it to a `## Resolved` section (with the
  commit) or delete it, and update any cross-references.
