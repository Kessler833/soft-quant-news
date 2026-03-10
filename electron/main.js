const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

let mainWindow = null
let fastApiProcess = null

function waitForBackend(retries = 40, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    function attempt() {
      http.get('http://127.0.0.1:8000/api/health', (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          retry()
        }
      }).on('error', () => {
        retry()
      })
    }
    function retry() {
      attempts++
      if (attempts >= retries) {
        reject(new Error('Backend did not start in time'))
      } else {
        setTimeout(attempt, delay)
      }
    }
    attempt()
  })
}

function startBackend() {
  const projectRoot = path.join(__dirname, '..')
  const pythonPath = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')

  fastApiProcess = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
    { cwd: projectRoot, stdio: 'pipe' }
  )

  fastApiProcess.stdout.on('data', (data) => {
    console.log('[FastAPI]', data.toString())
  })
  fastApiProcess.stderr.on('data', (data) => {
    console.error('[FastAPI ERR]', data.toString())
  })
  fastApiProcess.on('exit', (code) => {
    console.log('[FastAPI] exited with code', code)
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'))

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  startBackend()
  try {
    await waitForBackend(40, 500)
    console.log('[Electron] Backend ready, opening window.')
    await createWindow()
  } catch (err) {
    console.error('[Electron] Backend failed to start:', err.message)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (fastApiProcess) {
    fastApiProcess.kill()
  }
  app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow()
  }
})
