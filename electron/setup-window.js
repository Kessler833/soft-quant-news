/**
 * setup-window.js
 * Creates and manages the first-run installer splash window.
 */

const { BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { ensureOllama } = require('./ollama-manager')

let setupWin = null

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    frame: false,
    transparent: false,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  setupWin.loadFile(path.join(__dirname, 'setup.html'))
  setupWin.once('ready-to-show', () => { setupWin.show() })
  setupWin.on('closed', () => { setupWin = null })
  return setupWin
}

function runSetup() {
  return new Promise((resolve) => {
    ipcMain.once('setup:skip', () => {
      console.log('[setup] User aborted Ollama setup.')
      if (setupWin) setupWin.close()
      resolve()
    })

    createSetupWindow()

    ensureOllama({
      onStep:     (step, total, label) => setupWin?.webContents.send('setup:step',     { step, total, label }),
      onProgress: (downloaded, total)  => setupWin?.webContents.send('setup:progress', { pct: Math.round((downloaded / total) * 100) }),
      onStatus:   (msg)               => setupWin?.webContents.send('setup:status',   { msg }),

      // Called when installer is open and waiting for user to click "Done"
      onWaitForUser: () => new Promise((res) => {
        setupWin?.webContents.send('setup:wait-for-user', {})
        ipcMain.once('setup:installer-done', () => res())
      }),

      onDone: () => {
        setupWin?.webContents.send('setup:done', {})
        setTimeout(() => { if (setupWin) setupWin.close(); resolve() }, 1200)
      },
      onError: (err) => {
        setupWin?.webContents.send('setup:error', { msg: err.message })
        setTimeout(() => { if (setupWin) setupWin.close(); resolve() }, 4000)
      },
    })
  })
}

module.exports = { runSetup }
