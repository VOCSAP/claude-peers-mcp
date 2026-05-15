---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers (v0.3.1)

Peer discovery and messaging MCP channel for Claude Code instances. v0.3 introduces group isolation (TOFU), resumable identity, WebSocket push, and a dual `instance_token` / `peer_id` model. v0.3.1 adds auto-disconnect on session end.

## Architecture

Two entrypoints. Two deployment modes (local-only / HTTP).

- `server.ts` -- per-session MCP stdio server. Spawned by Claude Code, runs locally on
  the PC. Detects local context (cwd, git_root, branch, hostname, pid, project_key)
  and resolves the group via `resolveGroup` from `shared/config.ts`. Registers with
  the broker (HTTP), opens a WebSocket for push delivery. Captures `process.ppid` as
  `claude_cli_pid` -- shared with the SessionEnd hook for 1:1 disconnect mapping. On
  stdin EOF (Claude Code exits), `server.ts` calls `/disconnect` then `process.exit(0)`.

- `broker.ts` -- singleton HTTP + WebSocket daemon on `<BIND_HOST>:<port>` + SQLite.
  v0.3.1 endpoints: `/register`, `/heartbeat`, `/set-summary`, `/disconnect`,
  `/disconnect-by-cli-pid` (hook-driven), `/unregister`, `/set-id`, `/list-peers`,
  `/send-message`, `/poll-messages`, `/peek-messages`, `/group-stats`, plus the `/ws`
  upgrade. Two cleanup timers: `cleanStalePeers` (every
  `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` = 30s default: same-host PID-dead -> dormant via
  `process.kill(pid, 0)`, dormant past 24h -> DELETE cascade; cross-host peers
  where `peer.host != hostname()` are skipped in the PID check because the broker
  cannot reason about a foreign machine's process table -- they are reaped by the
  heartbeat sweep instead) and `sweepInactivePeers` (every
  `CLAUDE_PEERS_DORMANT_SWEEP_SEC` = 60s default: active without recent heartbeat for
  more than `CLAUDE_PEERS_ACTIVE_STALE_SEC` = 120s default -> dormant).

- `hook-session-end-peers.sh` -- bash + curl script invoked by Claude Code at session
  end. POSTs `/disconnect-by-cli-pid` with `(hostname, $PPID)`. Always exits 0.
  Installed via `bun install-hook.ts`, which copies the script to
  `~/.claude/hooks/session-end-peers.sh` and registers a `bash <path>` command in
  `~/.claude/settings.json` (consistent with the kleos hook pattern).

- `cli.ts` -- diagnostic CLI for the broker (status, peers, groups, kill-broker).
  Unchanged from v0.3 except for the version string.

