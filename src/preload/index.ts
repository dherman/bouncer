import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bouncer', {
  repositories: {
    list: () => ipcRenderer.invoke('repositories:list'),
    add: (localPath: string) => ipcRenderer.invoke('repositories:add', localPath),
    update: (id: string, changes: Record<string, unknown>) =>
      ipcRenderer.invoke('repositories:update', id, changes),
    remove: (id: string) => ipcRenderer.invoke('repositories:remove', id),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (repositoryId: string) => ipcRenderer.invoke('workspaces:create', repositoryId),
    getMessages: (workspaceId: string) => ipcRenderer.invoke('workspaces:getMessages', workspaceId),
    sendMessage: (workspaceId: string, text: string) =>
      ipcRenderer.invoke('workspaces:sendMessage', workspaceId, text),
    close: (workspaceId: string) => ipcRenderer.invoke('workspaces:close', workspaceId),
    archive: (workspaceId: string) => ipcRenderer.invoke('workspaces:archive', workspaceId),
    refreshCredentials: (workspaceId: string) =>
      ipcRenderer.invoke('workspaces:refreshCredentials', workspaceId),
    resume: (workspaceId: string) => ipcRenderer.invoke('workspaces:resume', workspaceId),
    simulateAuthError: (workspaceId: string) =>
      ipcRenderer.invoke('workspaces:simulateAuthError', workspaceId),
    getSandboxViolations: (workspaceId: string) =>
      ipcRenderer.invoke('workspaces:getSandboxViolations', workspaceId),
    loadReplayData: (datasetSessionId: string) =>
      ipcRenderer.invoke('workspaces:loadReplayData', datasetSessionId),
    onUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown): void =>
        callback(update);
      ipcRenderer.on('workspace-update', handler);
      return () => ipcRenderer.removeListener('workspace-update', handler);
    },
  },
  preferences: {
    getFocusedRepoId: () => ipcRenderer.invoke('preferences:getFocusedRepoId'),
    setFocusedRepoId: (id: string) => ipcRenderer.invoke('preferences:setFocusedRepoId', id),
  },
  policies: {
    list: () => ipcRenderer.invoke('policies:list'),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },
});
