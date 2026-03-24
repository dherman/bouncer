import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('glitterball', {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (projectDir: string, agentType?: string, policyId?: string) =>
      ipcRenderer.invoke('sessions:create', projectDir, agentType, policyId),
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke('sessions:sendMessage', sessionId, text),
    closeSession: (sessionId: string) =>
      ipcRenderer.invoke('sessions:close', sessionId),
    getSandboxViolations: (sessionId: string) =>
      ipcRenderer.invoke('sessions:getSandboxViolations', sessionId),
    loadReplayData: (datasetSessionId: string) =>
      ipcRenderer.invoke('sessions:loadReplayData', datasetSessionId),
    onUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown): void =>
        callback(update)
      ipcRenderer.on('session-update', handler)
      return () => ipcRenderer.removeListener('session-update', handler)
    },
  },
  policies: {
    list: () => ipcRenderer.invoke('policies:list'),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },
})
