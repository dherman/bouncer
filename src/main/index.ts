import { app, shell, ipcMain, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { SessionManager } from './session-manager.js'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
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
  createWindow()

  // SessionManager forwards events to the renderer via IPC
  const sessionManager = new SessionManager((channel, data) => {
    mainWindow?.webContents.send(channel, data)
  })

  // IPC handlers for renderer → main communication
  ipcMain.handle('sessions:list', () => sessionManager.listSessions())
  ipcMain.handle('sessions:create', (_e, projectDir: unknown, agentType: unknown) => {
    if (typeof projectDir !== 'string') {
      throw new Error('Invalid argument: projectDir must be a string')
    }
    const validAgentType = agentType === 'echo' ? 'echo' as const : 'claude-code' as const
    return sessionManager.createSession(projectDir, validAgentType)
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

  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select project directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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
