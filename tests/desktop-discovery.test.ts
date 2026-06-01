import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeProjectDir,
  listTranscriptIds,
  pickDiscoveredId,
  type TranscriptEntry,
} from "../desktop/src/main/session-transcript.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-disc-"));
  tmpDirs.push(d);
  return d;
}

function writeTranscript(home: string, cwd: string, id: string, mtimeSec: number): void {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, "{}\n");
  utimesSync(f, mtimeSec, mtimeSec);
}

// ----- pickDiscoveredId (pure core) -----

test("pickDiscoveredId returns the newest fresh, unclaimed id", () => {
  const entries: TranscriptEntry[] = [
    { id: "old", mtimeMs: 1000 },
    { id: "new", mtimeMs: 3000 },
    { id: "mid", mtimeMs: 2000 },
  ];
  const before = new Set<string>(["old"]); // existed before the spawn
  const claimed = new Set<string>();
  expect(pickDiscoveredId(entries, before, claimed)).toBe("new");
});

test("pickDiscoveredId skips ids present before the spawn", () => {
  const entries: TranscriptEntry[] = [{ id: "a", mtimeMs: 5000 }];
  expect(pickDiscoveredId(entries, new Set(["a"]), new Set())).toBeNull();
});

test("pickDiscoveredId skips ids already claimed by a live session", () => {
  const entries: TranscriptEntry[] = [
    { id: "claimed", mtimeMs: 9000 },
    { id: "free", mtimeMs: 1000 },
  ];
  expect(pickDiscoveredId(entries, new Set(), new Set(["claimed"]))).toBe("free");
});

test("pickDiscoveredId returns null when nothing is fresh", () => {
  expect(pickDiscoveredId([], new Set(), new Set())).toBeNull();
});

// ----- listTranscriptIds (fs) -----

test("listTranscriptIds returns ids + mtimes, missing dir -> []", () => {
  const home = freshHome();
  const cwd = "/abs/proj";
  expect(listTranscriptIds(home, cwd)).toEqual([]); // no dir yet
  writeTranscript(home, cwd, "id-old", 1000);
  writeTranscript(home, cwd, "id-new", 2000);
  // a non-jsonl file is ignored
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  writeFileSync(join(dir, "notes.txt"), "x");

  const got = listTranscriptIds(home, cwd).sort((a, b) => a.id.localeCompare(b.id));
  expect(got.map((e) => e.id)).toEqual(["id-new", "id-old"]);
  expect(got.find((e) => e.id === "id-new")!.mtimeMs).toBeGreaterThan(0);
});

test("listTranscriptIds + pickDiscoveredId end-to-end: capture a just-written transcript", () => {
  const home = freshHome();
  const cwd = "/abs/proj";
  writeTranscript(home, cwd, "prev-real", 1000);
  const before = new Set(listTranscriptIds(home, cwd).map((e) => e.id)); // {prev-real}
  // Claude mints its own id on the new (forked) session:
  writeTranscript(home, cwd, "claude-minted", 2000);
  const realId = pickDiscoveredId(listTranscriptIds(home, cwd), before, new Set(["prev-real"]));
  expect(realId).toBe("claude-minted");
});
