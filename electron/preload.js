// Minimal preload — contextIsolation safe.
// No sensitive APIs exposed to renderer.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform
})
