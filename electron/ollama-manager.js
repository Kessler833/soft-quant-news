/**
 * ollama-manager.js
 * Manages the full Ollama lifecycle:
 *   - Detect if already running (user has their own Ollama)
 *   - Download the Ollama binary if missing
 *   - Pull the default model if missing
 *   - Start the Ollama server
 *   - Track the process for safe shutdown
 */

const { app } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const os = require('os')

const OLLAMA_PORT = 11434
const OLLAMA_HOST = `http://127.0.0.1:${OLLAMA_PORT}`
const DEFAULT_MODEL = 'qwen2.5:3b'

// Where we store our own Ollama binary (inside app userData so it persists)
const OLLAMA_DIR = path.join(app.getPath('userData'), 'ollama')
const OLLAMA_BIN = path.join(OLLAMA_DIR, process.platform === 'win32' ? 'ollama.exe' : 'ollama')

// The managed process (null if we didn't start it ourselves)
let _ollamaProcess = null
let _weStartedIt = false

/**
 * Download URL for the Ollama binary per platform.
 */
function _getBinaryUrl() {
  // Always download latest release
  const base = 'https://github.com/ollama/ollama/releases/latest/download'
  switch (process.platform) {
    case 'win32':  return `${base}/ollama-windows-amd64.exe`
    case 'darwin': return `${base}/ollama-darwin`
    default:       return `${base}/ollama-linux-amd64`
  }
}

/**
 * Check if an Ollama server is already listening on the port.
 */
function isOllamaRunning() {
  return new Promise(resolve => {
    http.get(`${OLLAMA_HOST}/api/tags`, res => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

/**
 * Check if our managed binary exists on disk.
 */
function isBinaryInstalled() {
  return fs.existsSync(OLLAMA_BIN)
}

/**
 * Download the Ollama binary with progress callbacks.
 * @param {function} onProgress  (downloaded: number, total: number) => void
 * @param {function} onStatus    (msg: string) => void
 */
function downloadBinary(onProgress, onStatus) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(OLLAMA_DIR)) fs.mkdirSync(OLLAMA_DIR, { recursive: true })

    const url = _getBinaryUrl()
    onStatus(`Downloading Ollama from GitHub...`)

    function doRequest(reqUrl, redirectCount = 0) {
      if (redirectCount > 5) return reject(new Error('Too many redirects'))
      const mod = reqUrl.startsWith('https') ? require('https') : require('http')
      mod.get(reqUrl, { headers: { 'User-Agent': 'soft-quant-news' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return doRequest(res.headers.location, redirectCount + 1)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        }

        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        const tmpPath = OLLAMA_BIN + '.tmp'
        const out = fs.createWriteStream(tmpPath)

        res.on('data', chunk => {
          downloaded += chunk.length
          out.write(chunk)
          if (total > 0) onProgress(downloaded, total)
        })
        res.on('end', () => {
          out.end()
          fs.renameSync(tmpPath, OLLAMA_BIN)
          // Make executable on Unix
          if (process.platform !== 'win32') {
            fs.chmodSync(OLLAMA_BIN, 0o755)
          }
          onStatus('Ollama binary ready.')
          resolve()
        })
        res.on('error', reject)
        out.on('error', reject)
      }).on('error', reject)
    }

    doRequest(url)
  })
}

/**
 * Start the Ollama server using our managed binary.
 */
function startOllamaServer(onStatus) {
  return new Promise((resolve, reject) => {
    onStatus('Starting Ollama server...')
    _ollamaProcess = spawn(OLLAMA_BIN, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'pipe',
    })
    _weStartedIt = true

    _ollamaProcess.stdout.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.stderr.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.on('exit', (code) => {
      console.log(`[ollama] Server exited with code ${code}`)
      _ollamaProcess = null
    })

    // Wait until it responds
    let attempts = 0
    const check = setInterval(async () => {
      attempts++
      if (await isOllamaRunning()) {
        clearInterval(check)
        onStatus('Ollama server is running.')
        resolve()
      } else if (attempts > 30) {
        clearInterval(check)
        reject(new Error('Ollama server did not start in time.'))
      }
    }, 500)
  })
}

