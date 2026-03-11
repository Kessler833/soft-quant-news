const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup window IPC
  onSetupStep:     (cb) => ipcRenderer.on('setup:step',     (_e, data) => cb(data)),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (_e, data) => cb(data)),
  onSetupStatus:   (cb) => ipcRenderer.on('setup:status',   (_e, data) => cb(data)),
  onSetupDone:     (cb) => ipcRenderer.on('setup:done',     (_e, data) => cb(data)),
  onSetupError:    (cb) => ipcRenderer.on('setup:error',    (_e, data) => cb(data)),
  setupSkip:       ()   => ipcRenderer.send('setup:skip-req'),
})
