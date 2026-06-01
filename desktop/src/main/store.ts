import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, SessionDef } from '@shared/types'

const DEFAULT_CONFIG: AppConfig = {
  projectDir: homedir(),
  // The `claudepeers` alias on the user's machine. Wrapped in a login/interactive
  // shell (see pty-manager) so the alias resolves.
  peerCommand: 'claudepeers',
  shell: '',
  interactiveShell: false,
  columns: 2,
  displayMode: '2x2',
  gridCols: 2,
  gridRows: 2,
  theme: 'dark',
  fontSize: 13,
  restoreSessions: true
}

function dataDir(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    console.error('[store] write failed:', file, err)
  }
}

const configPath = (): string => join(dataDir(), 'config.json')
const sessionsPath = (): string => join(dataDir(), 'sessions.json')

export function loadConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<AppConfig>>(configPath(), {}) }
}

export function saveConfig(cfg: AppConfig): void {
  writeJson(configPath(), cfg)
}

export function loadSessions(): SessionDef[] {
  const raw = readJson<SessionDef[]>(sessionsPath(), [])
  return Array.isArray(raw) ? raw : []
}

export function saveSessions(sessions: SessionDef[]): void {
  writeJson(sessionsPath(), sessions)
}

export { DEFAULT_CONFIG }
