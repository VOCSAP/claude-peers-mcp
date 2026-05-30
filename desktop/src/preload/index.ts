import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  CreateSessionInput,
  DeckApi,
  PtyDataEvent,
  PtyExitEvent,
  SessionRuntime
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DeckApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (input: CreateSessionInput) => ipcRenderer.invoke('sessions:create', input),
  removeSession: (id: string) => ipcRenderer.invoke('sessions:remove', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
  restartSession: (id: string) => ipcRenderer.invoke('sessions:restart', id),

  ptyInput: (id: string, data: string) => ipcRenderer.send('pty:input', id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:set', patch),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  onPtyData: (cb: (e: PtyDataEvent) => void) => subscribe('pty:data', cb),
  onPtyExit: (cb: (e: PtyExitEvent) => void) => subscribe('pty:exit', cb),
  onSessionsChanged: (cb: (sessions: SessionRuntime[]) => void) =>
    subscribe('sessions:changed', cb),
  onConfigChanged: (cb: (config: AppConfig) => void) => subscribe('config:changed', cb)
}

contextBridge.exposeInMainWorld('api', api)
