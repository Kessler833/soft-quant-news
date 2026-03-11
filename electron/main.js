const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')
const http = require('http')
const fs   = require('fs')

let mainWindow   = null
let splashWindow = null
let setupWindow  = null
let fastApiProcess = null

// ── IPC: Setup window handlers ────────────────────────────────────────────

ipcMain.handle('setup-check-ollama', () => {
  return new Promise((resolve) => {
    execFile('ollama', ['--version'], { timeout: 4000 }, (err) => {
      resolve(!err)
    })
  })
})

ipcMain.handle('setup-open-external', (_e, url) => {
  shell.openExternal(url)
})

ipcMain.on('setup-proceed', () => {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close()
    setupWindow = null
  }
  bootSplashAndBackend()
})

// ── Setup window ──────────────────────────────────────────────────────────────

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width:  460,
    height: 460,
    frame:       false,
    transparent: false,
    resizable:   false,
    center:      true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
}

// ── Splash ────────────────────────────────────────────────────────────────────

function createSplash() {
  splashWindow = new BrowserWindow({
    width:  480,
    height: 300,
    frame:       false,
    transparent: false,
    resizable:   false,
    center:      true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
}

function splashProgress(pct, msg, state = '') {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-progress', pct, msg, state)
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

// ── Backend ───────────────────────────────────────────────────────────────────

function startBackend() {
  const projectRoot = path.join(__dirname, '..')
  const pythonPath  = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')

  fastApiProcess = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
    { cwd: projectRoot, stdio: 'pipe' }
  )

  fastApiProcess.stdout.on('data', d => console.log('[FastAPI]', d.toString()))
  fastApiProcess.stderr.on('data', d => console.error('[FastAPI ERR]', d.toString()))
  fastApiProcess.on('exit', code => console.log('[FastAPI] exited', code))
}

function waitForBackend(retries = 40, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    function attempt() {
      http.get('http://127.0.0.1:8000/api/health', (res) => {
        if (res.statusCode === 200) resolve()
        else retry()
      }).on('error', retry)
    }
    function retry() {
      if (++attempts >= retries) reject(new Error('Backend did not start in time'))
      else setTimeout(attempt, delay)
    }
    attempt()
  })
}

// ── Main window ───────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1600,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  await mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'))

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.show()
  setTimeout(closeSplash, 300)
}

// ── Boot sequence (runs after setup window closes) ───────────────────────

async function bootSplashAndBackend() {
  createSplash()

  splashProgress(10, 'Starting Python backend<span class="dots"></span>')
  startBackend()
  splashProgress(20, 'Waiting for server<span class="dots"></span>')

  let fakePct = 20
  const fakeTimer = setInterval(() => {
    fakePct = Math.min(fakePct + 3, 80)
    splashProgress(fakePct, 'Waiting for server<span class="dots"></span>')
  }, 600)

  try {
    await waitForBackend(40, 500)
    clearInterval(fakeTimer)
    splashProgress(90, 'Loading interface<span class="dots"></span>')
    await createWindow()
    splashProgress(100, 'Ready &#10003;', 'ready')
  } catch (err) {
    clearInterval(fakeTimer)
    splashProgress(100, 'Backend failed to start &#9888;', 'error')
    console.error('[Electron] Backend failed:', err.message)
    setTimeout(() => app.quit(), 3000)
  }
}

// ── App entry ───────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Always show setup check on first open
  // Once user clicks Launch or Skip, setup-proceed fires bootSplashAndBackend
  createSetupWindow()
})

app.on('window-all-closed', () => {
  if (fastApiProcess) fastApiProcess.kill()
  app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow()
})
