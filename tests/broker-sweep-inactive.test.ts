import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

test("active peer with stale last_seen is swept to dormant", async () => {
  // Set very small thresholds: stale after 10s, sweep every 10s (clamped min).
  const b = await startBroker({
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "10",
    CLAUDE_PEERS_DORMANT_SWEEP_SEC: "10",
  });
  brokers.push(b);

  const r = await post<{ instance_token: string }>(`${b.url}/register`, {
    pid: livePid(), cwd: "/tmp/sweep", git_root: null, tty: null,
    summary: "", host: "h-sweep", client_pid: livePid(), claude_cli_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
  expect(r.status).toBe(200);

  // Manipulate last_seen to be 1 hour ago so the sweep catches it on next tick.
  const oldDb = new Database(b.dbPath);
  oldDb.run(
    "UPDATE peers SET last_seen = ? WHERE instance_token = ?",
    [new Date(Date.now() - 3600_000).toISOString(), r.body.instance_token]
  );
  oldDb.close();

  // Wait for at least one sweep tick (10s + jitter). Add a safety margin.
  await Bun.sleep(12_000);

  const checkDb = new Database(b.dbPath, { readonly: true });
  const row = checkDb.query(
    "SELECT status FROM peers WHERE instance_token = ?"
  ).get(r.body.instance_token) as { status: string };
  checkDb.close();
  expect(row.status).toBe("dormant");
}, 30_000);

test("active peer with recent heartbeat stays active", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "10",
    CLAUDE_PEERS_DORMANT_SWEEP_SEC: "10",
  });
  brokers.push(b);

  const r = await post<{ instance_token: string }>(`${b.url}/register`, {
    pid: livePid(), cwd: "/tmp/keep", git_root: null, tty: null,
    summary: "", host: "h-keep", client_pid: livePid(), claude_cli_pid: 2,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
  expect(r.status).toBe(200);

  // Keep heartbeating during the sweep window.
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(3_000);
    await post(`${b.url}/heartbeat`, { instance_token: r.body.instance_token });
  }

  const db = new Database(b.dbPath, { readonly: true });
  const row = db.query(
    "SELECT status FROM peers WHERE instance_token = ?"
  ).get(r.body.instance_token) as { status: string };
  db.close();
  expect(row.status).toBe("active");
}, 30_000);
