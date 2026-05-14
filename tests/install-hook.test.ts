import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-hookinstall-"));
  mkdirSync(join(d, ".claude"), { recursive: true });
  dirs.push(d);
  return d;
}

async function runInstaller(home: string, args: string[] = []): Promise<number> {
  const env: Record<string, string> = { ...process.env, HOME: home };
  env.USERPROFILE = home;
  const proc = Bun.spawn(["bun", "install-hook.ts", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  return await proc.exited;
}

test("install copies session-end-peers.sh to ~/.claude/hooks/", async () => {
  const home = freshHome();
  const code = await runInstaller(home);
  expect(code).toBe(0);
  const hookPath = join(home, ".claude", "hooks", "session-end-peers.sh");
  expect(existsSync(hookPath)).toBe(true);
});

test("install writes a valid bash script with shebang", async () => {
  const home = freshHome();
  await runInstaller(home);
  const hookPath = join(home, ".claude", "hooks", "session-end-peers.sh");
  const content = readFileSync(hookPath, "utf-8");
  expect(content.startsWith("#!/bin/bash")).toBe(true);
});

test("install creates settings.json with hook entry (bash command)", async () => {
  const home = freshHome();
  const code = await runInstaller(home);
  expect(code).toBe(0);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const arr = cfg.hooks?.SessionEnd ?? [];
  const blob = JSON.stringify(arr);
  expect(blob).toContain("session-end-peers.sh");
  expect(blob).toContain("bash");
});

test("install is idempotent (second run does not duplicate)", async () => {
  const home = freshHome();
  await runInstaller(home);
  await runInstaller(home);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const count = (JSON.stringify(cfg.hooks.SessionEnd).match(/session-end-peers\.sh/g) ?? []).length;
  // The command string contains the filename once; idempotent means it appears exactly once.
  expect(count).toBe(1);
});

test("install preserves unrelated SessionEnd hooks", async () => {
  const home = freshHome();
  const existing = {
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "/some/other-hook.sh", timeout: 5 }] },
      ],
    },
  };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(existing, null, 2));
  await runInstaller(home);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const blob = JSON.stringify(cfg.hooks.SessionEnd);
  expect(blob).toContain("other-hook.sh");
  expect(blob).toContain("session-end-peers.sh");
});

test("uninstall removes the .sh file and the settings entry, keeps unrelated hooks", async () => {
  const home = freshHome();
  const existing = {
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "/some/other-hook.sh", timeout: 5 }] },
      ],
    },
  };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(existing, null, 2));
  await runInstaller(home);

  // Verify installed
  expect(existsSync(join(home, ".claude", "hooks", "session-end-peers.sh"))).toBe(true);

  expect(await runInstaller(home, ["--uninstall"])).toBe(0);

  // .sh file removed
  expect(existsSync(join(home, ".claude", "hooks", "session-end-peers.sh"))).toBe(false);

  // entry removed, other hook preserved
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const blob = JSON.stringify(cfg.hooks.SessionEnd);
  expect(blob).toContain("other-hook.sh");
  expect(blob).not.toContain("session-end-peers.sh");
});

test("install preserves other top-level keys in settings.json", async () => {
  const home = freshHome();
  const existing = { model: "opus", language: "fr" };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(existing, null, 2));
  await runInstaller(home);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  expect(cfg.model).toBe("opus");
  expect(cfg.language).toBe("fr");
  expect(cfg.hooks.SessionEnd.length).toBeGreaterThan(0);
});
