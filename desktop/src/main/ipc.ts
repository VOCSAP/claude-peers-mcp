import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { AppConfig, CreateSessionInput, I18nPayload, LaunchConfig } from '@shared/types'
import type { SessionService } from './session-service'
import { listAgents } from './agents'
import { resolveLaunchConfig, saveGlobalConfig } from './launch-config'
import { loadDict, resolveLocale } from './i18n'

/**
 * Build the renderer i18n payload from the current config. Reads shipped locale
 * files (resources dir when packaged, app dir in dev) plus a user-override dir
 * under userData, then falls back to the embedded English base for any gap.
 */
function buildI18n(config: AppConfig): I18nPayload {
  const locale = resolveLocale(config.locale, app.getLocale())
  const shippedDir = app.isPackaged
    ? join(process.resourcesPath, 'locales')
    : join(app.getAppPath(), 'locales')
  const userDir = join(app.getPath('userData'), 'locales')
  return { locale, dict: loadDict(locale, [shippedDir, userDir]) }
}

interface IpcDeps {
  service: SessionService
  getConfig: () => AppConfig
  setConfig: (patch: Partial<AppConfig>) => AppConfig
  getWindow: () => BrowserWindow | null
}

export function registerIpc({ service, getConfig, setConfig, getWindow }: IpcDeps): void {
  // ----- sessions -----
  ipcMain.handle('sessions:list', () => service.list())
  ipcMain.handle('sessions:create', (_e, input: CreateSessionInput) => service.create(input ?? {}))
  ipcMain.handle('sessions:remove', (_e, id: string) => service.remove(id))
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => service.rename(id, name))
  ipcMain.handle('sessions:set-color', (_e, id: string, color: string) =>
    service.setColor(id, color)
  )
  ipcMain.handle('sessions:restart', (_e, id: string) => service.restart(id))

  // ----- pty io (fire-and-forget) -----
  ipcMain.on('pty:input', (_e, id: string, data: string) => service.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    service.resize(id, cols, rows)
  )

  // ----- config -----
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => setConfig(patch ?? {}))
  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getConfig().projectDir
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // ----- i18n -----
  ipcMain.handle('i18n:get', () => buildI18n(getConfig()))

  // ----- create-menu data -----
  ipcMain.handle('agents:list', () => listAgents(getConfig().projectDir))
  ipcMain.handle('launch:get', () => resolveLaunchConfig(getConfig().projectDir))
  ipcMain.handle('launch:set-global', (_e, cfg: LaunchConfig) => saveGlobalConfig(cfg))

  // ----- forward service events to the renderer -----
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }
  service.on('data', (e) => send('pty:data', e))
  service.on('exit', (e) => send('pty:exit', e))
  service.on('changed', (sessions) => send('sessions:changed', sessions))
  service.on('thinking', (e) => send('session:thinking', e))
}
