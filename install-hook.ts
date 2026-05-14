#!/usr/bin/env bun
/**
 * claude-peers hook installer.
 *
 * Adds / removes the `hook-session-end-peers.ts` SessionEnd entry in
 * `~/.claude/settings.json` (or `%USERPROFILE%\.claude\settings.json`).
 * Idempotent: rerun without effect if already installed.
 *
 * Usage:
 *   bun install-hook.ts             install
 *   bun install-hook.ts --uninstall remove
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SETTINGS_PATH = (() => {
  const base = process.env.USERPROFILE ?? homedir();
  return join(base, ".claude", "settings.json");
})();
const HOOK_FILENAME = "hook-session-end-peers.ts";
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const HOOK_ABS_PATH = join(REPO_ROOT, HOOK_FILENAME).replace(/\\/g, "/");

interface HookCmd { type: string; command: string; timeout?: number }
interface HookEntry { hooks?: HookCmd[] }
interface Settings { hooks?: { SessionEnd?: HookEntry[]; [k: string]: HookEntry[] | undefined }; [k: string]: unknown }

function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings; } catch { return {}; }
}

function saveSettings(s: Settings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function entryReferencesOurHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => h.command?.includes(HOOK_FILENAME));
}

function install(): "installed" | "already-installed" {
  const s = loadSettings();
  s.hooks ??= {};
  const arr = (s.hooks.SessionEnd ??= []) as HookEntry[];
  if (arr.some(entryReferencesOurHook)) return "already-installed";
  arr.push({
    hooks: [{ type: "command", command: `bun ${HOOK_ABS_PATH}`, timeout: 5 }],
  });
  saveSettings(s);
  return "installed";
}

function uninstall(): "uninstalled" | "not-present" {
  const s = loadSettings();
  const arr = (s.hooks?.SessionEnd ?? []) as HookEntry[];
  const before = arr.length;
  const after = arr.filter((e) => !entryReferencesOurHook(e));
  if (after.length === before) return "not-present";
  if (s.hooks) s.hooks.SessionEnd = after;
  saveSettings(s);
  return "uninstalled";
}

const action = process.argv.includes("--uninstall") ? uninstall() : install();
console.log(action);
process.exit(0);
