import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  CreateSessionInput,
  DeckApi,
  PtyDataEvent,
  PtyExitEvent,
  SessionRuntime,
  SessionThinkingEvent
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Multiplex a high-cardinality channel: a single ipcRenderer.on fans out to a
 * Set of subscriber callbacks. Keeps the ipcRenderer listener count at one per
 * channel regardless of how many tiles subscribe (avoids MaxListenersExceeded).
 */
function multiplex<T>(channel: string): (cb: (payload: T) => void) => () => void {
  const subscribers = new Set<(payload: T) => void>()
  ipcRenderer.on(channel, (_e, payload: T) => {
    for (const cb of subscribers) {
      try {
        cb(payload)
      } catch (err) {
        // One bad subscriber must not break dispatch to the others.
        console.error(`[preload] ${channel} subscriber threw:`, err)
      }
    }
  })
  return (cb) => {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }
}

const onPtyDataMux = multiplex<PtyDataEvent>('pty:data')
const onPtyExitMux = multiplex<PtyExitEvent>('pty:exit')

const api: DeckApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (input: CreateSessionInput) => ipcRenderer.invoke('sessions:create', input),
  removeSession: (id: string) => ipcRenderer.invoke('sessions:remove', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
  setSessionColor: (id: string, color: string) =>
    ipcRenderer.invoke('sessions:set-color', id, color),
  restartSession: (id: string) => ipcRenderer.invoke('sessions:restart', id),

  ptyInput: (id: string, data: string) => ipcRenderer.send('pty:input', id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:set', patch),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  onPtyData: (cb: (e: PtyDataEvent) => void) => onPtyDataMux(cb),
  onPtyExit: (cb: (e: PtyExitEvent) => void) => onPtyExitMux(cb),
  onSessionsChanged: (cb: (sessions: SessionRuntime[]) => void) =>
    subscribe('sessions:changed', cb),
  onSessionThinking: (cb: (e: SessionThinkingEvent) => void) =>
    subscribe('session:thinking', cb),
  onConfigChanged: (cb: (config: AppConfig) => void) => subscribe('config:changed', cb)
}

contextBridge.exposeInMainWorld('api', api)
