// The Deck starting the loopback broker itself (desktop/src/main/broker-spawn.ts):
// where the script comes from (global config only), when a spawn happens, and
// how often a dead broker is relaunched.

import { test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  ensureLoopbackBroker,
  locateBrokerScript,
  RespawnThrottle,
  type EnsureDeps,
} from "../desktop/src/main/broker-spawn";

const CLAUDE_JSON = "/home/op/.claude.json";
const APP_ROOT = "/opt/koryphaios/desktop";

function locateDeps(files: Record<string, string>, existing: string[]) {
  const reads: string[] = [];
  const warnings: string[] = [];
  return {
    reads,
    warnings,
    deps: {
      readFile: (p: string) => {
        reads.push(p);
        return files[p] ?? null;
      },
      exists: (p: string) => existing.includes(p),
      homeDir: "/home/op",
      warn: (m: string) => warnings.push(m),
    },
  };
}

test("the script is the sibling of the server.ts named by the user-scope claude.json entry", () => {
  const { deps, reads } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "/usr/local/bin/bun", args: ["/home/op/koryphaios/server.ts"] } } }) },
    ["/home/op/koryphaios/broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps), "the global MCP entry decides the script and the executable").toEqual({
    script: "/home/op/koryphaios/broker.ts",
    command: "/usr/local/bin/bun",
    source: "claude-json",
  });
  expect(reads, "only the user-scope claude.json is ever read, never a project .mcp.json").toEqual([CLAUDE_JSON]);
});

test("a hand-written tilde path is expanded against the operator's home", () => {
  const { deps } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["~/koryphaios/server.ts"] } } }) },
    ["/home/op/koryphaios/broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps)?.script, "a tilde no filesystem call expands must be resolved before the existence check").toBe(
    "/home/op/koryphaios/broker.ts"
  );
});

test("a Windows-style server.ts path resolves to its sibling too", () => {
  const { deps } = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["C:\\Users\\op\\koryphaios\\server.ts"] } } }) },
    ["C:\\Users\\op\\koryphaios\\broker.ts"]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, deps)?.script, "a backslash path keeps its separators and swaps the file name").toBe(
    "C:\\Users\\op\\koryphaios\\broker.ts"
  );
});

test("without a usable entry the repository the Deck lives in is tried, then nothing", () => {
  const sibling = resolve(APP_ROOT, "..", "broker.ts");
  const noEntry = locateDeps({ [CLAUDE_JSON]: JSON.stringify({ mcpServers: {} }) }, [sibling]);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, noEntry.deps), "the Deck's own repository is the fallback").toEqual({
    script: sibling,
    command: "bun",
    source: "app-root",
  });
  const nothing = locateDeps({}, []);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, nothing.deps), "no script anywhere is an explicit null, not a guess").toBeNull();
});

test("an entry whose server.ts sibling does not exist is not trusted, and invalid JSON is traced then bypassed", () => {
  const sibling = resolve(APP_ROOT, "..", "broker.ts");
  const missing = locateDeps(
    { [CLAUDE_JSON]: JSON.stringify({ mcpServers: { "claude-peers": { command: "bun", args: ["/gone/server.ts"] } } }) },
    [sibling]
  );
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, missing.deps)?.source, "a stale entry falls through to the repository").toBe("app-root");
  const invalid = locateDeps({ [CLAUDE_JSON]: "{ not json" }, [sibling]);
  expect(locateBrokerScript(CLAUDE_JSON, APP_ROOT, invalid.deps)?.source, "invalid JSON still reaches the fallback").toBe("app-root");
  expect(invalid.warnings.length, "the unreadable claude.json is traced, never swallowed").toBe(1);
});

function ensureDeps(overrides: Partial<EnsureDeps> & { aliveAfterPolls?: number }) {
  const spawned: string[] = [];
  let polls = 0;
  const aliveAfter = overrides.aliveAfterPolls ?? Number.POSITIVE_INFINITY;
  const deps: EnsureDeps = {
    isAlive: async () => {
      polls += 1;
      return polls > aliveAfter;
    },
    locate: () => ({ script: "/x/broker.ts", command: "bun", source: "claude-json" }),
    spawn: (command, script) => {
      spawned.push(`${command} ${script}`);
    },
    sleep: async () => {},
    attempts: 3,
    pollMs: 1,
    ...overrides,
  };
  return { deps, spawned, polls: () => polls };
}

test("remote mode never spawns nor even probes: a loopback process would not serve that URL", async () => {
  const { deps, spawned, polls } = ensureDeps({});
  expect(await ensureLoopbackBroker("remote", "http://broker.example:7899", deps)).toEqual({ action: "skipped", reason: "remote-mode" });
  expect([spawned, polls()], "nothing is spawned and nothing is probed in remote mode").toEqual([[], 0]);
});

test("an answering broker is left alone", async () => {
  const { deps, spawned } = ensureDeps({ aliveAfterPolls: 0 });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", deps)).toEqual({ action: "already-running" });
  expect(spawned, "no second broker is spawned next to a live one").toEqual([]);
});

test("a silent loopback is spawned from the located script and reported once /health answers", async () => {
  const { deps, spawned } = ensureDeps({ aliveAfterPolls: 2 });
  expect(await ensureLoopbackBroker("replica", "http://127.0.0.1:7899", deps)).toEqual({
    action: "started",
    script: "/x/broker.ts",
    source: "claude-json",
  });
  expect(spawned, "the MCP entry's executable runs the sibling broker.ts").toEqual(["bun /x/broker.ts"]);
});

test("no script, a spawn that throws, or a broker that never answers are three distinct explicit failures", async () => {
  const none = ensureDeps({ locate: () => null });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", none.deps)).toEqual({ action: "not-found" });
  const enoent = ensureDeps({ spawn: () => { throw new Error("spawn bun ENOENT"); } });
  expect(await ensureLoopbackBroker("local", "http://127.0.0.1:7899", enoent.deps)).toEqual({
    action: "failed",
    script: "/x/broker.ts",
    reason: "spawn bun ENOENT",
  });
  const mute = ensureDeps({});
  const outcome = await ensureLoopbackBroker("local", "http://127.0.0.1:7899", mute.deps);
  expect([outcome.action, mute.polls()], "the poll budget is spent then the failure is named").toEqual(["failed", 4]);
});

test("a respawn is allowed once per interval, never on every failing poll", () => {
  let clock = 0;
  const throttle = new RespawnThrottle(60_000, () => clock);
  expect(throttle.allow(), "the first outage may respawn").toBe(true);
  clock = 30_000;
  expect(throttle.allow(), "half an interval later is too soon").toBe(false);
  clock = 60_000;
  expect(throttle.allow(), "a full interval later may respawn again").toBe(true);
});
