import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure module (node builtins only), so it imports cleanly under bun.
import { runDataMigration, APP_STATE_SUBDIR } from "../desktop/src/main/migrate-data-dir.ts";

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-migrate-"));
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

test("copies legacy deck app state into <userData>/config", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  writeFileSync(join(deck, "sessions.json"), JSON.stringify([{ id: "a" }]), "utf-8");

  runDataMigration({ userDataDir: desk });

  const cfg = join(desk, APP_STATE_SUBDIR, "config.json");
  expect(existsSync(cfg)).toBe(true);
  expect(JSON.parse(readFileSync(cfg, "utf-8")).theme).toBe("light");
  expect(existsSync(join(desk, APP_STATE_SUBDIR, "sessions.json"))).toBe(true);
});

test("never overwrites an existing destination (idempotent)", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  mkdirSync(join(desk, APP_STATE_SUBDIR), { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  writeFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), JSON.stringify({ theme: "dark" }), "utf-8");

  runDataMigration({ userDataDir: desk });
  runDataMigration({ userDataDir: desk }); // a second run stays a no-op

  const cfg = JSON.parse(readFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), "utf-8"));
  expect(cfg.theme).toBe("dark"); // preserved, not clobbered
});

test("no-op when the legacy deck folder is absent", () => {
  const parent = tmpRoot();
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(desk, { recursive: true });

  runDataMigration({ userDataDir: desk });

  expect(existsSync(join(desk, APP_STATE_SUBDIR, "config.json"))).toBe(false);
});

test("does not touch a launch config.json sitting at the desk root", () => {
  const parent = tmpRoot();
  const deck = join(parent, "claude-peers-deck");
  const desk = join(parent, "claude-peers-desk");
  mkdirSync(deck, { recursive: true });
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(deck, "config.json"), JSON.stringify({ theme: "light" }), "utf-8");
  // The launch config lives at the desk root (NOT under config/) and must be
  // left untouched by the userData migration.
  const launch = join(desk, "config.json");
  writeFileSync(launch, JSON.stringify({ launchCommand: "claude run" }), "utf-8");

  runDataMigration({ userDataDir: desk });

  expect(JSON.parse(readFileSync(launch, "utf-8")).launchCommand).toBe("claude run");
  expect(JSON.parse(readFileSync(join(desk, APP_STATE_SUBDIR, "config.json"), "utf-8")).theme).toBe(
    "light"
  );
});