/**
 * Pull a model, streaming progress via callbacks.
 * @param {string}   model       e.g. 'qwen2.5:3b'
 * @param {function} onProgress  (pulled: number, total: number) => void
 * @param {function} onStatus    (msg: string) => void
 */
function pullModel(model, onProgress, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus(`Pulling model ${model} — this is a one-time ~2GB download...`)
    const body = JSON.stringify({ name: model, stream: true })
    const options = {
      hostname: '127.0.0.1',
      port: OLLAMA_PORT,
      path: '/api/pull',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = http.request(options, res => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            if (obj.status) onStatus(obj.status)
            if (typeof obj.completed === 'number' && typeof obj.total === 'number' && obj.total > 0) {
              onProgress(obj.completed, obj.total)
            }
          } catch (_) {}
        }
      })
      res.on('end', () => {
        onStatus(`Model ${model} ready.`)
        resolve()
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Check if a model is already pulled.
 */
async function isModelPulled(model) {
  try {
    const tags = await new Promise((resolve, reject) => {
      http.get(`${OLLAMA_HOST}/api/tags`, res => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => resolve(JSON.parse(data)))
      }).on('error', reject)
    })
    return (tags.models || []).some(m => m.name.startsWith(model.split(':')[0]))
  } catch (_) {
    return false
  }
}

/**
 * Main entry point. Call this before opening the main window.
 *
 * Steps:
 *   1. Is Ollama already running?  → skip everything
 *   2. Is binary installed?        → skip download
 *   3. Download binary
 *   4. Start server
 *   5. Is model pulled?            → skip pull
 *   6. Pull model
 *
 * @param {object} callbacks
 *   .onStep(step: number, total: number, label: string)
 *   .onProgress(downloaded: number, total: number)
 *   .onStatus(msg: string)
 *   .onDone()
 *   .onError(err: Error)
 */
async function ensureOllama({ onStep, onProgress, onStatus, onDone, onError }) {
  try {
    // Step 1: Already running?
    onStep(1, 3, 'Checking for Ollama...')
    if (await isOllamaRunning()) {
      onStatus('Ollama already running — skipping setup.')
      // Still check model
      if (!await isModelPulled(DEFAULT_MODEL)) {
        onStep(2, 3, `Pulling model ${DEFAULT_MODEL}...`)
        await pullModel(DEFAULT_MODEL, onProgress, onStatus)
      }
      onStep(3, 3, 'Ready!')
      onDone()
      return
    }

    // Step 2: Download binary if missing
    if (!isBinaryInstalled()) {
      onStep(1, 3, 'Downloading Ollama...')
      await downloadBinary(onProgress, onStatus)
    } else {
      onStatus('Ollama binary found.')
    }

    // Step 3: Start server
    onStep(2, 3, 'Starting Ollama server...')
    await startOllamaServer(onStatus)

    // Step 4: Pull model if missing
    if (!await isModelPulled(DEFAULT_MODEL)) {
      onStep(3, 3, `Pulling model ${DEFAULT_MODEL}...`)
      await pullModel(DEFAULT_MODEL, onProgress, onStatus)
    } else {
      onStatus(`Model ${DEFAULT_MODEL} already present.`)
    }

    onStep(3, 3, 'Ready!')
    onDone()
  } catch (err) {
    console.error('[ollama-manager] Error:', err)
    onError(err)
  }
}

/**
 * Gracefully stop the managed Ollama process.
 * Safe to call multiple times or when we didn't start Ollama.
 */
function stopOllama() {
  if (!_weStartedIt || !_ollamaProcess) return
  console.log('[ollama-manager] Shutting down Ollama server...')
  try {
    if (process.platform === 'win32') {
      // On Windows, kill the process tree
      spawn('taskkill', ['/pid', _ollamaProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' })
    } else {
      _ollamaProcess.kill('SIGTERM')
    }
  } catch (e) {
    console.warn('[ollama-manager] Could not kill Ollama:', e.message)
  }
  _ollamaProcess = null
}

module.exports = { ensureOllama, stopOllama, isOllamaRunning, DEFAULT_MODEL }
