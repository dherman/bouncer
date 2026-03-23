/// <reference types="vite/client" />

import type { AgentType, PolicyTemplateSummary, SandboxViolationInfo, SessionSummary, SessionUpdate } from '../../main/types'

interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>
    create(projectDir: string, agentType?: AgentType, policyId?: string): Promise<SessionSummary>
    sendMessage(sessionId: string, text: string): Promise<void>
    closeSession(sessionId: string): Promise<void>
    getSandboxViolations(sessionId: string): Promise<SandboxViolationInfo[]>
    onUpdate(callback: (update: SessionUpdate) => void): () => void
  }
  policies: {
    list(): Promise<PolicyTemplateSummary[]>
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
