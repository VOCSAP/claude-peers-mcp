# claude-peers

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

- **Remote broker over SSH stdio** (multi-PC LAN setup).
- **Cross-PC repo matching** via normalized git remote URL (`project_key`).
- **Anthropic-powered auto-summary** (replaces OpenAI), with a deterministic heuristic fallback.
- **Centralized configuration** (env vars + settings file), no source edits required to deploy.

## Two deployment modes

### Mode 1 -- Local broker (single PC)

Broker runs on the same PC as your Claude Code sessions. Same as the upstream project. See [Quick start (local)](#quick-start-local).

### Mode 2 -- Remote broker (multi-PC, LAN)

Broker runs on a dedicated host (e.g. a LXC, VM, or always-on Linux box). Each PC runs a thin `client.ts` that ssh's into the broker host and forwards stdio. Sessions on different PCs see each other and can collaborate. See [Quick start (remote)](#quick-start-remote).

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

The `--dangerously-load-development-channels` flag enables the `claude/channel` push notifications. Without it, peer messages still work but you have to call `check_messages` manually instead of receiving them automatically.

You may also pass `--dangerously-skip-permissions` to suppress the per-tool approval prompt (optional, useful when peer messages arrive mid-task).

The broker daemon auto-starts on first launch.

---

## Quick start (remote)

### 1. On the broker host (e.g. a Debian LXC)

```bash
# Install bun if missing
curl -fsSL https://bun.sh/install | bash

# Clone the project
git clone https://github.com/vocsap/claude-peers-mcp.git /srv/claude-peers
cd /srv/claude-peers
bun install

# Prepare DB directory
mkdir -p /var/lib/claude-peers

# Create env file (Anthropic key for auto-summary -- optional)
mkdir -p /etc/claude-peers
cat >/etc/claude-peers/claude-peers.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_PEERS_DB=/var/lib/claude-peers/peers.db
EOF
chmod 600 /etc/claude-peers/claude-peers.env

# Install systemd unit for the broker
cat >/etc/systemd/system/claude-peers-broker.service <<'EOF'
[Unit]
Description=claude-peers broker daemon
After=network.target

[Service]
Type=simple
User=root
EnvironmentFile=/etc/claude-peers/claude-peers.env
ExecStart=/root/.bun/bin/bun /srv/claude-peers/broker.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now claude-peers-broker.service
systemctl status claude-peers-broker
curl http://127.0.0.1:7899/health
```

Adjust `/root/.bun/bin/bun` to wherever bun is installed (`which bun`).

### 2. On each PC client

```bash
# Clone the project
git clone https://github.com/vocsap/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

Make sure your SSH key is authorized on the broker host so that `ssh user@broker-host bun --version` works without a password.

Configure the remote in env (recommended) or in a settings file (see [Configuration](#configuration)):

```bash
export CLAUDE_PEERS_REMOTE=user@broker-host
```

Register the MCP server -- pointing at `client.ts` (not `server.ts`):

```bash
claude mcp add --scope user --transport stdio claude-peers \
  --env CLAUDE_PEERS_REMOTE=user@broker-host \
  -- bun ~/claude-peers-mcp/client.ts
```

Or in `.mcp.json`:

```json
{
  "claude-peers": {
    "command": "bun",
    "args": ["~/claude-peers-mcp/client.ts"],
    "env": {
      "CLAUDE_PEERS_REMOTE": "user@broker-host"
    }
  }
}
```

Then launch Claude Code:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

### 3. Test it

In one Claude session, ask:

> List all peers

You'll see your own session plus any other Claude Code instance connected to the same broker, with their host name, working directory, git project, and current summary. Then:

> Send a message to peer [id]: what are you working on?

---

## Architecture

```
                Local PC                                       Broker host (LAN)
+------------------------------------+              +---------------------------------+
| Claude Code                        |              |                                 |
|     |                              |              |                                 |
|     v stdio (MCP)                  |              |                                 |
| client.ts  --(detect local ctx)--->|              |                                 |
|     |                              |   ssh stdio  |  bun /srv/claude-peers/server.ts|
|     | spawn ssh, send handshake   <-------------->|     |                           |
|     |                              |  (handshake  |     v HTTP 127.0.0.1:7899       |
|     | forward stdio (transparent)  |   on stdin)  |  bun /srv/claude-peers/broker.ts|
+------------------------------------+              |     |                           |
                                                    |     v                           |
                                                    |  /var/lib/claude-peers/peers.db |
                                                    +---------------------------------+
```

The first line on stdin from `client.ts` is a JSON handshake carrying the client's local context (cwd, git_root, branch, recent files, hostname, pid, project_key). The rest of stdin is forwarded transparently. `server.ts` registers with the broker using these client-provided values.

In **local mode** (running `bun server.ts` directly without a client), the server detects context locally and behaves like the upstream project.

---

## What Claude can do

| Tool             | What it does                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances -- scoped to `machine`, `directory`, or `repo` (cross-PC)     |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)                  |
| `set_summary`    | Describe what you're working on (visible to other peers)                                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)                               |

The `repo` scope matches across PCs by normalizing `git remote get-url origin` (e.g. `git@github.com:vocsap/claude-peers-mcp.git` and `https://github.com/vocsap/claude-peers-mcp.git` both resolve to `github.com/vocsap/claude-peers-mcp`).

---

## Auto-summary

On startup, each session generates a heuristic summary immediately (no network) using its git context, then asynchronously asks an LLM provider for a richer 1-2 sentence summary. If the LLM returns a usable response, it replaces the heuristic summary via `set_summary`.

Three providers are supported. Selection is automatic when `CLAUDE_PEERS_SUMMARY_PROVIDER=auto` (default):

1. If `CLAUDE_PEERS_SUMMARY_BASE_URL` is set -> **openai-compat**.
2. Else if `ANTHROPIC_API_KEY` (or `CLAUDE_PEERS_SUMMARY_API_KEY`) is set -> **anthropic**.
3. Else -> **none** (heuristic only). The heuristic alone is always non-empty and usable.

### Anthropic direct

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_PEERS_SUMMARY_MODEL=claude-haiku-4-5-20251001   # default, override if needed
```

### OpenAI-compatible (LiteLLM proxy, OpenRouter, OpenAI, vLLM, etc.)

```bash
CLAUDE_PEERS_SUMMARY_PROVIDER=openai-compat
CLAUDE_PEERS_SUMMARY_BASE_URL=http://litellm-host:4000/v1
CLAUDE_PEERS_SUMMARY_API_KEY=sk-litellm-master-key
CLAUDE_PEERS_SUMMARY_MODEL=ollama_chat/qwen2.5:7b
```

LiteLLM is the recommended way to combine local models (Ollama) and frontier models behind one endpoint, with retry/budget/observability features.

### Ollama direct (no LiteLLM)

Ollama exposes an OpenAI-compatible endpoint at `/v1`:

```bash
CLAUDE_PEERS_SUMMARY_PROVIDER=openai-compat
CLAUDE_PEERS_SUMMARY_BASE_URL=http://ollama-host:11434/v1
CLAUDE_PEERS_SUMMARY_MODEL=qwen2.5:7b
# No API key needed (Ollama doesn't authenticate by default)
```

### Heuristic only

Set nothing, or `CLAUDE_PEERS_SUMMARY_PROVIDER=none`. Each peer will register with a deterministic non-empty summary derived from `git_root` basename + branch + recent files.

Failure modes (no key, HTTP error, timeout, parse error) silently degrade to the heuristic. The summary endpoint is best-effort.

---

## CLI

The CLI talks to the broker over loopback, so run it on the broker host:

```bash
cd /srv/claude-peers

bun cli.ts status              # broker status + all peers
bun cli.ts peers               # list peers
bun cli.ts send <id> <msg>     # send a message into a Claude session
bun cli.ts kill-broker         # stop the broker (Linux/macOS only)
```

For a remote broker, just ssh into the host:

```bash
ssh user@broker-host "cd /srv/claude-peers && bun cli.ts peers"
```

---

## Configuration

Every setting can be provided via an environment variable or via a JSON settings file. Resolution order is **env var > settings file > default**. The settings file is optional; if absent the defaults apply.

### Settings file location

- **Linux/macOS**: `$XDG_CONFIG_HOME/claude-peers/config.json` (default `~/.config/claude-peers/config.json`)
- **Windows**: `%APPDATA%\claude-peers\config.json`

### Reference table

| Env var                           | Settings file key      | Default                              | Side                  | Description                                                            |
| --------------------------------- | ---------------------- | ------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`               | `port`                 | `7899`                               | broker / server / cli | Broker HTTP port (loopback)                                            |
| `CLAUDE_PEERS_DB`                 | `db`                   | `/var/lib/claude-peers/peers.db` (Linux/macOS) or `~/.claude-peers.db` (Windows) | broker                | SQLite database path                                                   |
| `CLAUDE_PEERS_REMOTE`             | `remote`               | (none, required for client mode)     | client                | SSH target `user@host[:port]`                                          |
| `CLAUDE_PEERS_SSH_OPTS`           | `ssh_opts`             | (empty)                              | client                | Extra ssh args (env: comma-separated, file: JSON array)                |
| `CLAUDE_PEERS_REMOTE_SERVER_PATH` | `remote_server_path`   | `/srv/claude-peers/server.ts`        | client                | Path to `server.ts` on the broker host                                 |
| `CLAUDE_PEERS_SUMMARY_PROVIDER`   | `summary_provider`     | `auto`                               | server                | `auto` / `anthropic` / `openai-compat` / `none`                        |
| `CLAUDE_PEERS_SUMMARY_BASE_URL`   | `summary_base_url`     | (none)                               | server                | Base URL for `openai-compat` (e.g. `http://host:4000/v1` for LiteLLM)  |
| `CLAUDE_PEERS_SUMMARY_API_KEY`    | `summary_api_key`      | (none)                               | server                | Bearer token for the summary provider                                  |
| `CLAUDE_PEERS_SUMMARY_MODEL`      | `summary_model`        | `claude-haiku-4-5-20251001`          | server                | Model name passed to the provider                                      |
| `ANTHROPIC_API_KEY`               | (n/a)                  | (none)                               | server                | Anthropic API key. Used when provider=anthropic if `summary_api_key` is unset. |
| `CLAUDE_PEERS_ANTHROPIC_MODEL`    | `anthropic_model`      | (alias)                              | server                | Backward-compat alias of `summary_model` / `CLAUDE_PEERS_SUMMARY_MODEL` |

Notes:
- "Side" indicates which entrypoint reads the value. `broker` runs on the broker host, `client` on each PC client, `server` is spawned per session on the broker host (or locally in single-host mode), `cli` is the management CLI.
- All settings file keys are optional. Unspecified keys fall back to the env var, then to the default.
- `ssh_opts` accepts a JSON array in the settings file (`["-o", "ServerAliveInterval=30"]`) and a comma-separated string in the env var (`-o,ServerAliveInterval=30`).

### Example settings file

```json
{
  "port": 7899,
  "db": "/var/lib/claude-peers/peers.db",
  "remote": "user@broker-host",
  "remote_server_path": "/srv/claude-peers/server.ts",
  "ssh_opts": ["-o", "ServerAliveInterval=30"],
  "summary_provider": "auto",
  "summary_base_url": "http://litellm-host:4000/v1",
  "summary_api_key": "sk-litellm-master-key",
  "summary_model": "claude-haiku-4-5-20251001"
}
```

### SSH multiplexing (recommended for remote mode)

Adding the following to `~/.ssh/config` on each client cuts session startup latency to near zero after the first connection:

```
Host broker-host
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

---

## Flags reference (Claude Code CLI)

| Flag                                          | Purpose                                                                  | Required? |
| --------------------------------------------- | ------------------------------------------------------------------------ | --------- |
| `--dangerously-load-development-channels server:claude-peers` | Enables `claude/channel` push for the claude-peers MCP server. Without it, peers must call `check_messages` manually. | Recommended |
| `--dangerously-skip-permissions`              | Skips the per-tool approval prompt. Useful so that incoming peer messages don't require a click to respond. | Optional |

Neither flag changes the source code -- only how Claude Code launches.

---

## Requirements

- [Bun](https://bun.sh) on every host involved (broker + clients).
- Claude Code v2.1.80+ on every PC client.
- claude.ai login (channels require it -- API key auth won't work for Claude Code itself).
- For multi-PC mode: SSH access (key-based) from each client to the broker host.

---

## Migration from upstream (OpenAI -> Anthropic)

If you're coming from the original `louislva/claude-peers-mcp`:

- The auto-summary now uses **Anthropic** (`claude-haiku-4-5-20251001`) instead of OpenAI's `gpt-5.4-nano`. Replace `OPENAI_API_KEY` with `ANTHROPIC_API_KEY` in your env.
- The peer table gained three columns: `host`, `client_pid`, `project_key`. The migration is automatic on broker startup (idempotent `ALTER TABLE`).
- A new `client.ts` entrypoint wraps SSH for remote-broker setups. The original `server.ts` still works directly for local-only mode.
