# claude-peers (v0.3.1)

Let your Claude Code instances find each other and talk -- across multiple projects on a single PC, or across multiple PCs sharing a common broker on the LAN. When you're running 5 sessions, any Claude can discover the others and send messages that arrive instantly via the `claude/channel` protocol.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  +---------------------------+      +----------------------+
  | Claude A                  |      | Claude B             |
  | "send a message to        |  --> |                      |
  |  peer xyz: what files     |      | <channel> arrives    |
  |  are you editing?"        |  <-- |  instantly, Claude B |
  |                           |      |  responds            |
  +---------------------------+      +----------------------+
```

This fork extends the original [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with:

- **Remote broker over HTTP** (multi-PC LAN/Internet setup, no SSH required).
- **Cross-PC repo matching** via normalized git remote URL (`project_key`).
- **Multi-provider auto-summary** (Anthropic + any OpenAI-compatible endpoint), with deterministic heuristic fallback.
- **Centralized configuration** (env vars + JSON settings file).
- **v0.3** -- isolation by **groups** (TOFU), **resume of identity** across reconnects, **WebSocket push** transport, dual `instance_token` + `peer_id` model.
- **v0.3.1** -- **auto-disconnect** on session end (SessionEnd hook, stdin EOF, sweep timer).

## What v0.3 / v0.3.1 changes

> **Breaking** -- v0.3 introduces a new SQLite schema. There is no migration path: stop the broker, delete `peers.db`, restart. See [Upgrading](#upgrading-from-v02).

- **Groups**: each session lives in a logical group (e.g. `perso`, `work`, `shared`, or the open `default`). Peers in different groups can't see or message each other.
- **Resume**: your `peer_id` is stable across reconnects in the same `(host, cwd, group)`. Quit Claude Code, restart it, you keep the same identity. `set_id` lets you rename it.
- **WebSocket push**: messages land on the recipient instantly via a loopback WebSocket. A 5s fallback poll (peek, no mark-delivered) kicks in only when the WS is down.
- **Dual identity**: `instance_token` (UUID, immutable, internal routing) + `peer_id` (display name, mutable). Renames are now cosmetic and never break in-flight conversations.
- **v0.3.1 -- Auto-disconnect**: peers are marked dormant when Claude Code exits, via SessionEnd hook, stdin EOF detection, and a sweep timer. No more zombie `active` peers after sessions close.

## Two deployment modes

### Mode 1 -- Local broker (single PC)

Broker runs on the same PC as your Claude Code sessions. See [Quick start (local)](#quick-start-local).

### Mode 2 -- Remote broker via HTTP (multi-PC, LAN/Internet)

`server.ts` runs locally on each PC and connects directly to a remote broker over HTTP. No SSH needed. Suited for multi-PC setups and contributors. See [Quick start (HTTP)](#quick-start-http).

---

## Quick start (local)

### 1. Install

```bash
git clone https://github.com/vocsap/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

### 3. Run Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:claude-peers
```

Without `--dangerously-load-development-channels`, peer messages still work but you'll have to call `check_messages` manually.

The broker daemon auto-starts on first launch.

---

## Quick start (HTTP)

### 1. On the broker host -- expose the broker publicly

Add `CLAUDE_PEERS_BIND_HOST=0.0.0.0` (and optionally a bearer token) to the broker service:

```bash
cat >/etc/claude-peers/claude-peers.env <<'EOF'
CLAUDE_PEERS_DB=/var/lib/claude-peers/peers.db
CLAUDE_PEERS_BIND_HOST=0.0.0.0
CLAUDE_PEERS_BROKER_TOKEN=your-shared-secret
EOF
systemctl restart claude-peers-broker
curl http://127.0.0.1:7899/health   # still reachable on loopback too
```

Make sure your firewall allows TCP port 7899 from the outside.

### 2. On each PC client

```bash
git clone https://github.com/vocsap/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

Set `broker_url` and `broker_token` in your settings file (`%APPDATA%\claude-peers\config.json` on Windows, `~/.config/claude-peers/config.json` on Linux/macOS):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "groups": { "mygroup": "group-secret" },
  "default_group": "mygroup"
}
```

Register the MCP server:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Then launch Claude Code:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

### 3. Test it

In one Claude session:

> Run whoami

You'll see your `peer_id`, current group, host, cwd, and `ws_connected: true`. Then:

> List peers

> Send a message to peer [peer_id]: what are you working on?

---

## Running

### Local-only (single PC, broker auto-spawned by server.ts)

`.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["./server.ts"]
    }
  }
}
```

### HTTP (broker daemon on LAN/Internet)

On the broker host (Docker, systemd unit, or directly):

```sh
CLAUDE_PEERS_BIND_HOST=0.0.0.0 CLAUDE_PEERS_BROKER_TOKEN=<secret> bun broker.ts
```

On each Claude Code client, in `~/.config/claude-peers/config.json`
(`%APPDATA%\claude-peers\config.json` on Windows):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "<secret>"
}
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["./server.ts"]
    }
  }
}
```

