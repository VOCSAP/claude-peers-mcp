import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("mirror rows get a longer, backoff-derived floor than local/relayed rows", async () => {
  // ACTIVE_STALE_SEC=10 for local/relayed rows; SYNC_BACKOFF_MAX_MS defaults
  // to 60_000ms, so mirrorStaleSec(10, 60_000) floors mirror rows at 120s --
  // a 90s-old mirror must survive one sweep tick that already dormants a
  // 90s-old local peer and a 90s-old relayed row.
  const b = await startBroker({
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "10",
    CLAUDE_PEERS_DORMANT_SWEEP_SEC: "10",
  });
  brokers.push(b);

  const r = await post<{ instance_token: string }>(`${b.url}/register`, {
    pid: livePid(), cwd: "/tmp/sweep-local", git_root: null, tty: null,
    summary: "", host: "h-sweep-local", client_pid: livePid(), claude_cli_pid: 3,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
  expect(r.status).toBe(200);

  const mirrorFresh = randomUUID();
  const mirrorStale = randomUUID();
  const relayed = randomUUID();
  const ninetySecAgo = new Date(Date.now() - 90_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  const setupDb = new Database(b.dbPath);
  setupDb.run(
    "UPDATE peers SET last_seen = ? WHERE instance_token = ?",
    [ninetySecAgo, r.body.instance_token]
  );
  // A replica's mirror of an upstream peer: via and upstream_peer_id set,
  // relay_id NULL.
  const insertMirror = (token: string, peerId: string, lastSeen: string) =>
    setupDb.run(
      `INSERT INTO peers
         (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
          last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, via, upstream_peer_id)
       VALUES (?, ?, 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'upstream', ?)`,
      [token, peerId, lastSeen, lastSeen, peerId]
    );
  insertMirror(mirrorFresh, "mirror-90s", ninetySecAgo);
  insertMirror(mirrorStale, "mirror-1h", oneHourAgo);
  // An upstream's relay of a replica's own peer: relay_id, relay_ref and
  // relay_base set, upstream_peer_id NULL.
  setupDb.run(
    `INSERT INTO peers
       (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
        last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, relay_id, relay_ref, relay_base, via)
     VALUES (?, 'relayed-peer', 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'replica-1', 'ref-1', 'relayed-peer', 'upstream')`,
    [relayed, ninetySecAgo, ninetySecAgo]
  );
  // A LOCAL peer of a replica that the upstream aliased: upstream_peer_id set,
  // via and relay_id NULL. It beats its own heart, so it is not a mirror.
  const aliased = randomUUID();
  setupDb.run(
    `INSERT INTO peers
       (instance_token, peer_id, group_id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
        last_activity_at, host, client_pid, project_key, claude_cli_pid, role, status, upstream_peer_id)
     VALUES (?, 'aliased-local', 'default', 0, '', NULL, NULL, '', ?, ?, NULL, '', 0, NULL, NULL, NULL, 'active', 'aliased-local-2')`,
    [aliased, ninetySecAgo, ninetySecAgo]
  );
  setupDb.close();

  await Bun.sleep(12_000);

  const checkDb = new Database(b.dbPath, { readonly: true });
  const statusOf = (token: string) =>
    (checkDb.query("SELECT status FROM peers WHERE instance_token = ?").get(token) as { status: string }).status;
  const localStatus = statusOf(r.body.instance_token);
  const mirrorFreshStatus = statusOf(mirrorFresh);
  const mirrorStaleStatus = statusOf(mirrorStale);
  const relayedStatus = statusOf(relayed);
  const aliasedStatus = statusOf(aliased);
  checkDb.close();

  expect(localStatus, "a local peer keeps the operator's cutoff: 90s old with a 10s cutoff is dormant").toBe("dormant");
  expect(relayedStatus, "a row an upstream relays for a replica keeps the operator's cutoff too").toBe("dormant");
  expect(mirrorFreshStatus, "a mirror has no heartbeat of its own: 90s without a pass is within the backoff-derived floor, it stays active").toBe("active");
  expect(mirrorStaleStatus, "the mirror floor is a floor, not immunity: an hour-old mirror is swept").toBe("dormant");
  expect(aliasedStatus, "a local peer the upstream aliased still beats its own heart and keeps the operator's cutoff").toBe("dormant");
}, 30_000);

/** Lines of the broker's own rolling log carrying the mirror-floor warning. */
function floorWarnings(b: TestBroker): string[] {
  return readFileSync(join(b.tmpDir, "logs", "broker.log"), "utf-8")
    .split("\n")
    .filter((l) => l.includes("are floored to"));
}

test("a replica started below the mirror floor is warned once, in its own log; a plain broker is not", async () => {
  const replica = await startBroker({
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:59999",
    CLAUDE_PEERS_BROKER_TOKEN: "t".repeat(40),
    CLAUDE_PEERS_ACTIVE_STALE_SEC: "10",
  });
  brokers.push(replica);
  const plain = await startBroker({ CLAUDE_PEERS_ACTIVE_STALE_SEC: "10" });
  brokers.push(plain);
  await Bun.sleep(400);
  const replicaLines = floorWarnings(replica);
  expect(replicaLines.length, "the operator is told once, and once only, that the value is raised for mirrors").toBe(1);
  expect(replicaLines[0], "the warning names the value, the floor and the reason").toMatch(/=10s.*floored to 120s/);
  expect(floorWarnings(plain).length, "a broker with no upstream has no mirrors and nothing to warn about").toBe(0);
}, 30_000);
