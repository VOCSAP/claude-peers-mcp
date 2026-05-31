import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scope.ts and cli-context.ts only import node builtins (no electron), so they
// import cleanly under bun. This covers the riskiest M2 logic: secret/groupId
// derivation and the file-vs-env transport fallback.
import { computeScope, buildScopeEnv } from "../desktop/src/main/scope.ts";
import { parseCliContext } from "../desktop/src/main/cli-context.ts";

const sha32 = (s: string): string =>
  createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 32);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ----- computeScope -----

test("custom scopeId yields a reproducible custom scope", () => {
  const a = computeScope("/home/u/proj", "team-alpha");
  const b = computeScope("/home/u/proj", "team-alpha");
  expect(a.scopeKind).toBe("custom");
  expect(a.secret).toBe("team-alpha");
  expect(a.groupId).toBe(sha32("team-alpha"));
  // Same id => same group_id (reproducible on restore).
  expect(b.groupId).toBe(a.groupId);
});

test("absent scopeId yields a fresh ephemeral scope each time", () => {
  const a = computeScope("/home/u/proj");
  const b = computeScope("/home/u/proj");
  expect(a.scopeKind).toBe("ephemeral");
  // A random uuid secret, hashed into the 32-hex group_id.
  expect(a.groupId).toBe(sha32(a.secret));
  expect(a.secret).not.toBe(b.secret);
  expect(a.groupId).not.toBe(b.groupId);
});

test("whitespace-only scopeId is treated as ephemeral", () => {
  const s = computeScope("/home/u/proj", "   ");
  expect(s.scopeKind).toBe("ephemeral");
  expect(s.secret).not.toBe("   ");
});

test("root mirrors deriveDefaultId base: sanitized basename suffix", () => {
  const s = computeScope("/home/u/My Project!", "x");
  // basename "My Project!" -> sanitize -> "my-project" (<=12 chars).
  expect(s.root.endsWith("my-project")).toBe(true);
  expect(s.name).toBe(s.root);
});

test("root with an all-invalid basename falls back to the host part only", () => {
  const s = computeScope("/home/u/@@@", "x");
  // cwdPart sanitizes to empty -> root is hostPart only, no trailing dash, no '@'.
  expect(s.root).not.toContain("@");
  expect(s.root.endsWith("-")).toBe(false);
  expect(s.root.length).toBeGreaterThan(0);
});

// ----- buildScopeEnv -----

test("file transport writes a secret file and emits the file env var", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-test-"));
  tmpDirs.push(dir);
  const scope = computeScope("/home/u/proj", "team-alpha");
  const { env, cleanup } = buildScopeEnv(scope, { dir });

  const filePath = env.CLAUDE_PEERS_FORCE_GROUP_FILE;
  expect(filePath).toBeTruthy();
  expect(existsSync(filePath)).toBe(true);
  expect(readFileSync(filePath, "utf-8")).toBe("team-alpha");
  expect(env.CLAUDE_PEERS_FORCE_GROUP_NAME).toBe(scope.name);
  expect(env.CLAUDE_PEERS_STATUS_LINE_CACHE).toBe("1");
  // Env transport neutralized so an inherited value can't win over the file.
  expect(env.CLAUDE_PEERS_FORCE_GROUP).toBe("");

  cleanup();
  expect(existsSync(filePath)).toBe(false);
});

test("env transport fallback when the secret file cannot be written", () => {
  const scope = computeScope("/home/u/proj", "team-alpha");
  // A non-existent nested dir makes openSync throw -> env fallback.
  const { env } = buildScopeEnv(scope, {
    dir: join(tmpdir(), "no-such-dir-xyz", "deeper", String(Date.now()))
  });

  expect(env.CLAUDE_PEERS_FORCE_GROUP).toBe("team-alpha");
  expect(env.CLAUDE_PEERS_FORCE_GROUP_FILE).toBe("");
  expect(env.CLAUDE_PEERS_FORCE_GROUP_NAME).toBe(scope.name);
  expect(env.CLAUDE_PEERS_STATUS_LINE_CACHE).toBe("1");
});

// ----- parseCliContext -----

test("env vars take precedence for project dir and scope id", () => {
  const ctx = parseCliContext([], {
    CLAUDE_PEERS_DESK_PROJECT_DIR: "/work/repo",
    CLAUDE_PEERS_DESK_SCOPE_ID: "myscope"
  } as NodeJS.ProcessEnv);
  expect(ctx.projectDir).toBe("/work/repo");
  expect(ctx.scopeId).toBe("myscope");
});

test("--scope argv flag is honoured when the env var is absent", () => {
  const eq = parseCliContext(["--scope=fromarg"], {} as NodeJS.ProcessEnv);
  expect(eq.scopeId).toBe("fromarg");
  const sp = parseCliContext(["--scope", "spaced"], {} as NodeJS.ProcessEnv);
  expect(sp.scopeId).toBe("spaced");
  // No project dir env => falls back to the process cwd.
  expect(eq.projectDir).toBe(process.cwd());
});

test("empty scope env var resolves to no scope id (ephemeral)", () => {
  const ctx = parseCliContext([], {
    CLAUDE_PEERS_DESK_SCOPE_ID: ""
  } as NodeJS.ProcessEnv);
  expect(ctx.scopeId).toBeUndefined();
});
