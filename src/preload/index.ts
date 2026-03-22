import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose electron APIs to the renderer process via contextBridge.
// This will be extended in Phase 4 with the glitterball session API.
contextBridge.exposeInMainWorld('electron', electronAPI)
