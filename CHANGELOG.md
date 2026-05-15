# Changelog

## v0.3.2 -- 2026-05-15

### Added
- New broker endpoint `POST /list-peers-by-host { host }` -> `{ peers: [{ instance_token, claude_cli_pid }, ...] }`.
  Returns active peers on the given host, used by the SessionEnd hook to
  enumerate candidates for liveness probing.
- New opt-in env var `CLAUDE_PEERS_STATUS_LINE_CACHE` (default off). When set to
  `1`/`true`/`yes`/`on`, `server.ts` writes the active `peer_id` to
  `$HOME/.claude/peers/peer-id-<cwd_key>.txt` after every successful `/register`
  (initial and on group switch). This is the file consumed by status-line
  scripts such as `~/.claude/status-line.sh:get_peer_id`. Off by default because
  the cache is only useful for users who wire a status-line and most users will
  not want `server.ts` to litter `$HOME`.
- New module `shared/peer-cache.ts` exposing `computeCwdKey()`,
  `isPeerIdCacheEnabled()`, and `writePeerIdCache()`. The key derivation matches
  the bash logic exactly: non-alphanumeric (and non-hyphen) chars replaced with
  `_`, last 40 chars kept, with an explicit offset to avoid the MSYS2 bash 5.2
  `${str: -N}` quirk. Best-effort writes (FS failures do not break `/register`).

### Changed
- **Bug E -- Windows-compatible SessionEnd hook.** `hook-session-end-peers.sh`
  no longer correlates by `$PPID`. New flow:
  1. POST `/list-peers-by-host` with `{ host: hostname }` to enumerate active peers.
  2. For each peer, probe `claude_cli_pid` liveness locally:
     - Windows (MINGW/MSYS/CYGWIN, detected via `uname -s`): `tasklist //FI "PID eq <pid>" //NH | grep -qw <pid>`. MSYS2's `kill -0` cannot probe native Win32 PIDs, but `tasklist` can.
     - POSIX (Linux/macOS): `kill -0 <pid>`.
  3. POST `/disconnect` by `instance_token` for every peer whose recorded PID is dead.
  This finally makes the hook functional on Windows, where Claude Code detaches
  the hook so `$PPID = 1` (init) and the v0.3.1 `/disconnect-by-cli-pid` path
  was a silent no-op.

### Removed
- **Broker endpoint `POST /disconnect-by-cli-pid`** and its request/response
  types (`DisconnectByCliPidRequest`, `DisconnectByCliPidResponse`). The hook
  no longer correlates by PID server-side, so the endpoint is dead code.

### Fixed
- **Bug C -- status-line `peer_id` segment empty or stale.** Previously,
  `~/.claude/status-line.sh:get_peer_id` read a cache that only the deleted v0.2
  SSH client (`client.ts`) used to write, so on v0.3+ status-lines either showed
  nothing (fresh cwd) or a stale id from a v0.2 session. Users who set
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1` now get a fresh cache file refreshed on
  every `/register`.

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
