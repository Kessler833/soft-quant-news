const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('setupAPI', {
  // Returns { installed: bool, running: bool }
  checkOllama:       ()    => ipcRenderer.invoke('setup-check-ollama'),
  // Open a URL in the system browser
  openExternal:      url   => ipcRenderer.invoke('setup-open-external', url),
  // Tell main process the user is ready to continue
  proceed:           ()    => ipcRenderer.send('setup-proceed'),
  // User confirmed the installer finished
  installerDone:     ()    => ipcRenderer.send('setup:installer-done'),
  // Subscribe to progress events pushed from main
  onStep:            cb    => ipcRenderer.on('setup:step',          (_e, d) => cb(d)),
  onProgress:        cb    => ipcRenderer.on('setup:progress',      (_e, d) => cb(d)),
  onStatus:          cb    => ipcRenderer.on('setup:status',        (_e, d) => cb(d)),
  onWaitForUser:     cb    => ipcRenderer.on('setup:wait-for-user', (_e, d) => cb(d)),
  onDone:            cb    => ipcRenderer.on('setup:done',          (_e, d) => cb(d)),
  onError:           cb    => ipcRenderer.on('setup:error',         (_e, d) => cb(d)),
})
