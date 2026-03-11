/**
 * ollama-manager.js
 * Manages the full Ollama lifecycle:
 *   - Detect if already running
 *   - Download OllamaSetup.exe and open it for the user to run
 *   - Wait for user to confirm install is done
 *   - Pull the default model if missing
 *   - Start the Ollama server
 *   - Track the process for safe shutdown
 */

const { app, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')

const OLLAMA_PORT = 11434
const OLLAMA_HOST = `http://127.0.0.1:${OLLAMA_PORT}`
const DEFAULT_MODEL = 'qwen2.5:3b'

const OLLAMA_DIR = path.join(app.getPath('userData'), 'ollama')
const OLLAMA_BIN = path.join(OLLAMA_DIR, process.platform === 'win32' ? 'ollama.exe' : 'ollama')

let _ollamaProcess = null
let _weStartedIt   = false

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function _tryDelete(filePath) {
  try { fs.unlinkSync(filePath) } catch (_) {}
}

function _getLatestTag() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/ollama/ollama/releases/latest',
      headers: { 'User-Agent': 'soft-quant-news', 'Accept': 'application/vnd.github+json' },
    }
    https.get(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (!json.tag_name) return reject(new Error('No tag_name in GitHub release response'))
          resolve(json.tag_name)
        } catch (e) {
          reject(new Error('Failed to parse GitHub release response: ' + e.message))
        }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function _getBinaryUrl() {
  const tag = await _getLatestTag()
  const base = `https://github.com/ollama/ollama/releases/download/${tag}`
  switch (process.platform) {
    case 'win32':  return { url: `${base}/OllamaSetup.exe`,     isInstaller: true  }
    case 'darwin': return { url: `${base}/Ollama-darwin.zip`,  isInstaller: false }
    default:       return { url: `${base}/ollama-linux-amd64`, isInstaller: false }
  }
}

function isOllamaRunning() {
  return new Promise(resolve => {
    http.get(`${OLLAMA_HOST}/api/tags`, res => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

function isBinaryInstalled() {
  // Check our managed copy OR the standard system install location
  const systemBin = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
  return fs.existsSync(OLLAMA_BIN) || fs.existsSync(systemBin)
}

function _streamToFile(reqUrl, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'))
    const mod = reqUrl.startsWith('https') ? https : http
    mod.get(reqUrl, { headers: { 'User-Agent': 'soft-quant-news' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return _streamToFile(res.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`))
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      const out = fs.createWriteStream(destPath)
      res.on('data', chunk => {
        downloaded += chunk.length
        out.write(chunk)
        if (total > 0) onProgress(downloaded, total)
      })
      res.on('end',   () => { out.end(); resolve() })
      res.on('error', err => { out.destroy(); reject(err) })
      out.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * Download OllamaSetup.exe and open it via shell.openPath (no spawn).
 * The setup window will show a "Done — I installed it" button.
 * We wait for the user to confirm, then check if ollama is running.
 */
async function downloadAndOpenInstaller(onProgress, onStatus, onWaitForUser) {
  if (!fs.existsSync(OLLAMA_DIR)) fs.mkdirSync(OLLAMA_DIR, { recursive: true })

  const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe')
  _tryDelete(installerPath)
  await _sleep(300)

  onStatus('Fetching latest Ollama release info...')
  const { url } = await _getBinaryUrl()
  onStatus(`Downloading Ollama installer...`)

  await _streamToFile(url, installerPath, onProgress)

  onStatus('Opening installer — please complete the setup, then click “Done” below.')
  await shell.openPath(installerPath)

  // Hand control to the setup window — it will show a "Done" button
  // and call window.electronAPI.setupInstallerDone() when clicked
  await onWaitForUser()

  _tryDelete(installerPath)
}

function startOllamaServer(onStatus) {
  return new Promise((resolve, reject) => {
    onStatus('Starting Ollama server...')
    // Prefer system install, fall back to our managed copy
    const systemBin = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
    const bin = fs.existsSync(systemBin) ? systemBin
              : fs.existsSync(OLLAMA_BIN) ? OLLAMA_BIN
              : 'ollama'

    _ollamaProcess = spawn(bin, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'pipe',
    })
    _weStartedIt = true
    _ollamaProcess.stdout.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.stderr.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.on('exit', code => { console.log(`[ollama] exited ${code}`); _ollamaProcess = null })
    let attempts = 0
    const check = setInterval(async () => {
      if (await isOllamaRunning()) {
        clearInterval(check); onStatus('Ollama server is running.'); resolve()
      } else if (++attempts > 40) {
        clearInterval(check); reject(new Error('Ollama server did not start in time.'))
      }
    }, 500)
  })
}

function pullModel(model, onProgress, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus(`Pulling model ${model} — one-time ~2GB download...`)
    const body = JSON.stringify({ name: model, stream: true })
    const req = http.request({
      hostname: '127.0.0.1', port: OLLAMA_PORT, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n'); buf = lines.pop()
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
      res.on('end', () => { onStatus(`Model ${model} ready.`); resolve() })
      res.on('error', reject)
    })
    req.on('error', reject); req.write(body); req.end()
  })
}

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
  } catch (_) { return false }
}

async function ensureOllama({ onStep, onProgress, onStatus, onWaitForUser, onDone, onError }) {
  try {
    onStep(1, 3, 'Checking for Ollama...')
    if (await isOllamaRunning()) {
      onStatus('Ollama already running — skipping setup.')
      if (!await isModelPulled(DEFAULT_MODEL)) {
        onStep(2, 3, `Pulling model ${DEFAULT_MODEL}...`)
        await pullModel(DEFAULT_MODEL, onProgress, onStatus)
      }
      onStep(3, 3, 'Ready!'); onDone(); return
    }

    if (!isBinaryInstalled()) {
      onStep(1, 3, 'Downloading Ollama...')
      await downloadAndOpenInstaller(onProgress, onStatus, onWaitForUser)
    } else {
      onStatus('Ollama binary found.')
    }

    // After install, Ollama may already be running (installer auto-starts it)
    if (!await isOllamaRunning()) {
      onStep(2, 3, 'Starting Ollama server...')
      await startOllamaServer(onStatus)
    } else {
      onStatus('Ollama is already running after install.')
    }

    if (!await isModelPulled(DEFAULT_MODEL)) {
      onStep(3, 3, `Pulling model ${DEFAULT_MODEL}...`)
      await pullModel(DEFAULT_MODEL, onProgress, onStatus)
    } else {
      onStatus(`Model ${DEFAULT_MODEL} already present.`)
    }

    onStep(3, 3, 'Ready!'); onDone()
  } catch (err) {
    console.error('[ollama-manager] Error:', err)
    onError(err)
  }
}

function stopOllama() {
  if (!_weStartedIt || !_ollamaProcess) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', _ollamaProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' })
    } else {
      _ollamaProcess.kill('SIGTERM')
    }
  } catch (e) { console.warn('[ollama-manager] Could not kill Ollama:', e.message) }
  _ollamaProcess = null
}

module.exports = { ensureOllama, stopOllama, isOllamaRunning, DEFAULT_MODEL }
