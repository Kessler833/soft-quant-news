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
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')

const OLLAMA_PORT = 11434
const OLLAMA_HOST = `http://127.0.0.1:${OLLAMA_PORT}`
const DEFAULT_MODEL = 'qwen2.5:3b'

const OLLAMA_DIR = path.join(app.getPath('userData'), 'ollama')
const OLLAMA_BIN = path.join(OLLAMA_DIR, process.platform === 'win32' ? 'ollama.exe' : 'ollama')

let _ollamaProcess = null
let _weStartedIt   = false

// ── Resolve latest release tag from GitHub API ────────────────────────────────

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
          resolve(json.tag_name) // e.g. "v0.6.1"
        } catch (e) {
          reject(new Error('Failed to parse GitHub release response: ' + e.message))
        }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * Get the actual download URL for the Ollama binary.
 * Windows  → OllamaSetup.exe  (self-contained installer, ~100MB)
 * macOS    → Ollama-darwin.zip
 * Linux    → ollama-linux-amd64
 */
async function _getBinaryUrl() {
  const tag = await _getLatestTag()
  const base = `https://github.com/ollama/ollama/releases/download/${tag}`
  switch (process.platform) {
    case 'win32':  return { url: `${base}/OllamaSetup.exe`,       isInstaller: true  }
    case 'darwin': return { url: `${base}/Ollama-darwin.zip`,     isInstaller: false }
    default:       return { url: `${base}/ollama-linux-amd64`,    isInstaller: false }
  }
}

// ── Check if Ollama is already running ────────────────────────────────────────

function isOllamaRunning() {
  return new Promise(resolve => {
    http.get(`${OLLAMA_HOST}/api/tags`, res => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

// ── Check if we already downloaded it ────────────────────────────────────────

function isBinaryInstalled() {
  return fs.existsSync(OLLAMA_BIN)
}

// ── Download helpers ──────────────────────────────────────────────────────────

/**
 * Follow redirects and stream a URL to a local file path.
 */
function _streamToFile(reqUrl, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'))
    const mod = reqUrl.startsWith('https') ? https : http
    mod.get(reqUrl, { headers: { 'User-Agent': 'soft-quant-news' } }, res => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return _streamToFile(res.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`))
      }

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

// ── Download binary ───────────────────────────────────────────────────────────

function downloadBinary(onProgress, onStatus) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(OLLAMA_DIR)) fs.mkdirSync(OLLAMA_DIR, { recursive: true })

      onStatus('Fetching latest Ollama release info...')
      const { url, isInstaller } = await _getBinaryUrl()
      onStatus(`Downloading Ollama (${url.split('/').pop()})...`)
      console.log('[ollama-manager] Downloading from:', url)

      const tmpPath = OLLAMA_BIN + '.tmp'

      await _streamToFile(url, tmpPath, onProgress)

      if (isInstaller) {
        // Windows: run the silent installer, it puts ollama.exe in %LOCALAPPDATA%\Programs\Ollama
        // We still save the installer so we can detect it later
        onStatus('Running Ollama installer (silent)...')
        await new Promise((res2, rej2) => {
          const proc = spawn(tmpPath, ['/VERYSILENT', '/NORESTART'], { stdio: 'ignore', detached: false })
          proc.on('exit', code => {
            if (code === 0) res2()
            else rej2(new Error(`Installer exited with code ${code}`))
          })
          proc.on('error', rej2)
        })
        fs.unlinkSync(tmpPath)

        // After install, ollama.exe is in PATH — write a shim in our OLLAMA_BIN location
        // pointing to the real exe so isBinaryInstalled() works next time
        const systemBin = path.join(
          process.env.LOCALAPPDATA || '',
          'Programs', 'Ollama', 'ollama.exe'
        )
        if (fs.existsSync(systemBin)) {
          // Copy it to our managed dir so we can launch it ourselves
          fs.copyFileSync(systemBin, OLLAMA_BIN)
        } else {
          // Installer should have added it to PATH — write a tiny .cmd shim
          fs.writeFileSync(OLLAMA_BIN.replace('.exe', '.cmd'), `@echo off\nollama %*\n`)
        }
      } else {
        fs.renameSync(tmpPath, OLLAMA_BIN)
        if (process.platform !== 'win32') fs.chmodSync(OLLAMA_BIN, 0o755)
      }

      onStatus('Ollama binary ready.')
      resolve()
    } catch (err) {
      reject(err)
    }
  })
}

// ── Start server ──────────────────────────────────────────────────────────────

function startOllamaServer(onStatus) {
  return new Promise((resolve, reject) => {
    onStatus('Starting Ollama server...')

    // Prefer system-installed ollama (from PATH) if our copy doesn't exist
    const bin = fs.existsSync(OLLAMA_BIN) ? OLLAMA_BIN : 'ollama'

    _ollamaProcess = spawn(bin, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'pipe',
    })
    _weStartedIt = true

    _ollamaProcess.stdout.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.stderr.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.on('exit', code => {
      console.log(`[ollama] Server exited with code ${code}`)
      _ollamaProcess = null
    })

    let attempts = 0
    const check = setInterval(async () => {
      attempts++
      if (await isOllamaRunning()) {
        clearInterval(check)
        onStatus('Ollama server is running.')
        resolve()
      } else if (attempts > 40) {
        clearInterval(check)
        reject(new Error('Ollama server did not start in time.'))
      }
    }, 500)
  })
}

// ── Pull model ────────────────────────────────────────────────────────────────

function pullModel(model, onProgress, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus(`Pulling model ${model} — one-time ~2GB download...`)
    const body = JSON.stringify({ name: model, stream: true })
    const req = http.request({
      hostname: '127.0.0.1',
      port: OLLAMA_PORT,
      path: '/api/pull',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
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
      res.on('end',   () => { onStatus(`Model ${model} ready.`); resolve() })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
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
  } catch (_) {
    return false
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function ensureOllama({ onStep, onProgress, onStatus, onDone, onError }) {
  try {
    onStep(1, 3, 'Checking for Ollama...')
    if (await isOllamaRunning()) {
      onStatus('Ollama already running — skipping setup.')
      if (!await isModelPulled(DEFAULT_MODEL)) {
        onStep(2, 3, `Pulling model ${DEFAULT_MODEL}...`)
        await pullModel(DEFAULT_MODEL, onProgress, onStatus)
      }
      onStep(3, 3, 'Ready!')
      onDone()
      return
    }

    if (!isBinaryInstalled()) {
      onStep(1, 3, 'Downloading Ollama...')
      await downloadBinary(onProgress, onStatus)
    } else {
      onStatus('Ollama binary found.')
    }

    onStep(2, 3, 'Starting Ollama server...')
    await startOllamaServer(onStatus)

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

// ── Safe shutdown ─────────────────────────────────────────────────────────────

function stopOllama() {
  if (!_weStartedIt || !_ollamaProcess) return
  console.log('[ollama-manager] Shutting down Ollama server...')
  try {
    if (process.platform === 'win32') {
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