### Auto-disconnect on session end

Once per PC, install the SessionEnd hook:

```sh
bun install-hook.ts
```

This adds a hook to `~/.claude/settings.json` (or `%USERPROFILE%\.claude\settings.json`)
that fires when the Claude Code session ends and marks the peer dormant on the broker.

---

## Groups

Groups isolate sessions on a shared broker. A group is identified by a 32-hex `group_id` derived from `sha256(group_secret).slice(0, 32)`. The secret never leaves your PC -- the broker only ever sees the hash.

### How a group is resolved (first wins)

1. `.claude-peers.local.json` walking up from cwd to git_root
2. `.claude-peers.json` walking up from cwd to git_root
3. `default_group` from your user config
4. Env var `CLAUDE_PEERS_GROUP`
5. Sentinel `'default'` (open, no auth)

### User config -- where the secrets live

`$XDG_CONFIG_HOME/claude-peers/config.json` on Linux/macOS, `%APPDATA%\claude-peers\config.json` on Windows.

```json
{
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb",
    "shared": "secret-shared-cccc"
  },
  "default_group": "perso"
}
```

### Project config -- which group this repo defaults to

`.claude-peers.json` at the repo root (commit this):

```json
{ "group": "work" }
```

`.claude-peers.local.json` at the repo root (gitignore this) for personal overrides:

```json
{ "group": "perso" }
```

The only allowed field is `group`. Any other key is rejected with a stderr warning.

### TOFU (Trust On First Use)

The first peer to register with a never-seen `group_id` plants the `secret_hash` in the broker. Every subsequent register against the same `group_id` is rejected with HTTP 401 unless its hash matches. You don't pre-create groups; the first connection does it for you.

### Switching groups mid-session

```text
> Use switch_group "work"
```

The current peer is parked as `dormant` (resume-able), and a fresh registration is made in the target group. The WebSocket reconnects to the new identity.

---

## What Claude can do (MCP tools)

| Tool             | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances in your group -- scoped to `machine`, `directory`, or `repo` (cross-PC)      |
| `send_message`   | Send a message to another peer in your group by `peer_id` (push via WebSocket, fallback queues to poll)       |
| `set_summary`    | Describe what you're working on (visible to peers in your group)                                              |
| `check_messages` | Manual poll fallback (rarely needed; messages normally arrive via WS push)                                    |
| `whoami`         | Show your `peer_id`, host, cwd, current group, summary, and `ws_connected` status                             |
| `list_groups`    | Show available groups (from your user config) and how many active peers each has                              |
| `switch_group`   | Move this session to another group by name. Disconnects the current peer (kept dormant) and re-registers      |
| `set_id`         | Rename your `peer_id` within the current group. Refused with 409 on collision (active or dormant)             |

The `repo` scope matches across PCs by normalizing `git remote get-url origin`.

---

## CLI

The CLI talks to the broker over loopback, so run it on the broker host:

```bash
cd /srv/claude-peers

bun cli.ts status                         # broker status, ws clients, all active peers
bun cli.ts peers [--include-dormant]      # list peers across all groups
bun cli.ts groups                         # active peer counts per group_id
bun cli.ts kill-broker                    # stop the broker (Linux/macOS only)
```

`bun cli.ts send` was removed in v0.3: the broker requires a valid `instance_token` for routing, which only registered Claude Code peers hold. Use the MCP `send_message` tool from a Claude session.

For a remote broker, just ssh into the host:

```bash
ssh user@broker-host "cd /srv/claude-peers && bun cli.ts peers"
```

---

## Auto-summary

On startup, each session generates a heuristic summary immediately, then asynchronously asks an LLM provider for a richer 1-2 sentence summary. If the LLM returns a usable response, it replaces the heuristic via `set_summary`.

Three providers are supported. Selection is automatic when `CLAUDE_PEERS_SUMMARY_PROVIDER=auto` (default):

1. If `CLAUDE_PEERS_SUMMARY_BASE_URL` is set -> **openai-compat**.
2. Else if `ANTHROPIC_API_KEY` (or `CLAUDE_PEERS_SUMMARY_API_KEY`) is set -> **anthropic**.
3. Else -> **none** (heuristic only).

