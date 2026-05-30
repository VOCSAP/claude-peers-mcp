import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import type { AppConfig } from '@shared/types'
import { loadConfig, saveConfig } from './store'
import { SessionService } from './session-service'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let config: AppConfig = loadConfig()

const getConfig = (): AppConfig => config
const setConfig = (patch: Partial<AppConfig>): AppConfig => {
  config = { ...config, ...patch }
  saveConfig(config)
  nativeTheme.themeSource = config.theme
  mainWindow?.webContents.send('config:changed', config)
  return config
}

const service = new SessionService(getConfig)

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
  registerIpc({ service, getConfig, setConfig, getWindow: () => mainWindow })
  service.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    service.stop()
    app.quit()
  }
})

app.on('before-quit', () => service.stop())
