import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { SessionManager } from './session-manager.js'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
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

  // Dev smoke test: verify session lifecycle from main process
  if (isDev) {
    smokeTest(sessionManager)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function smokeTest(sessionManager: SessionManager): Promise<void> {
  try {
    console.log('[smoke-test] Creating session...')
    const session = await sessionManager.createSession()
    console.log('[smoke-test] Session created:', session)

    console.log('[smoke-test] Sending message...')
    await sessionManager.sendMessage(session.id, 'Hello from main process')

    console.log('[smoke-test] Sessions:', sessionManager.listSessions())

    console.log('[smoke-test] Closing session...')
    await sessionManager.closeSession(session.id)
    console.log('[smoke-test] Done. Sessions:', sessionManager.listSessions())
  } catch (err) {
    console.error('[smoke-test] Error:', err)
  }
}
