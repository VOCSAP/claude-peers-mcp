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

### D3. Locales not copied as packaged resources yet  `PLANNED` (M7)
**What:** `locales/en.json` + `fr.json` are read from the app dir in dev. In a
packaged build they must be shipped via electron-builder `extraResources`;
until then a packaged app silently falls back to the embedded English base for
`fr`.
**Planned direction:** Add `extraResources` for `locales/` in M7 packaging.

### D4. Blocking startup New/Restore modal not implemented  `WATCHING`
**What:** DESIGN 6.6 envisaged a blocking startup picker. The app instead opens
empty with an on-demand "Restore previous session" button + a Workspaces dialog.
**Why deferred:** The on-demand affordance covers the need without reworking the
startup sequence. Revisit if a modal picker is preferred.

### D5. Native menubar File menu + "New (clear)" deferred  `WATCHING`
**What:** Workspace actions (Save / Save As / Restore / Delete) live in the
`WorkspacesDialog`, not a native File menu. There is no "New (clear)" action
(close all + fresh scope) yet.
**Why deferred:** Avoided extra IPC + menu wiring; the dialog covers the core
flows. "New (clear)" needs a graceful-close-all + scope-reset path.

### D6. Auto-save pruning not implemented  `OPEN`
**What:** Old unpinned auto-saved workspaces are never pruned (DESIGN 6.7
suggested pruning closed unpinned auto-saves older than N days, aligned with
Claude's 30-day retention).
**Planned direction:** A periodic prune in `WorkspaceService`.

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

### D11. Double-click on a sidebar row: rename vs fullscreen  `OPEN` (minor)
**What:** Double-click semantics on a sidebar session row (rename) can conflict
with the tile double-click (fullscreen). Reconcile the gesture.

### D12. No palette editor in Settings  `OPEN` (minor)
**What:** Session colours come from a fixed rotating palette; there is no UI to
edit the palette.

---

## How to use this file

- When you defer something, add an entry here in the same change, with a stable
  `Dn` id.
- When you implement / resolve one, move it to a `## Resolved` section (with the
  commit) or delete it, and update any cross-references.
