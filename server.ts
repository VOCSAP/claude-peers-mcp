#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Runs on the host where the broker daemon lives (typically a LXC reached
 * via SSH stdio). Spawned by client.ts (or directly by Claude Code in legacy
 * local-only mode).
 *
 * Reads a single JSON handshake line on stdin BEFORE switching to the MCP
 * stdio transport. The handshake carries the client's local context
 * (cwd, git_root, branch, recent files, host, pid, project key).
 *
 * If no handshake is received within HANDSHAKE_TIMEOUT_MS, falls back to
 * detecting context locally (legacy single-host mode).
 *
 * Declares claude/channel capability to push inbound messages immediately.
 */

import { PassThrough } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  ClientMeta,
} from "./shared/types.ts";
import {
  generateSummary,
  heuristicSummary,
  getGitBranch,
  getRecentFiles,
  computeProjectKey,
} from "./shared/summarize.ts";
import { loadConfig, brokerUrl, resolveProvider } from "./shared/config.ts";

// --- Configuration ---

const config = await loadConfig();
const BROKER_URL = brokerUrl(config);
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 2000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging.
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

// --- Handshake ---

/**
 * Read the first newline-terminated JSON line from stdin, parse it as a
 * handshake, and return the ClientMeta plus a PassThrough stream that
 * carries the rest of stdin (forwarded to the MCP transport).
 *
 * If no newline arrives before HANDSHAKE_TIMEOUT_MS, resolves to null and
 * the caller falls back to local context detection.
 */
function readHandshake(): Promise<{
  meta: ClientMeta | null;
  stream: PassThrough;
}> {
  const stream = new PassThrough();
  let resolved = false;
  let buffer: Buffer = Buffer.alloc(0);

  return new Promise((resolve) => {
    const stdin = process.stdin;

    const finalize = (meta: ClientMeta | null, leftover: Buffer) => {
      if (resolved) return;
      resolved = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      clearTimeout(timer);
      if (leftover.length > 0) {
        stream.write(leftover);
      }
      // From now on, every chunk goes straight into the passthrough.
      stdin.on("data", (chunk: Buffer) => stream.write(chunk));
      stdin.on("end", () => stream.end());
      resolve({ meta, stream });
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a); // \n
      if (nl === -1) return;
      const line = buffer.subarray(0, nl).toString("utf-8");
      const rest = buffer.subarray(nl + 1);
      try {
        const parsed = JSON.parse(line) as { client_meta?: ClientMeta };
        if (parsed && parsed.client_meta) {
          finalize(parsed.client_meta, rest);
          return;
        }
      } catch {
        // Not a handshake line: this is already MCP traffic. Treat as no-handshake.
      }
      // First line wasn't a handshake -- it's MCP. Replay the whole buffer
      // (including the consumed line) into the passthrough and treat as no
      // handshake.
      finalize(null, buffer);
    };

    const onEnd = () => finalize(null, buffer);

    const timer = setTimeout(() => finalize(null, buffer), HANDSHAKE_TIMEOUT_MS);

    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myProjectKey: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine (and on other PCs sharing the same broker) can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder -- answer right away, even if you're in the middle of something.

Read the from_id, from_summary, from_host, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the same broker. Returns their ID, host, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on the broker. "directory" = same working directory. "repo" = same git repository (matched cross-PC via the normalized git remote URL).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

function formatPeer(p: Peer): string {
  const idLine = p.host && p.client_pid
    ? `ID: ${p.id}  (${p.host} - PID: ${p.client_pid})`
    : `ID: ${p.id}`;
  const parts = [idLine, `CWD: ${p.cwd}`];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.project_key) parts.push(`Project: ${p.project_key}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map(formatPeer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      let fromSummary = "";
      let fromCwd = "";
      let fromHost = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
          project_key: myProjectKey,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          fromHost = sender.host ?? "";
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            from_host: fromHost,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Read handshake (or fall back to local detection after timeout)
  log("Awaiting client handshake on stdin...");
  const { meta, stream: stdinStream } = await readHandshake();

  let host: string;
  let clientPid: number;
  let tty: string | null;
  let gitBranch: string | null;
  let recentFiles: string[];

  if (meta) {
    log(`Handshake received from host ${meta.host}, client_pid ${meta.client_pid}`);
    myCwd = meta.cwd;
    myGitRoot = meta.git_root;
    myProjectKey = meta.project_key;
    host = meta.host;
    clientPid = meta.client_pid;
    tty = meta.tty ?? null;
    gitBranch = meta.git_branch ?? null;
    recentFiles = meta.recent_files ?? [];
  } else {
    log("No handshake received -- falling back to local context detection");
    myCwd = process.cwd();
    myGitRoot = await getGitRoot(myCwd);
    myProjectKey = await computeProjectKey(myCwd);
    host = hostname();
    clientPid = process.pid;
    tty = null;
    gitBranch = await getGitBranch(myCwd);
    recentFiles = await getRecentFiles(myCwd);
  }

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Project key: ${myProjectKey ?? "(none)"}`);
  log(`Host: ${host}  client_pid: ${clientPid}`);

  // 2. Ensure broker is running
  await ensureBroker();

  // 3. Compute initial summary (heuristic immediately, Anthropic in background)
  const initialSummary = heuristicSummary({
    cwd: myCwd,
    git_root: myGitRoot,
    git_branch: gitBranch,
    recent_files: recentFiles,
  });
  log(`Heuristic summary: ${initialSummary}`);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    host,
    client_pid: clientPid,
    project_key: myProjectKey,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // 5. Try Anthropic-powered summary in the background; replace the heuristic
  //    if it arrives.
  (async () => {
    try {
      const provider = resolveProvider(config);
      const summary = await generateSummary(
        {
          cwd: myCwd,
          git_root: myGitRoot,
          git_branch: gitBranch,
          recent_files: recentFiles,
        },
        {
          provider,
          api_key: config.summary_api_key ?? process.env.ANTHROPIC_API_KEY ?? null,
          model: config.summary_model,
          base_url: config.summary_base_url,
        }
      );
      log(`Summary provider: ${provider} (model: ${config.summary_model})`);
      if (summary && summary !== initialSummary && myId) {
        await brokerFetch("/set-summary", { id: myId, summary });
        log(`Anthropic summary applied: ${summary}`);
      }
    } catch (e) {
      log(`Background summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // 6. Connect MCP over stdio (using the post-handshake passthrough stream)
  const transport = new StdioServerTransport(stdinStream as unknown as NodeJS.ReadableStream, process.stdout);
  await mcp.connect(transport);
  log("MCP connected");

  // 7. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 8. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 9. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