### Anthropic direct

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_PEERS_SUMMARY_MODEL=claude-haiku-4-5-20251001   # default, override if needed
```

### OpenAI-compatible (LiteLLM, Ollama, OpenRouter, OpenAI, vLLM)

```bash
CLAUDE_PEERS_SUMMARY_PROVIDER=openai-compat
CLAUDE_PEERS_SUMMARY_BASE_URL=http://litellm-host:4000/v1
CLAUDE_PEERS_SUMMARY_API_KEY=sk-litellm-master-key
CLAUDE_PEERS_SUMMARY_MODEL=ollama_chat/qwen2.5:7b
```

Failure modes (no key, HTTP error, timeout, parse error) silently degrade to the heuristic.

---

## Configuration

Every setting can be provided via an environment variable or via a JSON settings file. Resolution order: **env var > settings file > default**.

### Settings file location

- **Linux/macOS**: `$XDG_CONFIG_HOME/claude-peers/config.json` (default `~/.config/claude-peers/config.json`)
- **Windows**: `%APPDATA%\claude-peers\config.json`

### Reference table

| Env var                              | Settings file key      | Default                              | Side                  | Description                                                            |
| ------------------------------------ | ---------------------- | ------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`                  | `port`                 | `7899`                               | broker / server / cli | Broker HTTP port (loopback)                                            |
| `CLAUDE_PEERS_DB`                    | `db`                   | `/var/lib/claude-peers/peers.db` (Linux/macOS) or `~/.claude-peers.db` (Windows) | broker                | SQLite database path                                                   |
| `CLAUDE_PEERS_GROUP`                 | (n/a)                  | (none)                               | server                | Group name override; env-level fallback before the 'default' sentinel  |
| (n/a)                                | `groups`               | `{}`                                 | server                | Map of group name -> secret. Keep secrets out of the repo.             |
| (n/a)                                | `default_group`        | `null`                               | server                | Group name used when no project file overrides                         |
| `CLAUDE_PEERS_DORMANT_TTL_HOURS`     | (n/a)                  | `24`                                 | broker                | Hours after which dormant peers are purged                             |
| `CLAUDE_PEERS_ACTIVITY_TIMEOUT_SEC`  | (n/a)                  | `1800` (30 min)                      | broker                | Seconds of inactivity before a peer transitions from `active` to `sleep` in `list_peers` |
| `CLAUDE_PEERS_ACTIVE_STALE_SEC`      | (n/a)                  | `120`                                | broker                | Seconds without heartbeat before an active peer is swept to dormant    |
| `CLAUDE_PEERS_DORMANT_SWEEP_SEC`     | (n/a)                  | `60`                                 | broker                | Interval (seconds) between sweep-inactive-peers timer runs             |
| `CLAUDE_PEERS_WS_IDLE_TIMEOUT_SEC`   | (n/a)                  | `600` (10 min)                       | broker                | Seconds of WebSocket silence before the broker closes the connection   |
| `CLAUDE_PEERS_POLL_FALLBACK_SEC`     | (n/a)                  | `5`                                  | server                | Seconds between fallback polls when the WebSocket is down (uses `/peek-messages`, never marks delivered) |
| `CLAUDE_PEERS_SUMMARY_PROVIDER`      | `summary_provider`     | `auto`                               | server                | `auto` / `anthropic` / `openai-compat` / `none`                        |
| `CLAUDE_PEERS_SUMMARY_BASE_URL`      | `summary_base_url`     | (none)                               | server                | Base URL for `openai-compat`                                           |
| `CLAUDE_PEERS_SUMMARY_API_KEY`       | `summary_api_key`      | (none)                               | server                | Bearer token for the summary provider                                  |
| `CLAUDE_PEERS_SUMMARY_MODEL`         | `summary_model`        | `claude-haiku-4-5-20251001`          | server                | Model name passed to the provider                                      |
| `ANTHROPIC_API_KEY`                  | (n/a)                  | (none)                               | server                | Anthropic API key. Used when provider=anthropic if `summary_api_key` is unset. |
| `CLAUDE_PEERS_ANTHROPIC_MODEL`       | `anthropic_model`      | (alias)                              | server                | Backward-compat alias of `summary_model`                               |
| `CLAUDE_PEERS_BROKER_URL`            | `broker_url`           | (none)                               | server                | HTTP mode: direct broker URL (e.g. `http://my-server:7899`). Overrides loopback. |
| `CLAUDE_PEERS_BROKER_TOKEN`          | `broker_token`         | (none)                               | broker + server       | Bearer token for broker auth. Broker requires it on all requests (except `/health`); server sends it on every call. |
| `CLAUDE_PEERS_BIND_HOST`             | `bind_host`            | `127.0.0.1`                          | broker                | Broker bind address. Set `0.0.0.0` to accept external connections.     |

