const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path  = require('path')
const http  = require('http')

const { runSetup }   = require('./setup-window')
const { stopOllama } = require('./ollama-manager')

let mainWindow       = null
let fastApiProcess   = null
let _shuttingDown    = false
let _mainWindowShown = false

// ── Safe shutdown ─────────────────────────────────────────────────────────────

function safeShutdown(reason) {
  if (_shuttingDown) return
  _shuttingDown = true
  console.log(`[main] Safe shutdown: ${reason}`)
  stopOllama()
  if (fastApiProcess) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', fastApiProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' })
      } else {
        fastApiProcess.kill('SIGTERM')
      }
    } catch (e) { console.warn('[main] Could not kill FastAPI:', e.message) }
    fastApiProcess = null
  }
}

app.on('before-quit',       () => safeShutdown('before-quit'))
app.on('window-all-closed', () => {
  if (_mainWindowShown) { safeShutdown('window-all-closed'); app.quit() }
})
process.on('SIGTERM',            () => { safeShutdown('SIGTERM');           process.exit(0) })
process.on('SIGINT',             () => { safeShutdown('SIGINT');            process.exit(0) })
process.on('uncaughtException',  err => { console.error('[main] Uncaught:', err); safeShutdown('uncaughtException'); process.exit(1) })
process.on('unhandledRejection', r   => { console.error('[main] Unhandled rejection:', r) })

// ── Backend ───────────────────────────────────────────────────────────────────

function startBackend() {
  const root       = path.join(__dirname, '..')
  const pythonPath = path.join(root, '.venv', 'Scripts', 'python.exe')
  fastApiProcess = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
    { cwd: root, stdio: 'pipe' }
  )
  fastApiProcess.stdout.on('data', d => console.log('[FastAPI]',     d.toString().trim()))
  fastApiProcess.stderr.on('data', d => console.error('[FastAPI ERR]', d.toString().trim()))
  fastApiProcess.on('exit', code => { console.log(`[FastAPI] exited ${code}`); fastApiProcess = null })
}

function waitForBackend(retries = 40, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    function attempt() {
      http.get('http://127.0.0.1:8000/api/health', res => {
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

// ── Main window ────────────────────────────────────────────────────────────────

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  await mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'))
  mainWindow.show()
  _mainWindowShown = true
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev'))
    mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Boot sequence ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // 1. Ollama setup (installs + starts + pulls model if needed)
  await runSetup()

  // 2. Start Python backend
  startBackend()

  // 3. Wait for backend health check, then open main window
  try {
    await waitForBackend(40, 500)
    console.log('[main] Backend ready — opening window.')
    await createMainWindow()
  } catch (err) {
    console.error('[main] Backend failed to start:', err.message)
    safeShutdown('backend-timeout')
    app.quit()
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createMainWindow()
})