- `shared/config.ts` -- Centralized configuration loader. Settings: env var > settings file > default. Group resolution (v0.3) is hierarchical: `.claude-peers.local.json` > `.claude-peers.json` (walking up to git_root) > user config `default_group` > env `CLAUDE_PEERS_GROUP` > sentinel `'default'`. Helpers: `resolveGroup`, `resolveGroupName`, `resolveGroupSecret`, `computeGroupId`, `computeGroupSecretHash`, `brokerUrl`. Settings file at `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) or `%APPDATA%\claude-peers\config.json` (Windows). The `groups` field maps logical names to secrets; `default_group` picks one. HTTP mode fields: `broker_url` (direct broker URL, overrides loopback), `broker_token` (Bearer auth token), `bind_host` (broker listen address).
- `shared/types.ts` -- Shared types. v0.3 entities: `InstanceToken` (UUID v4 routing), `PeerId` (display, mutable), `GroupId` (32-hex or 'default'), `Peer` (full row with `status: 'active' | 'dormant'`), `Message` (with `from_token`/`to_token` and `group_id`), `WsAuthFrame`, `WsMessageFrame`.
- `shared/summarize.ts` -- Auto-summary generation. Multi-provider: Anthropic (`api.anthropic.com/v1/messages`) or any OpenAI-compatible `/chat/completions` endpoint (LiteLLM, Ollama via `/v1`, vLLM, OpenAI, OpenRouter). Provider selection via `CLAUDE_PEERS_SUMMARY_PROVIDER` (default `auto` resolves at runtime). Heuristic fallback always returns a non-empty string on any failure. Also hosts `computeProjectKey` and `normalizeRemoteUrl`.

## Identity model (v0.3)

- `instance_token` (UUID v4, immutable) -- internal routing key. FK target for `messages`, key of the WebSocket pool, key of `peer_sessions`. Never exposed to Claude.
- `peer_id` (display, mutable via `set_id`) -- what `list_peers`, `whoami`, `send_message` speak. Unique per `(peer_id, group_id)`, all statuses included (renaming over a dormant peer's name is rejected with 409).

The default `peer_id` is derived from `(host, cwd, group_id)` via `deriveDefaultId` with a `MAX_SUFFIX=1000` guardrail. Typical defaults look like `olivier-pc-claude-peers-mcp` or `olivier-pc-foo-2` on collision.

## Resume flow (v0.3)

`session_key = sha256(host || \0 || cwd || \0 || group_id)`. On `/register`:
- session_key exists, peer is dormant -> bascule en active, returns the same `(peer_id, instance_token)`.
- session_key exists, peer is active but recorded `pid` is dead -> treat as dormant -> resurrect.
- session_key exists, peer is genuinely active (live pid) -> session_key collision: mint a fresh `(peer_id, instance_token)` with derived suffix; the original keeps the canonical session.
- session_key exists but the row was purged -> reuse the remembered `instance_token`, mint a fresh display id.
- Else -> fresh registration.

## Running

See `README.md` for full setup. Quick references:

```bash
# Local mode (broker auto-spawned alongside server.ts):
#   .mcp.json: { "mcpServers": { "claude-peers": { "command": "bun", "args": ["./server.ts"] } } }
claude --dangerously-load-development-channels server:claude-peers

# HTTP mode (broker publicly accessible, server.ts runs locally):
#   config.json: { "broker_url": "http://broker:7899", "broker_token": "secret" }
#   broker side: CLAUDE_PEERS_BIND_HOST=0.0.0.0 CLAUDE_PEERS_BROKER_TOKEN=secret bun broker.ts
#   .mcp.json: { "mcpServers": { "claude-peers": { "command": "bun", "args": ["./server.ts"] } } }

# Install auto-disconnect hook (once per PC):
bun install-hook.ts

# CLI (run on the broker host):
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```

## Smoke check

`bun build --target=bun broker.ts server.ts cli.ts install-hook.ts --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any import or type-resolution error. Use this between refactors instead of running each file (the `.sh` hook is not a Bun entrypoint). For type-strict checks: `bunx tsc --noEmit --skipLibCheck --module esnext --target es2022 --moduleResolution bundler --allowImportingTsExtensions broker.ts server.ts cli.ts install-hook.ts`.

`bun test` runs the v0.3.1 suite (16 files, 59 cases): `tests/broker-groups.test.ts` (TOFU + isolation), `broker-resume.test.ts` (identity stability), `broker-set-id.test.ts` (rename + collision), `broker-websocket.test.ts` (auth, push, flush), `broker-ws-auth.test.ts` (Bearer-token upgrade, no-token rejection), `broker-status.test.ts` (dormant lifecycle, TTL purge), `broker-activity-status.test.ts` (fresh + resurrected peer reports active), `broker-migration.test.ts` (claude_cli_pid migration idempotency), `broker-disconnect-by-cli-pid.test.ts` (host+cli_pid matching), `broker-sweep-inactive.test.ts` (heartbeat sweep), `broker-cross-host-cleanup.test.ts` (cleanStalePeers same-host filter), `broker-cross-host-register.test.ts` (handleRegister same-host filter + collision mints fresh id), `config-loopback.test.ts` (isLoopbackBrokerUrl detection), `server-stdin-eof.test.ts` (self-shutdown), `hook-session-end.test.ts` (SessionEnd hook), `install-hook.test.ts` (idempotent installer). Each suite spins up an ephemeral broker on a random port via `tests/_helper.ts` (env-scrubbed so developer-side `CLAUDE_PEERS_*` vars do not leak into the broker) and tears it down in `afterAll`.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
