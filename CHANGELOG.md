# Changelog

## v0.3.1 -- 2026-05-14

### Added
- Auto-disconnect on Claude Code session end via three mechanisms:
  - SessionEnd hook (`hook-session-end-peers.sh`) POSTs `/disconnect-by-cli-pid`.
  - `server.ts` self-shutdown on stdin EOF.
  - Broker `sweepInactivePeers` safety net (60s timer, 120s stale threshold).
- New env vars: `CLAUDE_PEERS_ACTIVE_STALE_SEC` (default 120), `CLAUDE_PEERS_DORMANT_SWEEP_SEC` (default 60).
- New broker endpoint: `POST /disconnect-by-cli-pid`.
- New DB column: `peers.claude_cli_pid INTEGER`.
- Installer: `bun install-hook.ts` (idempotent, supports `--uninstall`).

### Changed
- Hook script is now bash (.sh), installed under `~/.claude/hooks/session-end-peers.sh`
  for consistency with other Claude Code hooks (kleos pattern). The installer
  (`bun install-hook.ts`) copies it from the repo to the user's hooks directory and
  registers a `bash <path>` command in settings.json.

### Removed
- SSH deployment mode and `client.ts` (use HTTP mode or local-only).
- `CLAUDE_PEERS_REMOTE` env var.
- `tests/server-handshake.test.ts`, `tests/client-config.test.ts`.

### Fixed
- Windows: `server.ts` `BROKER_SCRIPT` path resolution via `fileURLToPath` (local-only mode now works on Windows).
- Cross-host peers no longer flap to `dormant`: `cleanStalePeers` now restricts its `process.kill(pid, 0)` liveness check to peers whose `host` matches the broker's `os.hostname()`. Foreign peers (HTTP mode, client on another machine) are reaped via the heartbeat sweep instead. Previously, all remote peers were flipped dormant on every 30s tick because their Windows/macOS PIDs were probed against the Linux broker's process table.
- New env var `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` (default 30) to tune the `cleanStalePeers` interval.
