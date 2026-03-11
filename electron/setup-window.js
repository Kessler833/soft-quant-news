/**
 * setup-window.js
 * Creates and manages the first-run installer splash window.
 * Communicates with ollama-manager via IPC.
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setupWin.loadFile(path.join(__dirname, '..', 'frontend', 'setup', 'setup.html'))

  setupWin.once('ready-to-show', () => {
    setupWin.show()
  })

  setupWin.on('closed', () => { setupWin = null })

  return setupWin
}

/**
 * Show the setup window, run ensureOllama(), resolve when done.
 * If Ollama is already running and model is present, resolves immediately
 * without ever showing the window (fast path).
 */
function runSetup() {
  return new Promise((resolve, reject) => {
    // Register IPC handler so the renderer can signal "skip" (user clicked X)
    ipcMain.once('setup:skip', () => {
      console.log('[setup] User skipped Ollama setup.')
      if (setupWin) setupWin.close()
      resolve() // Continue app launch without Ollama
    })

    createSetupWindow()

    ensureOllama({
      onStep: (step, total, label) => {
        setupWin?.webContents.send('setup:step', { step, total, label })
      },
      onProgress: (downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100)
        setupWin?.webContents.send('setup:progress', { downloaded, total, pct })
      },
      onStatus: (msg) => {
        setupWin?.webContents.send('setup:status', { msg })
      },
      onDone: () => {
        setupWin?.webContents.send('setup:done', {})
        // Auto-close after short delay so user can see the green check
        setTimeout(() => {
          if (setupWin) setupWin.close()
          resolve()
        }, 1200)
      },
      onError: (err) => {
        setupWin?.webContents.send('setup:error', { msg: err.message })
        // Don't reject — let user continue without local AI
        // They can always configure Groq as fallback
        setTimeout(() => {
          if (setupWin) setupWin.close()
          resolve()
        }, 4000)
      },
    })
  })
}

module.exports = { runSetup }
