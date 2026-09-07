import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeCwdKey,
  sanitizeSessionId,
  resolvePeerId,
  resolvePeerIdAmong
} from "../desktop/src/main/peer-state.ts";
import { ThinkingDetector, type ThinkingEvent } from "../desktop/src/main/thinking.ts";

const tmpDirs: string[] = [];
function tmpPeersDir(): string {
  const d = mkdtempSync(join(tmpdir(), "peers-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ----- sanitizeSessionId (mirror of shared/peer-cache.ts) -----

test("sanitizeSessionId replaces non-[A-Za-z0-9-] with '_' and caps at 64", () => {
  expect(sanitizeSessionId("abc-123")).toBe("abc-123");
  expect(sanitizeSessionId("a b/c.d")).toBe("a_b_c_d");
  expect(sanitizeSessionId(undefined)).toBe("");
  expect(sanitizeSessionId("x".repeat(80)).length).toBe(64);
});

// ----- resolvePeerId -----

test("resolves the exact per-session file deterministically", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const sid = "11111111-2222-3333-4444-555555555555";
  writeFileSync(join(dir, `peer-id-${key}-${sid}.txt`), "dev-pc-proj-2\n", "utf-8");
  // A different, newer session file for the same cwd must NOT win.
  writeFileSync(join(dir, `peer-id-${key}-99999999.txt`), "other-peer", "utf-8");
  expect(resolvePeerId(cwd, sid, dir)).toBe("dev-pc-proj-2");
});

test("falls back to the newest file when no sessionId is given at all (legacy layout)", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const older = join(dir, `peer-id-${key}-aaaa.txt`);
  const newer = join(dir, `peer-id-${key}-bbbb.txt`);
  writeFileSync(older, "older-peer", "utf-8");
  writeFileSync(newer, "newer-peer", "utf-8");
  // Make `newer` clearly the most recent.
  const now = Date.now() / 1000;
  utimesSync(older, now - 100, now - 100);
  utimesSync(newer, now, now);
  // No sessionId at all -> legacy mtime fallback still applies.
  expect(resolvePeerId(cwd, undefined, dir)).toBe("newer-peer");
});

test("returns null (not a sibling tile's peer_id) when a sessionId IS given but its exact file is missing", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const older = join(dir, `peer-id-${key}-aaaa.txt`);
  const newer = join(dir, `peer-id-${key}-bbbb.txt`);
  writeFileSync(older, "older-peer", "utf-8");
  writeFileSync(newer, "newer-peer", "utf-8");
  const now = Date.now() / 1000;
  utimesSync(older, now - 100, now - 100);
  utimesSync(newer, now, now);
  // sessionId 'cccc' has no exact file of its own: must fail closed (null),
  // never borrow a sibling tile's cache file (card aa8d6b5f).
  expect(resolvePeerId(cwd, "cccc", dir)).toBeNull();
});

test("returns null when nothing matches", () => {
  const dir = tmpPeersDir();
  expect(resolvePeerId("/home/u/empty", "sid", dir)).toBeNull();
});

// ----- resolvePeerIdAmong -----

test("takes the freshest file among the tile's own known ids", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const idA = "session-a";
  const idB = "session-b";
  const fileA = join(dir, `peer-id-${key}-${idA}.txt`);
  const fileB = join(dir, `peer-id-${key}-${idB}.txt`);
  writeFileSync(fileA, "dev-pc-proj-2", "utf-8");
  writeFileSync(fileB, "dev-pc-proj-2-renamed", "utf-8");
  const now = Date.now() / 1000;
  utimesSync(fileA, now - 100, now - 100);
  utimesSync(fileB, now, now);

  expect(resolvePeerIdAmong(cwd, [idA, idB], dir)).toBe("dev-pc-proj-2-renamed");
});

