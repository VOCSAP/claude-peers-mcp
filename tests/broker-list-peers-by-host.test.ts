import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

async function register(b: TestBroker, host: string, cli_pid: number | null, cwd: string) {
  const r = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd, git_root: null, tty: null, summary: "",
      host, client_pid: livePid(), claude_cli_pid: cli_pid,
      project_key: null, group_id: "default", group_secret_hash: null,
    },
  );
  expect(r.status).toBe(200);
  return r.body;
}

test("returns active peers for the given host with their instance_token and claude_cli_pid", async () => {
  const b = await startBroker();
  brokers.push(b);
  const p1 = await register(b, "host-A", 100, "/tmp/a");
  const p2 = await register(b, "host-A", 200, "/tmp/b");
  await register(b, "host-B", 300, "/tmp/c");

  const r = await post<{ peers: { instance_token: string; claude_cli_pid: number | null }[] }>(
    `${b.url}/list-peers-by-host`,
    { host: "host-A" },
  );
  expect(r.status).toBe(200);
  const tokens = r.body.peers.map((p) => p.instance_token).sort();
  expect(tokens).toEqual([p1.instance_token, p2.instance_token].sort());
  const pidByToken = Object.fromEntries(r.body.peers.map((p) => [p.instance_token, p.claude_cli_pid]));
  expect(pidByToken[p1.instance_token]).toBe(100);
  expect(pidByToken[p2.instance_token]).toBe(200);
});

test("returns empty list when host has no registered peers", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ peers: unknown[] }>(`${b.url}/list-peers-by-host`, { host: "ghost-host" });
  expect(r.status).toBe(200);
  expect(r.body.peers).toEqual([]);
});

test("excludes dormant peers (only active are listed)", async () => {
  const b = await startBroker();
  brokers.push(b);
  const p1 = await register(b, "host-X", 11, "/tmp/x1");
  const p2 = await register(b, "host-X", 22, "/tmp/x2");
  await post(`${b.url}/disconnect`, { instance_token: p2.instance_token });

  const r = await post<{ peers: { instance_token: string }[] }>(
    `${b.url}/list-peers-by-host`,
    { host: "host-X" },
  );
  expect(r.body.peers.map((p) => p.instance_token)).toEqual([p1.instance_token]);
});

test("does not leak peers from other hosts", async () => {
  const b = await startBroker();
  brokers.push(b);
  await register(b, "host-foo", 1, "/tmp/1");
  await register(b, "host-bar", 2, "/tmp/2");
  const r = await post<{ peers: unknown[] }>(`${b.url}/list-peers-by-host`, { host: "host-foo" });
  expect(r.body.peers.length).toBe(1);
});

test("returns claude_cli_pid: null for peers registered without it", async () => {
  const b = await startBroker();
  brokers.push(b);
  await register(b, "host-nopid", null, "/tmp/nopid");
  const r = await post<{ peers: { claude_cli_pid: number | null }[] }>(
    `${b.url}/list-peers-by-host`,
    { host: "host-nopid" },
  );
  expect(r.body.peers).toHaveLength(1);
  expect(r.body.peers[0].claude_cli_pid).toBeNull();
});

test("missing host -> 400", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ error: string }>(`${b.url}/list-peers-by-host`, {});
  expect(r.status).toBe(400);
});

test("empty string host -> 400", async () => {
  const b = await startBroker();
  brokers.push(b);
  const r = await post<{ error: string }>(`${b.url}/list-peers-by-host`, { host: "" });
  expect(r.status).toBe(400);
});

test("requires Authorization header when broker_token is set", async () => {
  const b = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: "secret-xyz" });
  brokers.push(b);

  // No-token request rejected.
  const unauthorized = await fetch(`${b.url}/list-peers-by-host`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "h" }),
  });
  expect(unauthorized.status).toBe(401);

  // With token: accepted.
  const ok = await fetch(`${b.url}/list-peers-by-host`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-xyz" },
    body: JSON.stringify({ host: "h" }),
  });
  expect(ok.status).toBe(200);
});
