import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeCwdKey, isPeerIdCacheEnabled, writePeerIdCache } from "../shared/peer-cache";

const ENABLED_ENV = { CLAUDE_PEERS_STATUS_LINE_CACHE: "1" };

describe("computeCwdKey", () => {
  test("short path is sanitized verbatim (matches MSYS2 fallback)", () => {
    expect(computeCwdKey("/foo/bar")).toBe("_foo_bar");
  });

  test("path longer than 40 chars is truncated to last 40", () => {
    const cwd = "/very/long/path/" + "x".repeat(60);
    const key = computeCwdKey(cwd);
    expect(key.length).toBe(40);
    expect(key).toBe(cwd.replace(/[^a-zA-Z0-9-]/g, "_").slice(-40));
  });

  test("preserves alphanumerics and hyphens, replaces all else with _", () => {
    expect(computeCwdKey("D:\\AI\\MCPServer\\claude-peers-mcp")).toBe(
      "D__AI_MCPServer_claude-peers-mcp",
    );
  });

  test("path exactly 40 chars after sanitization is returned verbatim", () => {
    const s = "a".repeat(40);
    expect(computeCwdKey(s)).toBe(s);
  });

  test("path 41 chars after sanitization keeps trailing 40", () => {
    const s = "a" + "b".repeat(40);
    expect(computeCwdKey(s)).toBe("b".repeat(40));
  });
});

describe("writePeerIdCache", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "cp-cache-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("writes peer_id to ~/.claude/peers/peer-id-<key>.txt", async () => {
    await writePeerIdCache("D:\\AI\\MCPServer\\claude-peers-mcp", "test-peer-1", tmpHome, ENABLED_ENV);
    const expected = join(
      tmpHome,
      ".claude",
      "peers",
      "peer-id-D__AI_MCPServer_claude-peers-mcp.txt",
    );
    expect(await readFile(expected, "utf-8")).toBe("test-peer-1");
  });

  test("creates parent directory recursively when missing", async () => {
    await writePeerIdCache("/foo/bar", "peer-x", tmpHome, ENABLED_ENV);
    const dir = join(tmpHome, ".claude", "peers");
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await readFile(join(dir, "peer-id-_foo_bar.txt"), "utf-8")).toBe("peer-x");
  });

  test("overwrites an existing stale value", async () => {
    await writePeerIdCache("/repo", "old-peer", tmpHome, ENABLED_ENV);
    await writePeerIdCache("/repo", "new-peer", tmpHome, ENABLED_ENV);
    const file = join(tmpHome, ".claude", "peers", "peer-id-_repo.txt");
    expect(await readFile(file, "utf-8")).toBe("new-peer");
  });

  test("silently swallows errors when home is unwritable", async () => {
    // An invalid home path must not throw -- best-effort cache.
    await expect(
      writePeerIdCache("/foo", "peer-y", "\0not-a-real-home", ENABLED_ENV),
    ).resolves.toBeUndefined();
  });

  test("is a no-op when env var is unset (opt-in by default)", async () => {
    await writePeerIdCache("/foo/bar", "peer-z", tmpHome, {});
    // No file should be written, no directory should be created.
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });

  test("is a no-op when env var is set to a falsy string", async () => {
    await writePeerIdCache("/foo/bar", "peer-z", tmpHome, { CLAUDE_PEERS_STATUS_LINE_CACHE: "0" });
    await expect(stat(join(tmpHome, ".claude"))).rejects.toThrow();
  });
});

describe("isPeerIdCacheEnabled", () => {
  test("returns false when env var is unset", () => {
    expect(isPeerIdCacheEnabled({})).toBe(false);
  });

  test.each([["1"], ["true"], ["TRUE"], ["yes"], ["on"], ["On"]])(
    "returns true for truthy value %s",
    (value) => {
      expect(isPeerIdCacheEnabled({ CLAUDE_PEERS_STATUS_LINE_CACHE: value })).toBe(true);
    },
  );

  test.each([["0"], ["false"], ["no"], ["off"], [""], ["bogus"]])(
    "returns false for falsy value %s",
    (value) => {
      expect(isPeerIdCacheEnabled({ CLAUDE_PEERS_STATUS_LINE_CACHE: value })).toBe(false);
    },
  );
});
