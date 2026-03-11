/**
 * setup-window.js
 * Creates and manages the first-run Ollama setup window.
 *
 * The HTML (setup.html) talks to the main process via these IPC channels:
 *   invoke  'setup-check-ollama'    → bool (is binary installed AND server up?)
 *   invoke  'setup-open-external'   → opens a URL in the default browser
 *   send    'setup-proceed'         → user is done; resolve the promise
 *
 * The main process pushes progress into the renderer via:
 *   'setup:step'        { step, total, label }
 *   'setup:progress'    { pct }
 *   'setup:status'      { msg }
 *   'setup:wait-for-user'          → show "Done" button
 *   'setup:installer-done'         → renderer fires ipcRenderer.send
 *   'setup:done'        {}
 *   'setup:error'       { msg }
 */

const { BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { ensureOllama, isOllamaRunning, isBinaryInstalled } = require('./ollama-manager')

let setupWin = null

function _send(channel, payload) {
  if (setupWin && !setupWin.isDestroyed())
    setupWin.webContents.send(channel, payload)
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520, height: 460,
    resizable: false, frame: false, transparent: false,
    center: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  setupWin.loadFile(path.join(__dirname, 'setup.html'))
  setupWin.once('ready-to-show', () => setupWin.show())
  setupWin.on('closed', () => { setupWin = null })
  return setupWin
}

function runSetup() {
  return new Promise(resolve => {
    createSetupWindow()

    // ── IPC: setup.html calls these ─────────────────────────────────────────

    // Check if Ollama is already usable (binary present AND server running)
    ipcMain.handle('setup-check-ollama', async () => {
      const running = await isOllamaRunning()
      return { installed: isBinaryInstalled(), running }
    })

    // Open a URL in the default browser
    ipcMain.handle('setup-open-external', (_event, url) => shell.openExternal(url))

    // User clicked Launch / Skip — close window and continue boot
    ipcMain.once('setup-proceed', () => {
      console.log('[setup] User proceeded.')
      _closeAndResolve(resolve)
    })

    // ── Drive ensureOllama and stream progress to the renderer ───────────────
    ensureOllama({
      onStep:     (step, total, label) => _send('setup:step',     { step, total, label }),
      onProgress: (downloaded, total)  => _send('setup:progress', { pct: Math.round((downloaded / total) * 100) }),
      onStatus:   msg                  => _send('setup:status',   { msg }),

      // Pause until the user clicks the "Done" button in setup.html
      onWaitForUser: () => new Promise(res => {
        _send('setup:wait-for-user', {})
        ipcMain.once('setup:installer-done', () => res())
      }),

      onDone: () => {
        _send('setup:done', {})
        // Auto-close after a short delay so the user sees the green tick
        setTimeout(() => _closeAndResolve(resolve), 1200)
      },

      onError: err => {
        _send('setup:error', { msg: err.message })
        // Keep window open so the user can read the error & click Skip
        // The 'setup-proceed' handler above will still fire when they click Skip
      },
    })
  })
}

function _closeAndResolve(resolve) {
  // Remove handlers so they don't leak across re-runs
  ipcMain.removeHandler('setup-check-ollama')
  ipcMain.removeHandler('setup-open-external')
  if (setupWin && !setupWin.isDestroyed()) setupWin.close()
  resolve()
}

module.exports = { runSetup }
