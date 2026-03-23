/// <reference types="vite/client" />

import type { AgentType, SessionSummary, SessionUpdate } from '../../main/types'

interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>
    create(projectDir: string, agentType?: AgentType): Promise<SessionSummary>
    sendMessage(sessionId: string, text: string): Promise<void>
    closeSession(sessionId: string): Promise<void>
    onUpdate(callback: (update: SessionUpdate) => void): () => void
  }
  dialog: {
    selectDirectory(): Promise<string | null>
  }
}

declare global {
  interface Window {
    glitterball: GlitterballAPI
  }
}
