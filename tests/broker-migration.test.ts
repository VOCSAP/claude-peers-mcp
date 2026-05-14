import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";

const brokers: TestBroker[] = [];
afterAll(async () => { for (const b of brokers) await stopBroker(b); });

test("migration adds claude_cli_pid column to peers", async () => {
  const b = await startBroker();
  brokers.push(b);
  const db = new Database(b.dbPath, { readonly: true });
  const cols = db.query("PRAGMA table_info(peers)").all() as { name: string }[];
  db.close();
  expect(cols.some((c) => c.name === "claude_cli_pid")).toBe(true);
});

test("migration is idempotent on already-migrated db", async () => {
  const b1 = await startBroker();
  brokers.push(b1);
  // Restart the broker against the same DB path -- migration must not throw.
  // Note: b2.dbPath is stale (helper computes a fresh tmpDir regardless of envOverrides);
  // the broker process uses b1.dbPath via the CLAUDE_PEERS_DB env override.
  const b2 = await startBroker({ CLAUDE_PEERS_DB: b1.dbPath });
  brokers.push(b2);
  // If we got here, the second broker came up successfully.
  expect(b2.port).toBeGreaterThan(0);
});
