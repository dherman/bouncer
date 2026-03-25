import { app, shell, ipcMain, dialog, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { SessionManager } from './session-manager.js'
import { loadSession } from './dataset-loader.js'

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
    // Open DevTools in dev to catch renderer errors
    if (!app.isPackaged) {
      window.webContents.openDevTools({ mode: 'detach' })
    }
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

app.whenReady().then(() => {
  // Set Dock icon on macOS (works in dev mode too)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(__dirname, '../../resources/icon.png')
    app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }

  createWindow()

  // SessionManager forwards events to the renderer via IPC
  // Track IPC throughput to diagnose renderer crashes
  let ipcCount = 0
  let ipcLastReport = Date.now()
  const sessionManager = new SessionManager((channel, data) => {
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
  sessionManager.cleanupOrphans().catch((err) => {
    console.warn('Failed to clean up orphans:', err)
  })

  // IPC handlers for renderer → main communication
  ipcMain.handle('sessions:list', () => sessionManager.listSessions())
  ipcMain.handle('sessions:create', (_e, projectDir: unknown, agentType: unknown, policyId: unknown) => {
    if (typeof projectDir !== 'string') {
      throw new Error('Invalid argument: projectDir must be a string')
    }
    const validTypes = ['echo', 'claude-code', 'replay'] as const
    type ValidType = typeof validTypes[number]
    const validAgentType: ValidType = validTypes.includes(agentType as ValidType)
      ? (agentType as ValidType)
      : 'claude-code'
    const validPolicyId = typeof policyId === 'string' ? policyId : undefined
    return sessionManager.createSession(projectDir, validAgentType, validPolicyId)
  })

  ipcMain.handle('policies:list', () => {
    return sessionManager.policyRegistry.list()
  })
  ipcMain.handle('sessions:sendMessage', (_e, sessionId: unknown, text: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') {
      throw new Error('Invalid arguments: sessionId and text must be strings')
    }
    return sessionManager.sendMessage(sessionId, text)
  })
  ipcMain.handle('sessions:close', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('Invalid argument: sessionId must be a string')
    }
    return sessionManager.closeSession(sessionId)
  })

  ipcMain.handle('sessions:getSandboxViolations', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('Invalid argument: sessionId must be a string')
    }
    return sessionManager.getSandboxViolations(sessionId)
  })

  ipcMain.handle('sessions:loadReplayData', async (_e, datasetSessionId: unknown) => {
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

  // Clean up all sessions before quitting
  app.on('before-quit', (event) => {
    event.preventDefault()
    sessionManager.listSessions().then((sessions) => {
      const activeSessions = sessions.filter((s) => s.status !== 'closed')
      if (activeSessions.length > 0) {
        sessionManager.closeAllSessions().finally(() => {
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
