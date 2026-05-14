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
    cwd: "D:\\AI\\MCPServer\\claude-peers-mcp",
  });
  return await proc.exited;
}

test("install creates settings.json with hook entry", async () => {
  const home = freshHome();
  const code = await runInstaller(home);
  expect(code).toBe(0);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const arr = cfg.hooks?.SessionEnd ?? [];
  const matches = JSON.stringify(arr).includes("hook-session-end-peers.ts");
  expect(matches).toBe(true);
});

test("install is idempotent (second run does not duplicate)", async () => {
  const home = freshHome();
  await runInstaller(home);
  await runInstaller(home);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const count = (JSON.stringify(cfg.hooks.SessionEnd).match(/hook-session-end-peers\.ts/g) ?? []).length;
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
  expect(blob).toContain("hook-session-end-peers.ts");
});

test("uninstall removes the entry but keeps unrelated hooks", async () => {
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
  expect(await runInstaller(home, ["--uninstall"])).toBe(0);
  const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  const blob = JSON.stringify(cfg.hooks.SessionEnd);
  expect(blob).toContain("other-hook.sh");
  expect(blob).not.toContain("hook-session-end-peers.ts");
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
