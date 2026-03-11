/**
 * ollama-manager.js
 * Full Ollama lifecycle manager:
 *   1. Check if already running  → skip to model check
 *   2. Check if binary installed → if not, download installer & wait
 *   3. Start the server
 *   4. Pull the default model if missing
 */

const { app, shell } = require('electron')
const { spawn }      = require('child_process')
const path           = require('path')
const fs             = require('fs')
const http           = require('http')
const https          = require('https')
const os             = require('os')

const OLLAMA_PORT    = 11434
const OLLAMA_HOST    = `http://127.0.0.1:${OLLAMA_PORT}`
const DEFAULT_MODEL  = 'phi4-mini'

// Where we store a bundled binary if the user used our download path
const OLLAMA_DIR  = path.join(app.getPath('userData'), 'ollama')
const OLLAMA_BIN  = path.join(OLLAMA_DIR, process.platform === 'win32' ? 'ollama.exe' : 'ollama')

let _ollamaProcess = null
let _weStartedIt   = false

// ── tiny helpers ─────────────────────────────────────────────────────────────

const _sleep = ms => new Promise(r => setTimeout(r, ms))

function _tryDelete(p) { try { fs.unlinkSync(p) } catch (_) {} }

// ── is Ollama already answering? ─────────────────────────────────────────────

function isOllamaRunning() {
  return new Promise(resolve => {
    http.get(`${OLLAMA_HOST}/api/tags`, res => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

// ── find the ollama binary ────────────────────────────────────────────────────

function _findBin() {
  // 1. system install (Windows default path)
  const system = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Programs', 'Ollama', 'ollama.exe'
  )
  if (fs.existsSync(system))  return system
  // 2. our own downloaded copy
  if (fs.existsSync(OLLAMA_BIN)) return OLLAMA_BIN
  // 3. hope it is on PATH
  return process.platform === 'win32' ? 'ollama.exe' : 'ollama'
}

function isBinaryInstalled() {
  const system = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Programs', 'Ollama', 'ollama.exe'
  )
  return fs.existsSync(system) || fs.existsSync(OLLAMA_BIN)
}

// ── GitHub release info ───────────────────────────────────────────────────────

function _getLatestTag() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: '/repos/ollama/ollama/releases/latest',
      headers: { 'User-Agent': 'soft-quant-news', Accept: 'application/vnd.github+json' },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(data)
          if (!j.tag_name) return reject(new Error('No tag_name in release response'))
          resolve(j.tag_name)
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function _getInstallerUrl() {
  const tag = await _getLatestTag()
  const base = `https://github.com/ollama/ollama/releases/download/${tag}`
  if (process.platform === 'win32')  return `${base}/OllamaSetup.exe`
  if (process.platform === 'darwin') return `${base}/Ollama-darwin.zip`
  return `${base}/ollama-linux-amd64`
}

// ── file downloader with redirect support ────────────────────────────────────

function _streamToFile(reqUrl, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'))
    const mod = reqUrl.startsWith('https') ? https : http
    mod.get(reqUrl, { headers: { 'User-Agent': 'soft-quant-news' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return _streamToFile(res.headers.location, destPath, onProgress, redirectCount + 1)
          .then(resolve).catch(reject)
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`))
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

// ── download installer & open it; wait for user to click "Done" ──────────────

async function downloadAndOpenInstaller(onProgress, onStatus, onWaitForUser) {
  if (!fs.existsSync(OLLAMA_DIR)) fs.mkdirSync(OLLAMA_DIR, { recursive: true })
  const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe')
  _tryDelete(installerPath)
  await _sleep(200)

  onStatus('Fetching latest Ollama release info…')
  const url = await _getInstallerUrl()
  onStatus('Downloading Ollama installer…')
  await _streamToFile(url, installerPath, onProgress)

  onStatus('Opening installer — complete setup, then click "Done" below.')
  await shell.openPath(installerPath)

  // Wait for user to confirm the installer finished
  await onWaitForUser()

  // Give Windows a moment to finish writing the binary
  await _sleep(1500)
  _tryDelete(installerPath)
}

// ── start the server and wait until it answers ───────────────────────────────

function startOllamaServer(onStatus) {
  return new Promise((resolve, reject) => {
    onStatus('Starting Ollama server…')
    const bin = _findBin()
    _ollamaProcess = spawn(bin, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'pipe',
    })
    _weStartedIt = true
    _ollamaProcess.stdout.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.stderr.on('data', d => console.log('[ollama]', d.toString().trim()))
    _ollamaProcess.on('exit', code => {
      console.log(`[ollama] exited ${code}`)
      _ollamaProcess = null
    })

    let attempts = 0
    const check = setInterval(async () => {
      if (await isOllamaRunning()) {
        clearInterval(check)
        onStatus('Ollama server is running.')
        resolve()
      } else if (++attempts > 60) {   // 30 s
        clearInterval(check)
        reject(new Error('Ollama server did not start within 30 s.'))
      }
    }, 500)
  })
}

// ── pull a model, streaming NDJSON progress ───────────────────────────────────

function pullModel(model, onProgress, onStatus) {
  return new Promise((resolve, reject) => {
    onStatus(`Pulling model ${model} — one-time ~2.5 GB download…`)
    const body = JSON.stringify({ name: model, stream: true })
    const req  = http.request({
      hostname: '127.0.0.1', port: OLLAMA_PORT,
      path: '/api/pull', method: 'POST',
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
            if (typeof obj.completed === 'number' && obj.total > 0)
              onProgress(obj.completed, obj.total)
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
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
      }).on('error', reject)
    })
    return (tags.models || []).some(m => m.name.startsWith(model.split(':')[0]))
  } catch (_) { return false }
}

// ── main entry point ──────────────────────────────────────────────────────────

async function ensureOllama({ onStep, onProgress, onStatus, onWaitForUser, onDone, onError }) {
  try {
    // ── Step 1: check if already running ────────────────────────────────────
    onStep(1, 3, 'Checking for Ollama…')
    if (await isOllamaRunning()) {
      onStatus('Ollama is already running.')
      // still ensure the model is present
      if (!await isModelPulled(DEFAULT_MODEL)) {
        onStep(2, 3, `Pulling model ${DEFAULT_MODEL}…`)
        await pullModel(DEFAULT_MODEL, onProgress, onStatus)
      } else {
        onStatus(`Model ${DEFAULT_MODEL} already present.`)
      }
      onStep(3, 3, 'Ready!')
      onDone()
      return
    }

    // ── Step 2: install if needed ─────────────────────────────────────────────
    if (!isBinaryInstalled()) {
      onStep(1, 3, 'Downloading Ollama installer…')
      await downloadAndOpenInstaller(onProgress, onStatus, onWaitForUser)

      // Re-check binary — the user may have aborted the installer
      if (!isBinaryInstalled()) {
        throw new Error(
          'Ollama binary not found after installer ran. ' +
          'Please install Ollama manually from https://ollama.com and restart.'
        )
      }
    } else {
      onStatus('Ollama binary found.')
    }

    // ── Step 3: start server (if not already up after install) ───────────────
    if (!await isOllamaRunning()) {
      onStep(2, 3, 'Starting Ollama server…')
      await startOllamaServer(onStatus)
    } else {
      onStatus('Ollama already running after install.')
    }

    // ── Step 4: pull model ───────────────────────────────────────────────────
    if (!await isModelPulled(DEFAULT_MODEL)) {
      onStep(3, 3, `Pulling model ${DEFAULT_MODEL}…`)
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

module.exports = { ensureOllama, stopOllama, isOllamaRunning, isBinaryInstalled, DEFAULT_MODEL }
