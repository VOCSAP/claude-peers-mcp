import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

async function runHook(brokerUrl: string, payload: object, brokerToken?: string) {
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PEERS_BROKER_URL: brokerUrl,
  };
  if (brokerToken) env.CLAUDE_PEERS_BROKER_TOKEN = brokerToken;
  const proc = Bun.spawn(["bun", "hook-session-end-peers.ts"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: "D:\\AI\\MCPServer\\claude-peers-mcp",
  });
  // NOTE: proc.stdin is a Bun FileSink, NOT a WritableStream.
  // Use proc.stdin.write(...) + proc.stdin.end(), not getWriter().
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const exitCode = await proc.exited;
  return { exitCode };
}

test("hook POSTs /disconnect-by-cli-pid with payload session_id", async () => {
  const b = await startBroker();
  brokers.push(b);

  // The hook reads hostname() and process.ppid -- inside the hook, ppid is the
  // bun test runner (this process). Register a matching peer for the assertion to work.
  const host = require("node:os").hostname();
  await post(`${b.url}/register`, {
    pid: livePid(), cwd: "/tmp/hook-test", git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: process.pid,
    project_key: null, group_id: "default", group_secret_hash: null,
  });

  const { exitCode } = await runHook(b.url, { session_id: "uuid-hook-1" });
  expect(exitCode).toBe(0);

  const { Database } = await import("bun:sqlite");
  const db = new Database(b.dbPath, { readonly: true });
  const row = db.query("SELECT status FROM peers LIMIT 1").get() as { status: string };
  db.close();
  expect(row.status).toBe("dormant");
}, 15_000);

test("hook exits 0 when broker is unreachable (no throw)", async () => {
  const { exitCode } = await runHook("http://127.0.0.1:1", { session_id: "x" });
  expect(exitCode).toBe(0);
}, 10_000);

test("hook exits 0 on non-JSON stdin payload", async () => {
  const b = await startBroker();
  brokers.push(b);
  const proc = Bun.spawn(["bun", "hook-session-end-peers.ts"], {
    env: { ...process.env, CLAUDE_PEERS_BROKER_URL: b.url },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: "D:\\AI\\MCPServer\\claude-peers-mcp",
  });
  proc.stdin.write("this is not json");
  proc.stdin.end();
  const code = await proc.exited;
  expect(code).toBe(0);
});

test("hook forwards Authorization header when broker_token is configured", async () => {
  const b = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: "tok-abc" });
  brokers.push(b);

  const host = require("node:os").hostname();
  const res = await fetch(`${b.url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok-abc" },
    body: JSON.stringify({
      pid: livePid(), cwd: "/tmp/hook-auth", git_root: null, tty: null,
      summary: "", host, client_pid: livePid(), claude_cli_pid: process.pid,
      project_key: null, group_id: "default", group_secret_hash: null,
    }),
  });
  expect(res.status).toBe(200);

  const { exitCode } = await runHook(b.url, { session_id: "uuid-auth" }, "tok-abc");
  expect(exitCode).toBe(0);

  const { Database } = await import("bun:sqlite");
  const db = new Database(b.dbPath, { readonly: true });
  const row = db.query("SELECT status FROM peers LIMIT 1").get() as { status: string };
  db.close();
  expect(row.status).toBe("dormant");
}, 15_000);
