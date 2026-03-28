/// <reference types="vite/client" />

import type { AgentType, PolicyTemplateSummary, Repository, SandboxViolationInfo, WorkspaceSummary, WorkspaceUpdate } from '../../main/types'

interface BouncerAPI {
  repositories: {
    list(): Promise<Repository[]>
    add(localPath: string): Promise<Repository>
    update(id: string, changes: Partial<Repository>): Promise<void>
    remove(id: string): Promise<void>
  }
  workspaces: {
    list(): Promise<WorkspaceSummary[]>
    create(repositoryId: string): Promise<WorkspaceSummary>
    sendMessage(workspaceId: string, text: string): Promise<void>
    close(workspaceId: string): Promise<void>
    getSandboxViolations(workspaceId: string): Promise<SandboxViolationInfo[]>
    loadReplayData(datasetSessionId: string): Promise<unknown[]>
    onUpdate(callback: (update: WorkspaceUpdate) => void): () => void
  }
  preferences: {
    getFocusedRepoId(): Promise<string | undefined>
    setFocusedRepoId(id: string): Promise<void>
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
    bouncer: BouncerAPI
  }
}
