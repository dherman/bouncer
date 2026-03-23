import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('glitterball', {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (projectDir: string, agentType?: string) =>
      ipcRenderer.invoke('sessions:create', projectDir, agentType),
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke('sessions:sendMessage', sessionId, text),
    closeSession: (sessionId: string) =>
      ipcRenderer.invoke('sessions:close', sessionId),
    onUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown): void =>
        callback(update)
      ipcRenderer.on('session-update', handler)
      return () => ipcRenderer.removeListener('session-update', handler)
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },
})
