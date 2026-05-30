import type { DeckApi } from '@shared/types'

declare global {
  interface Window {
    api: DeckApi
  }
}

export {}
