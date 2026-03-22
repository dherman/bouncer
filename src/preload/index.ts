import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose electron APIs to the renderer process via contextBridge.
// This will be extended in Phase 4 with the glitterball session API.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
}
