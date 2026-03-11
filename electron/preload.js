const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Setup window IPC
  onSetupStep:     (cb) => ipcRenderer.on('setup:step',     (_e, d) => cb(d)),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (_e, d) => cb(d)),
  onSetupStatus:   (cb) => ipcRenderer.on('setup:status',   (_e, d) => cb(d)),
  onSetupDone:     (cb) => ipcRenderer.on('setup:done',     (_e, d) => cb(d)),
  onSetupError:    (cb) => ipcRenderer.on('setup:error',    (_e, d) => cb(d)),
  setupSkip:       ()   => ipcRenderer.send('setup:skip'),
})
