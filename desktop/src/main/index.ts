import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, safeStorage, shell } from 'electron'
import type { AppConfig } from '@shared/types'
import { loadConfig, saveConfig } from './store'
import { buildAppMenu } from './menu'
import { SessionService } from './session-service'
import { registerIpc } from './ipc'
import { parseCliContext } from './cli-context'
import { computeScope, buildScopeEnv, resolveAdoptedScope, type Scope, type ScopeEnv } from './scope'
import {
  rememberScopeSecret,
  recallScopeSecret,
  type SecretCipher
} from './scope-secrets'
import { resolveLaunchConfig } from './launch-config'
import { WorkspaceService } from './workspace-service'
import { resolveBrokerEndpoint, sendAnnounce } from './broker-client'
import { composeJoinAnnounce, type JoinAnnounceIntent } from '@shared/announce'
import { APP_STATE_SUBDIR, runDataMigration } from './migrate-data-dir'

let mainWindow: BrowserWindow | null = null

// Harmonize the app-data folder on a single "claude-peers-desk" root (it was
// historically split: Electron userData in "claude-peers-deck", launch config +
// templates in "claude-peers-desk"). Must run before any getPath('userData') /
// loadConfig() below. App state now lives under <userData>/config to avoid
// colliding with the launch config.json at the root.
app.setName('claude-peers-desk')
runDataMigration({ userDataDir: app.getPath('userData') })

// Resolve the launch context (invocation cwd + optional custom scope id) and
// scope new sessions to that project dir. The override stays in-memory so the
// app-wide config.json is not polluted with one project's directory.
const cliContext = parseCliContext(process.argv, process.env)
let config: AppConfig = { ...loadConfig(), projectDir: cliContext.projectDir }

// The isolated forced group every session shares + the child env that pins them
// to it. The secret lives only here + in a chmod-600 temp file. Both are MUTABLE
// so a freshly-opened (empty) app can adopt a restored workspace's scope without
// relaunching (DESIGN 6.6).
let activeScope: Scope = computeScope(cliContext.projectDir, cliContext.scopeId)
let activeScopeEnv: ScopeEnv = buildScopeEnv(activeScope)

// D8: remember a custom scope's secret on this machine (encrypted via the OS
// credential store) so a custom-scope workspace can be restored without
// re-supplying the secret via the launch arg. Keyed by groupId in userData.
const secretCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (buf) => safeStorage.decryptString(buf)
}
const secretsDir = (): string => join(app.getPath('userData'), APP_STATE_SUBDIR)

// If this window was launched with a custom scope, remember its secret (opt-out
// via the rememberScopeSecrets setting). The plaintext never hits disk -- only
// the encrypted blob, in a userData file separate from the workspace JSON.
if (activeScope.scopeKind === 'custom' && config.rememberScopeSecrets) {
  try {
    rememberScopeSecret(secretsDir(), secretCipher, activeScope.groupId, activeScope.secret)
  } catch (e) {
    console.error('[claude-peers-desk] could not remember scope secret:', e)
  }
}

// Resolve the base command each session runs (project-local > global > default).
const launchConfig = resolveLaunchConfig(cliContext.projectDir)

const getConfig = (): AppConfig => config
const setConfig = (patch: Partial<AppConfig>): AppConfig => {
  config = { ...config, ...patch }
  saveConfig(config)
  nativeTheme.themeSource = config.theme
  mainWindow?.webContents.send('config:changed', config)
  return config
}

// Embedded plugin shipping the SessionStart back-channel hook, loaded into every
// Deck session via --plugin-dir so a /clear-minted session id is captured at save
// (see desk-backchannel-hook + SessionService.refreshLiveSessionIds). Resolved
// like ipc.ts locales: from process.resourcesPath when packaged, the app dir in
// dev. Empty when the dir is missing (build skipped) so the spawn never breaks.
const deckPluginDir = ((): string => {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'deck-plugin')
    : join(app.getAppPath(), 'deck-plugin')
  return existsSync(dir) ? dir : ''
})()

const service = new SessionService(
  getConfig,
  () => activeScopeEnv.env,
  launchConfig.launchCommand,
  deckPluginDir
)

// Outbound megaphone: broadcast a system message to every active peer in this
// window's forced group via the broker /announce endpoint. Best-effort -- an
// announce must never crash the main process. Returns the peers it reached.
const broadcastAnnounce = async (text: string, excludePeerId?: string): Promise<number> => {
  if (!text.trim()) return 0
  try {
    const { sent } = await sendAnnounce(
      { groupId: activeScope.groupId, secret: activeScope.secret, text, excludePeerId },
      { endpoint: resolveBrokerEndpoint() }
    )
    return sent
  } catch (e) {
    console.error('[claude-peers-desk] announce failed:', e)
    return 0
  }
}

