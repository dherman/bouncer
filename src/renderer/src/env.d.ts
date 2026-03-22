/// <reference types="vite/client" />

import type { SessionSummary, SessionUpdate } from '../../main/types'

interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<SessionSummary>
    sendMessage(sessionId: string, text: string): Promise<void>
    closeSession(sessionId: string): Promise<void>
    onUpdate(callback: (update: SessionUpdate) => void): () => void
  }
}

declare global {
  interface Window {
    glitterball: GlitterballAPI
  }
}
