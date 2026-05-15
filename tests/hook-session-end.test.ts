import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

const HOST = require("node:os").hostname();
// A safely high PID extremely unlikely to be assigned on either Windows or POSIX.
const DEAD_PID = 4294967294;

async function register(b: TestBroker, host: string, cli_pid: number | null, cwd: string) {
  return post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: livePid(),
    claude_cli_pid: cli_pid,
    project_key: null,
    group_id: "default",
    group_secret_hash: null,
  });
}

async function runHook(brokerUrl: string, brokerToken?: string) {
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PEERS_BROKER_URL: brokerUrl,
  };
  if (brokerToken) env.CLAUDE_PEERS_BROKER_TOKEN = brokerToken;
  const proc = Bun.spawn(["bash", "hook-session-end-peers.sh"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  proc.stdin.write(JSON.stringify({ session_id: "ignored-in-v0.3.2" }));
  proc.stdin.end();
  return { exitCode: await proc.exited };
}

async function peerStatus(b: TestBroker, instanceToken: string): Promise<string | null> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(b.dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT status FROM peers WHERE instance_token = ?")
      .get(instanceToken) as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

test("hook disconnects peers whose claude_cli_pid is dead on this host", async () => {
  const b = await startBroker();
  brokers.push(b);
  // Register a peer with an obviously dead PID on the current host.
  const r = await register(b, HOST, DEAD_PID, "/tmp/dead");
  expect(r.status).toBe(200);

  const { exitCode } = await runHook(b.url);
  expect(exitCode).toBe(0);

  expect(await peerStatus(b, r.body.instance_token)).toBe("dormant");
}, 15_000);

test("hook leaves peers whose claude_cli_pid is live untouched", async () => {
  const b = await startBroker();
  brokers.push(b);
  // process.pid is guaranteed live for the duration of the test runner.
  const r = await register(b, HOST, process.pid, "/tmp/live");
  expect(r.status).toBe(200);

  const { exitCode } = await runHook(b.url);
  expect(exitCode).toBe(0);

  expect(await peerStatus(b, r.body.instance_token)).toBe("active");
}, 15_000);

test("hook disconnects only the dead peer, keeps the live one (mixed list)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const live = await register(b, HOST, process.pid, "/tmp/mix-live");
  const dead = await register(b, HOST, DEAD_PID, "/tmp/mix-dead");

  await runHook(b.url);

  expect(await peerStatus(b, live.body.instance_token)).toBe("active");
  expect(await peerStatus(b, dead.body.instance_token)).toBe("dormant");
}, 15_000);

test("hook leaves peers from other hosts alone", async () => {
  const b = await startBroker();
  brokers.push(b);
  // A dead-PID peer on a foreign host must not be touched by this host's hook.
  const foreign = await register(b, "some-other-host", DEAD_PID, "/tmp/foreign");
  await runHook(b.url);
  expect(await peerStatus(b, foreign.body.instance_token)).toBe("active");
}, 15_000);

test("hook treats null claude_cli_pid as a dead candidate (disconnects)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await register(b, HOST, null, "/tmp/nullpid");
  await runHook(b.url);
  expect(await peerStatus(b, r.body.instance_token)).toBe("dormant");
}, 15_000);

test("hook exits 0 when broker is unreachable", async () => {
  const { exitCode } = await runHook("http://127.0.0.1:1");
  expect(exitCode).toBe(0);
}, 10_000);

test("hook exits 0 on non-JSON stdin payload", async () => {
  const b = await startBroker();
  brokers.push(b);
  const proc = Bun.spawn(["bash", "hook-session-end-peers.sh"], {
    env: { ...process.env, CLAUDE_PEERS_BROKER_URL: b.url },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  proc.stdin.write("this is not json");
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
});

test("hook forwards Authorization header when broker_token is configured", async () => {
  const b = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: "tok-zzz" });
  brokers.push(b);

  const res = await fetch(`${b.url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok-zzz" },
    body: JSON.stringify({
      pid: livePid(), cwd: "/tmp/auth-hook", git_root: null, tty: null, summary: "",
      host: HOST, client_pid: livePid(), claude_cli_pid: DEAD_PID,
      project_key: null, group_id: "default", group_secret_hash: null,
    }),
  });
  expect(res.status).toBe(200);
  const { instance_token } = await res.json() as { instance_token: string };

  const { exitCode } = await runHook(b.url, "tok-zzz");
  expect(exitCode).toBe(0);
  expect(await peerStatus(b, instance_token)).toBe("dormant");
}, 15_000);

test("hook is a no-op when no peer matches this host", async () => {
  const b = await startBroker();
  brokers.push(b);
  await register(b, "elsewhere", DEAD_PID, "/tmp/elsewhere");
  const { exitCode } = await runHook(b.url);
  expect(exitCode).toBe(0);
}, 10_000);