### Example settings file (with groups)

Local mode (groups only):

```json
{
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb",
    "shared": "secret-shared-cccc"
  },
  "default_group": "perso",
  "summary_provider": "auto",
  "summary_model": "claude-haiku-4-5-20251001"
}
```

HTTP mode (remote broker):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb"
  },
  "default_group": "perso",
  "summary_provider": "auto",
  "summary_model": "claude-haiku-4-5-20251001"
}
```

---

## Troubleshooting

### `whoami` shows `ws_connected: false`

The fallback poll runs every 5s while the WebSocket is disconnected. It peeks at undelivered messages (without marking them delivered) and pushes them via `mcp.notification()`. Messages still arrive -- just with up to 5s latency instead of instant push. Common causes:

- Broker is not running. `curl http://127.0.0.1:7899/health`.
- The broker version is older than v0.3 -- the `/ws` endpoint didn't exist. Update the broker host.
- Bun's WebSocket client throws on the first connect; the backoff is 1s -> 2s -> ... -> 30s. Check `stderr` for `WebSocket closed; will retry`.

### `Group 'X' not in user config`

Either `.claude-peers.json` references a group name that's missing from the user config, or you used `switch_group` with an unknown name. Add the group + its secret in `~/.config/claude-peers/config.json` and restart the session.

### Two PCs see each other in `default` but not in their custom group

The `group_id` is derived from `sha256(secret).slice(0, 32)`. If the two PCs use different secret strings under the same group name, they end up in different `group_id`s. Either share the same secret across PCs, or check that the user config on both sides lists the same string (whitespace and case matter).

### "session_key collision" warning in broker logs

Two `bun server.ts` processes registered with the same `(host, cwd, group_id)` while both alive. The first kept the resume identity, the second got a fresh `peer_id` like `myhost-foo-2`. This usually means you launched two Claude Code sessions in the same directory simultaneously -- expected behavior.

---

## Architecture

**Mode 1 -- Local** (single PC):

```
Claude Code --stdio--> server.ts --loopback--> broker.ts + peers.db
                       (auto-spawns broker)
```

**Mode 2 -- HTTP** (multi-PC, LAN/Internet):

```
Local PC                                      Broker host
+------------------------------+              +----------------------------+
| Claude Code                  |              |                            |
|     v stdio (MCP)            |  HTTP + WS   |                            |
| server.ts --(resolve group, <-------------> broker.ts (0.0.0.0:7899)    |
|   send Bearer token)         |              |     v                      |
+------------------------------+              | /var/lib/claude-peers/     |
                                              |   peers.db                 |
                                              +----------------------------+
```

In HTTP mode, `server.ts` runs locally and connects directly to `CLAUDE_PEERS_BROKER_URL`. No SSH is involved.

In local mode, `server.ts` auto-spawns a broker on loopback and resolves the group from the user config.

---

## Flags reference (Claude Code CLI)

| Flag                                                          | Purpose                                                                                                                  | Required?   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `--dangerously-load-development-channels server:claude-peers` | Enables `claude/channel` push for the claude-peers MCP server. Without it, peers must call `check_messages` manually.    | Recommended |
| `--dangerously-skip-permissions`                              | Skips the per-tool approval prompt. Useful so that incoming peer messages don't require a click to respond.              | Optional    |

---

## Requirements

- [Bun](https://bun.sh) on every host involved (broker + clients).
- Claude Code v2.1.80+ on every PC client.
- claude.ai login (channels require it).
- For HTTP mode: network access from each client to the broker host on port 7899.

---

## Upgrading from v0.2

There is no migration. The v0.3 schema differs in incompatible ways (new `groups` and `peer_sessions` tables, `instance_token` PK, `from_token`/`to_token` on messages, `peer_id` decoupled from routing).

```bash
systemctl stop claude-peers-broker
rm /var/lib/claude-peers/peers.db
git pull
systemctl start claude-peers-broker
curl http://127.0.0.1:7899/health
```

Existing in-flight messages are dropped along with the DB. Sessions transparently re-register on first use.

## Migration from upstream (OpenAI -> Anthropic)

Coming from `louislva/claude-peers-mcp`?

- The auto-summary now uses **Anthropic** (`claude-haiku-4-5-20251001`) by default, with an OpenAI-compatible alternative for LiteLLM/Ollama/etc. Replace `OPENAI_API_KEY` with `ANTHROPIC_API_KEY` in your env, or set the openai-compat variables.
- v0.3 adds the groups + resume + WebSocket layer described above.
- v0.3.1 removes the SSH deployment mode. Use local-only or HTTP mode instead.
