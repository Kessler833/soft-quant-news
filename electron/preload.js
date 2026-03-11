const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Ollama background setup IPC — consumed by Synchro tab
  onOllamaStep:     (cb) => ipcRenderer.on('ollama:step',     (_e, d) => cb(d)),
  onOllamaProgress: (cb) => ipcRenderer.on('ollama:progress', (_e, d) => cb(d)),
  onOllamaStatus:   (cb) => ipcRenderer.on('ollama:status',   (_e, d) => cb(d)),
  onOllamaDone:     (cb) => ipcRenderer.on('ollama:done',     (_e, d) => cb(d)),
  onOllamaError:    (cb) => ipcRenderer.on('ollama:error',    (_e, d) => cb(d)),
})
