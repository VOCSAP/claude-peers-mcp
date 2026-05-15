#!/usr/bin/env bun
/**
 * claude-peers hook installer.
 *
 * Copies `hook-session-end-peers.sh` from the repo root to
 * `~/.claude/hooks/session-end-peers.sh` and registers a SessionEnd entry in
 * `~/.claude/settings.json` (or `%USERPROFILE%\.claude\settings.json`).
 * Idempotent: rerun without effect if already installed.
 *
 * Usage:
 *   bun install-hook.ts             install
 *   bun install-hook.ts --uninstall remove
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------
const homeBase = process.env.USERPROFILE ?? homedir();
const SETTINGS_PATH = join(homeBase, ".claude", "settings.json");
const HOOKS_DIR = join(homeBase, ".claude", "hooks");
const HOOK_FILENAME = "session-end-peers.sh";
const HOOK_INSTALLED_PATH = join(HOOKS_DIR, HOOK_FILENAME);

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE_PATH = join(REPO_ROOT, "hook-session-end-peers.sh");

// Platform-specific command registered in settings.json.
// Use env var REFERENCES (not expanded) so the hook path survives repo moves,
// as long as the hook is reinstalled into the user's hooks directory.
const PLATFORM_CMD: string =
  process.platform === "win32"
    ? `bash "$USERPROFILE/.claude/hooks/session-end-peers.sh"`
    : `bash "$HOME/.claude/hooks/session-end-peers.sh"`;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
interface HookCmd { type: string; command: string; timeout?: number }
interface HookEntry { hooks?: HookCmd[] }
interface Settings { hooks?: { SessionEnd?: HookEntry[]; [k: string]: HookEntry[] | undefined }; [k: string]: unknown }

// ------------------------------------------------------------------
// Settings helpers
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// install / uninstall
// ------------------------------------------------------------------
function install(): "installed" | "already-installed" {
  // 1. Copy .sh to ~/.claude/hooks/ (normalize CRLF -> LF).
  const source = readFileSync(HOOK_SOURCE_PATH, "utf-8").replace(/\r\n/g, "\n");
  mkdirSync(HOOKS_DIR, { recursive: true });
  writeFileSync(HOOK_INSTALLED_PATH, source, { encoding: "utf-8" });
  try { chmodSync(HOOK_INSTALLED_PATH, 0o755); } catch { /* Windows: no-op */ }

  // 2. Register in settings.json if not already present.
  const s = loadSettings();
  s.hooks ??= {};
  const arr = (s.hooks.SessionEnd ??= []) as HookEntry[];
  if (arr.some(entryReferencesOurHook)) return "already-installed";
  arr.push({
    hooks: [{ type: "command", command: PLATFORM_CMD, timeout: 5 }],
  });
  saveSettings(s);
  return "installed";
}

function uninstall(): "uninstalled" | "not-present" {
  let removed = false;

  // 1. Remove the installed .sh file.
  if (existsSync(HOOK_INSTALLED_PATH)) {
    try { rmSync(HOOK_INSTALLED_PATH); removed = true; } catch { /* */ }
  }

  // 2. Remove the entry from settings.json.
  const s = loadSettings();
  const arr = (s.hooks?.SessionEnd ?? []) as HookEntry[];
  const before = arr.length;
  const after = arr.filter((e) => !entryReferencesOurHook(e));
  if (after.length < before) {
    if (s.hooks) s.hooks.SessionEnd = after;
    saveSettings(s);
    removed = true;
  }

  return removed ? "uninstalled" : "not-present";
}

// ------------------------------------------------------------------
// CLI entry
// ------------------------------------------------------------------
const action = process.argv.includes("--uninstall") ? uninstall() : install();
console.log(action);
process.exit(0);
