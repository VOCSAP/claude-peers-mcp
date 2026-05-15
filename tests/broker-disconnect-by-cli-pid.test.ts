import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

async function register(b: TestBroker, host: string, cli_pid: number, cwd: string) {
  const r = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd, git_root: null, tty: null, summary: "",
      host, client_pid: livePid(), claude_cli_pid: cli_pid,
      project_key: null, group_id: "default", group_secret_hash: null,
    }
  );
  expect(r.status).toBe(200);
  return r.body;
}

test("single active peer matched by (host, cli_pid) becomes dormant", async () => {
  const b = await startBroker();
  brokers.push(b);
  const p = await register(b, "h1", 1111, "/tmp/a");
  const r = await post<{ disconnected: number; peer_ids: string[] }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "h1", claude_cli_pid: 1111, claude_session_id: "uuid-x" }
  );
  expect(r.status).toBe(200);
  expect(r.body.disconnected).toBe(1);
  expect(r.body.peer_ids).toEqual([p.peer_id]);
});

test("zero match returns 200 with disconnected=0 (idempotent)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ disconnected: number; peer_ids: string[] }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "ghost", claude_cli_pid: 7, claude_session_id: null }
  );
  expect(r.status).toBe(200);
  expect(r.body.disconnected).toBe(0);
  expect(r.body.peer_ids).toEqual([]);
});

test("dormant peers are NOT matched", async () => {
  const b = await startBroker();
  brokers.push(b);
  const p = await register(b, "h2", 2222, "/tmp/b");
  await post(`${b.url}/disconnect`, { instance_token: p.instance_token });
  const r = await post<{ disconnected: number }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "h2", claude_cli_pid: 2222 }
  );
  expect(r.body.disconnected).toBe(0);
});

test("cross-host peer NOT matched", async () => {
  const b = await startBroker();
  brokers.push(b);
  await register(b, "h-alpha", 3333, "/tmp/c");
  const r = await post<{ disconnected: number }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "h-beta", claude_cli_pid: 3333 }
  );
  expect(r.body.disconnected).toBe(0);
});

test("multiple peers same (host, cli_pid) all matched", async () => {
  // Edge case: same Claude Code CLI somehow spawned two MCP servers.
  // Both should be disconnected.
  const b = await startBroker();
  brokers.push(b);
  const p1 = await register(b, "hm", 4444, "/tmp/m1");
  const p2 = await register(b, "hm", 4444, "/tmp/m2");
  const r = await post<{ disconnected: number; peer_ids: string[] }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "hm", claude_cli_pid: 4444 }
  );
  expect(r.body.disconnected).toBe(2);
  expect(r.body.peer_ids.sort()).toEqual([p1.peer_id, p2.peer_id].sort());
});

test("missing host -> 400", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ error: string }>(
    `${b.url}/disconnect-by-cli-pid`,
    { claude_cli_pid: 1 }
  );
  expect(r.status).toBe(400);
});

test("missing claude_cli_pid -> 400", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ error: string }>(
    `${b.url}/disconnect-by-cli-pid`,
    { host: "h" }
  );
  expect(r.status).toBe(400);
});
