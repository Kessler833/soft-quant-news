const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('splashAPI', {
  onProgress: (cb) => ipcRenderer.on('splash-progress', (_e, pct, msg, state) => cb(pct, msg, state))
})
