import { create } from 'zustand'
import type { AppConfig, CreateSessionInput, SessionRuntime } from '@shared/types'

interface DeckState {
  sessions: SessionRuntime[]
  config: AppConfig | null
  selectedId: string | null
  maximizedId: string | null
  settingsOpen: boolean

  init(): Promise<void>
  setSelected(id: string | null): void
  setMaximized(id: string | null): void
  openSettings(open: boolean): void

  createSession(input: CreateSessionInput): Promise<void>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  restartSession(id: string): Promise<void>
  updateConfig(patch: Partial<AppConfig>): Promise<void>
}

export const useDeck = create<DeckState>((set, get) => ({
  sessions: [],
  config: null,
  selectedId: null,
  maximizedId: null,
  settingsOpen: false,

  async init() {
    const [sessions, config] = await Promise.all([
      window.api.listSessions(),
      window.api.getConfig()
    ])
    set({
      sessions,
      config,
      selectedId: get().selectedId ?? sessions[0]?.id ?? null
    })

    window.api.onSessionsChanged((next) => {
      const { selectedId } = get()
      const stillExists = next.some((s) => s.id === selectedId)
      set({
        sessions: next,
        selectedId: stillExists ? selectedId : (next[0]?.id ?? null)
      })
    })
    window.api.onConfigChanged((next) => set({ config: next }))
  },

  setSelected: (id) => set({ selectedId: id }),
  setMaximized: (id) => set({ maximizedId: id }),
  openSettings: (open) => set({ settingsOpen: open }),

  async createSession(input) {
    const created = await window.api.createSession(input)
    set({ selectedId: created.id })
    // sessions list refreshes via onSessionsChanged
  },

  async removeSession(id) {
    await window.api.removeSession(id)
    if (get().maximizedId === id) set({ maximizedId: null })
  },

  async renameSession(id, name) {
    await window.api.renameSession(id, name)
  },

  async restartSession(id) {
    await window.api.restartSession(id)
  },

  async updateConfig(patch) {
    const config = await window.api.setConfig(patch)
    set({ config })
  }
}))
