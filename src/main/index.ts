import { app, shell, ipcMain, dialog, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { SessionManager } from './session-manager.js'
import { loadSession } from './dataset-loader.js'

// Crash-safe diagnostic logging (writes synchronously to survive crashes)
const DIAG_LOG = join(app.getPath('temp'), 'glitterball-diag.log')
function diag(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(DIAG_LOG, line) } catch { /* ignore */ }
  console.log(`[diag] ${msg}`)
}

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
  const sessionManager = new SessionManager((channel, data) => {
    mainWindow?.webContents.send(channel, data)
  })

  // Clean up orphan worktrees and sandbox policies from previous crashes
  sessionManager.cleanupOrphans().catch((err) => {
    console.warn('Failed to clean up orphans:', err)
  })

  // IPC handlers for renderer → main communication
  ipcMain.handle('sessions:list', () => sessionManager.listSessions())
  ipcMain.handle('sessions:create', (_e, projectDir: unknown, agentType: unknown, policyId: unknown) => {
    diag(`sessions:create called: agentType=${agentType}, policyId=${policyId}`)
    if (typeof projectDir !== 'string') {
      throw new Error('Invalid argument: projectDir must be a string')
    }
    const validTypes = ['echo', 'claude-code', 'replay'] as const
    type ValidType = typeof validTypes[number]
    const validAgentType: ValidType = validTypes.includes(agentType as ValidType)
      ? (agentType as ValidType)
      : 'claude-code'
    const validPolicyId = typeof policyId === 'string' ? policyId : undefined
    diag(`sessions:create calling sessionManager.createSession(${validAgentType})`)
    return sessionManager.createSession(projectDir, validAgentType, validPolicyId)
      .then(result => { diag(`sessions:create completed: ${result.id}`); return result })
      .catch(err => { diag(`sessions:create FAILED: ${err}`); throw err })
  })

  ipcMain.handle('policies:list', () => {
    return sessionManager.policyRegistry.list()
  })
  ipcMain.handle('sessions:sendMessage', (_e, sessionId: unknown, text: unknown) => {
    diag(`sessions:sendMessage called: sessionId=${sessionId}, text length=${typeof text === 'string' ? text.length : '?'}`)
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
    diag(`loadReplayData called: ${datasetSessionId}`)
    if (typeof datasetSessionId !== 'string') {
      throw new Error('Invalid argument: datasetSessionId must be a string')
    }
    const datasetPath = join(app.getAppPath(), 'data', 'tool-use-dataset.jsonl')
    diag(`loadReplayData dataset path: ${datasetPath}`)
    const toolCalls = await loadSession(datasetPath, datasetSessionId)
    diag(`loadReplayData got ${toolCalls.length} tool calls`)
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
    const activeSessions = sessionManager.listSessions().filter(
      (s) => s.status !== 'closed'
    )
    if (activeSessions.length > 0) {
      event.preventDefault()
      sessionManager.closeAllSessions().finally(() => {
        app.quit()
      })
    }
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
