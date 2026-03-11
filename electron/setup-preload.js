const { contextBridge, ipcRenderer, shell } = require('electron')

contextBridge.exposeInMainWorld('setupAPI', {
  checkOllama:  () => ipcRenderer.invoke('setup-check-ollama'),
  openExternal: (url) => ipcRenderer.invoke('setup-open-external', url),
  proceed:      () => ipcRenderer.send('setup-proceed'),
})