test("peremption: a set_id/switch_group rewrite of the ORIGINAL id's file (never a fresh file under the new id) still resolves to the new value", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const idA = "session-a"; // the id this tile first registered under
  const idB = "session-b"; // adopted after a /clear; never gets its own file
  const fileA = join(dir, `peer-id-${key}-${idA}.txt`);
  writeFileSync(fileA, "dev-pc-proj-2", "utf-8");
  const now = Date.now() / 1000;
  utimesSync(fileA, now - 100, now - 100);

  // The core rewrites idA's file in place (its own env is frozen to idA),
  // not a new file under idB -- this is the exact mechanism, not a stand-in.
  writeFileSync(fileA, "dev-pc-proj-2-renamed", "utf-8");
  utimesSync(fileA, now, now);

  expect(resolvePeerIdAmong(cwd, [idA, idB], dir)).toBe("dev-pc-proj-2-renamed");
});

test("never borrows a sibling tile's file or the shared legacy file, even when both exist (card aa8d6b5f)", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  // A neighbour tile's own per-session file for the same cwd.
  writeFileSync(join(dir, `peer-id-${key}-neighbour-session.txt`), "neighbour-peer", "utf-8");
  // The legacy layout file shared by every tile at this cwd.
  writeFileSync(join(dir, `peer-id-${key}.txt`), "legacy-peer", "utf-8");

  // Neither of this tile's own known ids has a file of its own.
  expect(resolvePeerIdAmong(cwd, ["this-tile-id-1", "this-tile-id-2"], dir)).toBeNull();
});

test("rejects a truncated-but-non-empty value that is not a plausible peer_id", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const id = "session-a";
  writeFileSync(join(dir, `peer-id-${key}-${id}.txt`), "dev pc proj\x00", "utf-8");

  expect(resolvePeerIdAmong(cwd, [id], dir)).toBeNull();
});

test("returns null when the list of known ids is empty", () => {
  const dir = tmpPeersDir();
  expect(resolvePeerIdAmong("/home/u/proj", [], dir)).toBeNull();
});

test("accepts a legitimately-minted peer_id longer than 32 chars, ending in a hyphen after truncation", () => {
  const dir = tmpPeersDir();
  const cwd = "/home/u/proj";
  const key = computeCwdKey(cwd);
  const id = "session-a";
  // The broker's own derivation can exceed its 32-char policy cap and can
  // truncate onto a trailing hyphen; this module must not reject either.
  const minted = "a-very-long-hostname-and-project-name-4a-";
  writeFileSync(join(dir, `peer-id-${key}-${id}.txt`), minted, "utf-8");

  expect(resolvePeerIdAmong(cwd, [id], dir)).toBe(minted);
});

// ----- ThinkingDetector -----

test("emits busy on a marker and idle after the debounce, transitions only", async () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));

  d.feed("s1", "some output, esc to interrupt, working...");
  d.feed("s1", "still esc to interrupt"); // no second 'true' (already busy)
  expect(events).toEqual([{ id: "s1", busy: true }]);

  await wait(60);
  expect(events).toEqual([
    { id: "s1", busy: true },
    { id: "s1", busy: false }
  ]);
  d.stop();
});

test("detects the braille spinner and strips ANSI around the marker", () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  // Spinner frame wrapped in colour codes.
  d.feed("s1", "\x1b[33m⠹\x1b[0m thinking");
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.stop();
});

test("non-busy output never flips to busy", () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  d.feed("s1", "just a normal prompt > ");
  expect(events).toEqual([]);
  d.stop();
});

test("clear() cancels the pending idle flip (no stale busy=false leak)", async () => {
  const d = new ThinkingDetector(30);
  const events: ThinkingEvent[] = [];
  d.on("thinking", (e: ThinkingEvent) => events.push(e));
  d.feed("s1", "esc to interrupt");
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.clear("s1");
  await wait(60);
  // No idle event after clear.
  expect(events).toEqual([{ id: "s1", busy: true }]);
  d.stop();
});