// Auto join announce: when a fresh session's peer_id first resolves, tell the
// other peers a newcomer joined (excluding the joiner itself). Fire-and-forget,
// never on the spawn critical path.
service.on('peer-resolved', ({ peerId, intent }: { peerId: string; intent: JoinAnnounceIntent }) => {
  void broadcastAnnounce(composeJoinAnnounce(peerId, intent), peerId)
})

/**
 * Adopt a restored workspace's scope. No-op once a session is running (the scope
 * is fixed at first spawn). Ephemeral workspaces mint a fresh secret; a custom
 * one is only reused if its groupId matches the launched scope (DESIGN 6.8).
 */
const adoptScope = (ws: { groupId: string; scopeKind: 'ephemeral' | 'custom' }): void => {
  if (service.hasLiveSessions()) return
  let next = resolveAdoptedScope(ws, activeScope, cliContext.projectDir)
  // D8: resolveAdoptedScope falls back to a fresh ephemeral when the launched
  // scope does not match the workspace's custom group. If we remembered that
  // group's secret, rebuild the scope from it to rejoin the same group.
  if (next.groupId !== ws.groupId && ws.scopeKind === 'custom' && config.rememberScopeSecrets) {
    const remembered = recallScopeSecret(secretsDir(), secretCipher, ws.groupId)
    if (remembered) next = computeScope(cliContext.projectDir, remembered)
  }
  if (next === activeScope) return
  activeScopeEnv.cleanup()
  activeScope = next
  activeScopeEnv = buildScopeEnv(activeScope)
}

const workspaces = new WorkspaceService({
  projectDir: cliContext.projectDir,
  service,
  getConfig,
  setConfig: (patch) => void setConfig(patch),
  getScope: () => activeScope,
  adoptScope
})

// Grey out File > Export template... when there is nothing to export. Kept in
// sync with the live session list (separate from the auto-save handler below,
// which early-returns on the empty list -- exactly when we must DISABLE).
const syncExportTemplateEnabled = (): void => {
  const item = Menu.getApplicationMenu()?.getMenuItemById('export-template')
  if (item) item.enabled = service.list().length > 0
}
service.on('changed', syncExportTemplateEnabled)

// Continuously auto-save the live workspace (debounced) as sessions change, but
// only once there ARE sessions -- launching empty must not mint/clobber a
// workspace (the previous run stays restorable until the user acts).
let autoSaveTimer: NodeJS.Timeout | null = null
service.on('changed', (sessions: unknown[]) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    // A workspace I/O error must never take down the main process.
    try {
      const summary = workspaces.saveAuto()
      // Keep the renderer's window title in sync with the current workspace.
      mainWindow?.webContents.send('workspace:current', summary)
    } catch (e) {
      console.error('[claude-peers-desk] auto-save failed:', e)
    }
  }, 1000)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: config.theme === 'light' ? '#f5f5f5' : '#1e1e1e',
    title: 'Claude Peers Deck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links (e.g. OAuth completion pages) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = config.theme
  // Tailored menu (drops the confusing default Edit roles); no auto-open DevTools.
  // "New (clear)" routes through the renderer so it can confirm before clearing.
  const toRenderer = (channel: string, payload?: unknown): void =>
    mainWindow?.webContents.send(channel, payload)
  Menu.setApplicationMenu(
    buildAppMenu({
      onOpenSettings: () => toRenderer('menu:settings'),
      onNewClear: () => toRenderer('menu:new-clear'),
      onSave: () => toRenderer('menu:save'),
      onSaveAs: () => toRenderer('menu:save-as'),
      onRestore: () => toRenderer('menu:restore'),
      onListWorkspaces: () => toRenderer('menu:list'),
      onExportTemplate: () => toRenderer('menu:export-template'),
      onImportTemplate: () => toRenderer('menu:import-template')
    })
  )
  // Reflect the initial session count on the Export-template menu item (the app
  // starts empty, so it begins disabled).
  syncExportTemplateEnabled()
  registerIpc({
    service,
    workspaces,
    getConfig,
    setConfig,
    getWindow: () => mainWindow,
    announce: (text: string) => broadcastAnnounce(text)
  })
  service.start()
  // Attach an auto-save workspace capturing whatever the service just restored.
  workspaces.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    workspaces.releaseOnQuit()
    service.stop()
    app.quit()
  }
})

app.on('before-quit', () => {
  workspaces.releaseOnQuit()
  service.stop()
  activeScopeEnv.cleanup()
})
