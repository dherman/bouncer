import { app, shell, ipcMain, dialog, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { WorkspaceManager } from './workspace-manager.js'
import { RepositoryStore } from './repository-store.js'
import { loadSession } from './dataset-loader.js'
import { isDockerAvailable, ensureAgentImage } from './container.js'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window

  window.on('ready-to-show', () => {
    window.show()
  })

  // Monitor renderer health
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Renderer process gone:', details.reason, 'exitCode:', details.exitCode)
  })
  window.webContents.on('unresponsive', () => {
    console.error('[main] Renderer became unresponsive')
  })
  window.webContents.on('responsive', () => {
    console.log('[main] Renderer became responsive again')
  })

  window.webContents.setWindowOpenHandler((details) => {
    try {
      const parsedUrl = new URL(details.url)
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        void shell.openExternal(details.url)
      }
    } catch {
      // Ignore invalid URLs
    }
    return { action: 'deny' }
  })

  // HMR for renderer in dev, load from file in production
  const isDev = !app.isPackaged
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Set Dock icon on macOS (works in dev mode too)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(__dirname, '../../resources/icon.png')
    app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }

  createWindow()

  // Pre-warm Docker: check availability and build/cache the agent image
  isDockerAvailable().then((available) => {
    console.log(`[main] Docker available: ${available}`)
    if (available) {
      ensureAgentImage().catch((err) => {
        console.warn('[main] Failed to pre-build agent image:', err)
      })
    }
  })

  // Load persisted repository list
  const repoStore = new RepositoryStore()
  await repoStore.load()

  // WorkspaceManager forwards events to the renderer via IPC
  // Track IPC throughput to diagnose renderer crashes
  let ipcCount = 0
  let ipcLastReport = Date.now()
  const workspaceManager = new WorkspaceManager(repoStore, (channel, data) => {
    ipcCount++
    const now = Date.now()
    if (now - ipcLastReport >= 5000) {
      console.log(`[main] IPC events in last 5s: ${ipcCount} (${(ipcCount / 5).toFixed(0)}/sec)`)
      ipcCount = 0
      ipcLastReport = now
    }
    mainWindow?.webContents.send(channel, data)
  })

  // Clean up orphan worktrees and sandbox policies from previous crashes
  workspaceManager.cleanupOrphans().catch((err) => {
    console.warn('Failed to clean up orphans:', err)
  })

  // Repository IPC handlers
  ipcMain.handle('repositories:list', () => repoStore.list())
  ipcMain.handle('repositories:add', async (_e, localPath: unknown) => {
    if (typeof localPath !== 'string') {
      throw new Error('Invalid argument: localPath must be a string')
    }
    return repoStore.add(localPath)
  })
  ipcMain.handle('repositories:update', async (_e, id: unknown, changes: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('Invalid argument: id must be a string')
    }
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
      throw new Error('Invalid argument: changes must be an object')
    }
    const allowed = ['name', 'localPath', 'githubRepo', 'defaultPolicyId', 'defaultAgentType'] as const
    const validated: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in changes) {
        validated[key] = (changes as Record<string, unknown>)[key]
      }
    }
    return repoStore.update(id, validated)
  })
  ipcMain.handle('repositories:remove', async (_e, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('Invalid argument: id must be a string')
    }
    return repoStore.remove(id)
  })

  // Workspace IPC handlers
  ipcMain.handle('workspaces:list', () => workspaceManager.listWorkspaces())
  ipcMain.handle('workspaces:create', (_e, repositoryId: unknown) => {
    if (typeof repositoryId !== 'string') {
      throw new Error('Invalid argument: repositoryId must be a string')
    }
    return workspaceManager.createWorkspaceFromRepo(repositoryId)
  })

  ipcMain.handle('policies:list', () => {
    return workspaceManager.policyRegistry.list()
  })
  ipcMain.handle('workspaces:sendMessage', (_e, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      throw new Error('Invalid arguments: sessionId and text must be strings')
    }
    return workspaceManager.sendMessage(sessionId, text)
  })
  ipcMain.handle('workspaces:close', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('Invalid argument: sessionId must be a string')
    }
    return workspaceManager.closeWorkspace(sessionId)
  })

  ipcMain.handle('workspaces:getSandboxViolations', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('Invalid argument: sessionId must be a string')
    }
    return workspaceManager.getSandboxViolations(sessionId)
  })

  ipcMain.handle('workspaces:loadReplayData', async (_e, datasetSessionId: unknown) => {
    if (typeof datasetSessionId !== 'string') {
      throw new Error('Invalid argument: datasetSessionId must be a string')
    }
    const toolCalls = await loadSession(join(app.getAppPath(), 'data', 'tool-use-dataset.jsonl'), datasetSessionId)
    if (toolCalls.length === 0) {
      throw new Error(`Session not found in dataset: ${datasetSessionId}`)
    }
    return toolCalls
  })

  ipcMain.handle('dialog:selectDirectory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select project directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Clean up all workspaces before quitting
  app.on('before-quit', (event) => {
    event.preventDefault()
    workspaceManager.listWorkspaces().then((workspaces) => {
      const activeWorkspaces = workspaces.filter((s) => s.status !== 'closed')
      if (activeWorkspaces.length > 0) {
        workspaceManager.closeAllWorkspaces().finally(() => {
          app.quit()
        })
      } else {
        app.exit()
      }
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
