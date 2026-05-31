// Resolves the command the Deck runs in each session PTY, plus optional launch
// presets. First-wins precedence (DESIGN / PLAN §5):
//   1. project-local <projectDir>/.claude/claude-peers/config.json
//   2. global %APPDATA%\claude-peers-desk\config.json  (XDG equiv on Unix)
//   3. built-in default
//
// Pure node builtins only (no electron) so it is unit-testable and the global
// path is derived from env rather than app.getPath.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_LAUNCH_COMMAND =
  'claude --dangerously-load-development-channels server:claude-peers'

export interface LaunchPreset {
  label: string
  /** Extra args appended after --session-id on a fresh launch. */
  args: string
  /** Optional prompt to send once the session is ready (used by the UI, M5). */
  prompt?: string
}

export interface LaunchConfig {
  launchCommand: string
  presets: LaunchPreset[]
}

function globalConfigDir(env: NodeJS.ProcessEnv): string {
  if (platform() === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-peers-desk')
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-peers-desk')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'config.json')
}

export function localConfigPath(projectDir: string): string {
  return join(projectDir, '.claude', 'claude-peers', 'config.json')
}

function isPreset(p: unknown): p is LaunchPreset {
  return (
    !!p &&
    typeof p === 'object' &&
    typeof (p as LaunchPreset).label === 'string' &&
    typeof (p as LaunchPreset).args === 'string'
  )
}

/** Read + validate one config file. Missing or malformed => null (treated as absent). */
function readConfigFile(file: string): Partial<LaunchConfig> | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    const out: Partial<LaunchConfig> = {}
    if (typeof raw.launchCommand === 'string' && raw.launchCommand.trim()) {
      out.launchCommand = raw.launchCommand.trim()
    }
    if (Array.isArray(raw.presets)) {
      out.presets = raw.presets.filter(isPreset)
    }
    return out
  } catch {
    return null
  }
}

export function resolveLaunchConfig(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): LaunchConfig {
  const merged: LaunchConfig = { launchCommand: DEFAULT_LAUNCH_COMMAND, presets: [] }
  // global first, then local (local wins).
  for (const src of [readConfigFile(globalConfigPath(env)), readConfigFile(localConfigPath(projectDir))]) {
    if (!src) continue
    if (src.launchCommand) merged.launchCommand = src.launchCommand
    if (src.presets) merged.presets = src.presets
  }
  return merged
}

/** Create the project-local config on demand (UI action). No-op if it exists. */
export function createLocalConfig(projectDir: string): string {
  const file = localConfigPath(projectDir)
  if (existsSync(file)) return file
  mkdirSync(dirname(file), { recursive: true })
  const template: LaunchConfig = { launchCommand: DEFAULT_LAUNCH_COMMAND, presets: [] }
  writeFileSync(file, JSON.stringify(template, null, 2), 'utf-8')
  return file
}

/** Persist the global launch config (Settings dialog, M5). */
export function saveGlobalConfig(cfg: LaunchConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = globalConfigPath(env)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8')
  return file
}
