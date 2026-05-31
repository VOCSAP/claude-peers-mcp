import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveGroup,
  resolveGroupName,
  computeGroupId,
  computeGroupSecretHash,
} from "../shared/config.ts";

// M1: the Claude Peers Desk app forces its child sessions into an isolated group
// via CLAUDE_PEERS_FORCE_GROUP (env) or CLAUDE_PEERS_FORCE_GROUP_FILE (file, env
// wins). This branch is top-precedence in resolveGroup / resolveGroupName,
// bypassing project files, default_group and CLAUDE_PEERS_GROUP. These are unit
// tests on the resolver functions directly (no broker).
//
// Fixture group passphrases below are throwaway test strings, not real
// credentials.

// All env keys the forced-group path or the legacy path may read. Snapshotted
// and restored around every test so cases never leak into each other or inherit
// the developer's shell.
const ENV_KEYS = [
  "CLAUDE_PEERS_FORCE_GROUP",
  "CLAUDE_PEERS_FORCE_GROUP_FILE",
  "CLAUDE_PEERS_FORCE_GROUP_NAME",
  "CLAUDE_PEERS_GROUP",
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "cp-force-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const FORCED = "forced-group-passphrase";

// A project dir holding a .claude-peers.json. Used to prove the forced branch
// overrides a competing project-file source.
function projectDirWithFile(group: string): string {
  const dir = mkdtempSync(join(tmpDir, "proj-"));
  writeFileSync(join(dir, ".claude-peers.json"), JSON.stringify({ group }), "utf-8");
  return dir;
}

test("forced env wins over project file, default_group and CLAUDE_PEERS_GROUP", () => {
  const dir = projectDirWithFile("from-project-file");
  process.env.CLAUDE_PEERS_GROUP = "from-env-group";
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;

  const userConfig = {
    groups: { "from-project-file": "pf-pass", team: "team-pass" },
    default_group: "team",
  };

  const name = resolveGroupName(dir, dir, userConfig);
  const resolved = resolveGroup(dir, dir, userConfig);

  expect(name).toBe(`forced-${computeGroupId(FORCED).slice(0, 8)}`);
  expect(resolved.name).toBe(name);
  expect(resolved.group_id).toBe(computeGroupId(FORCED));
});

test("forced file is used when only the file is set", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, FORCED, "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null });

  expect(resolved.group_id).toBe(computeGroupId(FORCED));
  expect(resolved.group_secret_hash).toBe(computeGroupSecretHash(FORCED));
});

test("env wins over file when both are set", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, "file-pass", "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;
  process.env.CLAUDE_PEERS_FORCE_GROUP = "env-pass";

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null });

  expect(resolved.group_id).toBe(computeGroupId("env-pass"));
  expect(resolved.group_id).not.toBe(computeGroupId("file-pass"));
});

test("group_id and secret_hash match the compute helpers and are stable", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  const userConfig = { groups: {}, default_group: null };

  const a = resolveGroup(tmpDir, null, userConfig);
  const b = resolveGroup(tmpDir, null, userConfig);

  expect(a.group_id).toBe(computeGroupId(FORCED));
  expect(a.group_secret_hash).toBe(computeGroupSecretHash(FORCED));
  expect(a.group_id).toBe(b.group_id);
  expect(a.group_secret_hash).toBe(b.group_secret_hash);
});

test("groups_map injects the forced entry alongside default and user groups", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;

  const resolved = resolveGroup(tmpDir, null, {
    groups: { team: "team-pass" },
    default_group: null,
  });

  // default + user group preserved
  expect(resolved.groups_map.default).toBe("default");
  expect(resolved.groups_map.team).toBe(computeGroupId("team-pass"));
  // forced entry present and consistent (the core acceptance criterion)
  expect(resolved.groups_map[resolved.name]).toBe(resolved.group_id);
});

test("CLAUDE_PEERS_FORCE_GROUP_NAME overrides the default forced name", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  process.env.CLAUDE_PEERS_FORCE_GROUP_NAME = "desk-scope-42";

  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null });

  expect(resolved.name).toBe("desk-scope-42");
  expect(resolved.groups_map["desk-scope-42"]).toBe(resolved.group_id);
});

test("no forced env nor file: resolution is unchanged (backward-compat)", () => {
  const dir = projectDirWithFile("from-project-file");
  const userConfig = {
    groups: { "from-project-file": "pf-pass" },
    default_group: null,
  };

  const name = resolveGroupName(dir, dir, userConfig);
  const resolved = resolveGroup(dir, dir, userConfig);

  // The project file wins, exactly as before this change.
  expect(name).toBe("from-project-file");
  expect(resolved.name).toBe("from-project-file");
  expect(resolved.group_id).toBe(computeGroupId("pf-pass"));
});

test("empty-string forced env is treated as unset", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = "";
  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: null });

  // Falls through to the 'default' sentinel -- no forced group.
  expect(resolved.name).toBe("default");
  expect(resolved.group_id).toBe("default");
});

test("missing forced file falls through to normal resolution", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = join(tmpDir, "does-not-exist.txt");
  const resolved = resolveGroup(tmpDir, null, { groups: {}, default_group: "team" });

  // Default_group wins because the forced file is unreadable.
  expect(resolved.name).toBe("team");
});

test("file content is trimmed: trailing newline equals the bare env passphrase", () => {
  const passFile = join(tmpDir, "pass.txt");
  writeFileSync(passFile, `${FORCED}\n`, "utf-8");
  process.env.CLAUDE_PEERS_FORCE_GROUP_FILE = passFile;

  const fromFile = resolveGroup(tmpDir, null, { groups: {}, default_group: null });
  expect(fromFile.group_id).toBe(computeGroupId(FORCED));
});

test("forced name colliding with a user group overwrites it with the forced id", () => {
  process.env.CLAUDE_PEERS_FORCE_GROUP = FORCED;
  const forcedName = `forced-${computeGroupId(FORCED).slice(0, 8)}`;

  const resolved = resolveGroup(tmpDir, null, {
    groups: { [forcedName]: "other-pass" },
    default_group: null,
  });

  // Forced wins by design: the map entry is the forced group_id, not the
  // user-config group's id.
  expect(resolved.groups_map[forcedName]).toBe(resolved.group_id);
  expect(resolved.groups_map[forcedName]).not.toBe(computeGroupId("other-pass"));
});
