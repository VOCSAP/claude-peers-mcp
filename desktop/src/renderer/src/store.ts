import { create } from 'zustand'
import type {
  AppConfig,
  CreateSessionInput,
  SessionRuntime,
  WorkspaceSummary
} from '@shared/types'

interface DeckState {
  sessions: SessionRuntime[]
  config: AppConfig | null
  /** Active translation dict (flat key->template), fetched from main. */
  dict: Record<string, string>
  selectedId: string | null
  maximizedId: string | null
  settingsOpen: boolean
  workspacesOpen: boolean
  workspaces: WorkspaceSummary[]
  /** Live sidebar width (px); seeded from config, persisted on drag end. */
  sidebarWidth: number

  init(): Promise<void>
  setSelected(id: string | null): void
  setMaximized(id: string | null): void
  openSettings(open: boolean): void
  openWorkspaces(open: boolean): void
  setSidebarWidth(px: number): void

  createSession(input: CreateSessionInput): Promise<void>
  removeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  setColor(id: string, color: string): Promise<void>
  restartSession(id: string): Promise<void>
  updateConfig(patch: Partial<AppConfig>): Promise<void>

  refreshWorkspaces(): Promise<void>
  saveWorkspace(name?: string): Promise<void>
  restoreWorkspace(id: string): Promise<void>
  removeWorkspace(id: string): Promise<void>
}

export const useDeck = create<DeckState>((set, get) => ({
  sessions: [],
  config: null,
  dict: {},
  selectedId: null,
  maximizedId: null,
  settingsOpen: false,
  workspacesOpen: false,
  workspaces: [],
  sidebarWidth: 260,

  async init() {
    const [sessions, config, i18n, workspaces] = await Promise.all([
      window.api.listSessions(),
      window.api.getConfig(),
      window.api.getI18n(),
      window.api.listWorkspaces()
    ])
    set({
      sessions,
      config,
      dict: i18n.dict,
      workspaces,
      sidebarWidth: config.sidebarWidth,
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
    window.api.onConfigChanged((next) => {
      const prevLocale = get().config?.locale
      set({ config: next })
      // Locale changed -> refetch the dict so the UI re-renders in the new language.
      if (next.locale !== prevLocale) {
        void window.api.getI18n().then((i18n) => set({ dict: i18n.dict }))
      }
    })
  },

  setSelected: (id) => set({ selectedId: id }),
  setMaximized: (id) => set({ maximizedId: id }),
  openSettings: (open) => set({ settingsOpen: open }),
  openWorkspaces: (open) => {
    set({ workspacesOpen: open })
    if (open) void get().refreshWorkspaces()
  },
  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(520, Math.max(180, Math.round(px))) }),

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

  async setColor(id, color) {
    await window.api.setSessionColor(id, color)
  },

  async restartSession(id) {
    await window.api.restartSession(id)
  },

  async updateConfig(patch) {
    const config = await window.api.setConfig(patch)
    set({ config })
  },

  async refreshWorkspaces() {
    set({ workspaces: await window.api.listWorkspaces() })
  },

  async saveWorkspace(name) {
    await window.api.saveWorkspace(name)
    await get().refreshWorkspaces()
  },

  async restoreWorkspace(id) {
    await window.api.restoreWorkspace(id)
    // Sessions refresh via onSessionsChanged (restoreFrom broadcasts 'changed').
    await get().refreshWorkspaces()
  },

  async removeWorkspace(id) {
    await window.api.deleteWorkspace(id)
    await get().refreshWorkspaces()
  }
}))
