---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

Three entrypoints. Two deployment modes (local-only vs remote broker over SSH).

- `client.ts` -- Local stdio shim (PC client side). Detects local context (cwd, git_root, branch, recent files, hostname, pid, project_key from `git remote get-url origin` normalized), spawns `ssh user@broker-host bun <remote_server_path>`, forwards stdio between Claude Code and ssh. Sends a JSON handshake `{"client_meta": {...}}` on stdin's first line. Required only for remote-broker mode.
- `server.ts` -- MCP stdio server (one per session). Reads the handshake via a custom stdin stream (PassThrough) before connecting `StdioServerTransport`. Falls back to local context detection after a 2s timeout if no handshake arrives (legacy single-host mode). Registers with the broker, polls messages, pushes via `claude/channel`.
- `broker.ts` -- Singleton HTTP daemon on `127.0.0.1:<port>` + SQLite. Schema includes `host`, `client_pid`, `project_key` (idempotent ALTER TABLE migration). Cleanup uses `process.kill(pid, 0)` on the bun server process pid (always local to the broker host).
- `shared/config.ts` -- Centralized configuration loader. Resolution order: env var > settings file > default. Settings file at `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) or `%APPDATA%\claude-peers\config.json` (Windows).
- `shared/types.ts` -- Shared types for broker API and the `ClientMeta` handshake.
- `shared/summarize.ts` -- Auto-summary generation. Multi-provider: Anthropic (`api.anthropic.com/v1/messages`) or any OpenAI-compatible `/chat/completions` endpoint (LiteLLM, Ollama via `/v1`, vLLM, OpenAI, OpenRouter). Provider selection via `CLAUDE_PEERS_SUMMARY_PROVIDER` (default `auto` resolves at runtime). Heuristic fallback always returns a non-empty string on any failure. Also hosts `computeProjectKey` and `normalizeRemoteUrl`.
- `cli.ts` -- CLI utility for inspecting broker state. Talks to the broker on loopback, so run it on the broker host.

## Running

See `README.md` for full local-mode and remote-mode setup. Quick references:

```bash
# Local mode (broker auto-spawned alongside server.ts):
claude --dangerously-load-development-channels server:claude-peers

# Remote mode (broker on a LXC/server, client.ts forwards via ssh):
#   .mcp.json
#   {
#     "claude-peers": {
#       "command": "bun",
#       "args": ["./client.ts"],
#       "env": { "CLAUDE_PEERS_REMOTE": "user@broker-host" }
#     }
#   }

# CLI (run on the broker host):
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```

## Smoke check

`bun build --target=bun broker.ts server.ts client.ts cli.ts --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any import or type-resolution error. Use this between refactors instead of running each file.

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
