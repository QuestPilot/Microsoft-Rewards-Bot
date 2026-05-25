const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const CONFIG_PATH = path.join(PLUGINS_DIR, 'plugins.jsonc')
const CATALOG_PATH = path.join(PLUGINS_DIR, 'catalog.json')
const DEFAULT_PORT = Number(process.env.MSRB_PLUGINS_PORT ?? 4777)
const UPDATE_REPO = process.env.MSRB_UPDATE_REPO || 'QuestPilot/Microsoft-Rewards-Bot'
const UPDATE_BRANCH = process.env.MSRB_UPDATE_BRANCH || 'release'

const IGNORED_PLUGIN_FILES = new Set(['README.md', 'plugins.jsonc', 'official-core.json', 'catalog.json'])

function stripJsonc(input) {
    let output = ''
    let inString = false
    let quote = ''
    let escaping = false
    let inLineComment = false
    let inBlockComment = false

    for (let i = 0; i < input.length; i++) {
        const char = input[i]
        const next = input[i + 1]

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false
                output += char
            }
            continue
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false
                i++
            }
            continue
        }

        if (inString) {
            output += char
            if (escaping) {
                escaping = false
            } else if (char === '\\') {
                escaping = true
            } else if (char === quote) {
                inString = false
            }
            continue
        }

        if (char === '"' || char === "'") {
            inString = true
            quote = char
            output += char
            continue
        }

        if (char === '/' && next === '/') {
            inLineComment = true
            i++
            continue
        }

        if (char === '/' && next === '*') {
            inBlockComment = true
            i++
            continue
        }

        output += char
    }

    return output.replace(/,(\s*[}\]])/g, '$1')
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return fallback
    }
}

function readPluginConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return {}
        return JSON.parse(stripJsonc(fs.readFileSync(CONFIG_PATH, 'utf8')))
    } catch {
        return {}
    }
}

function writePluginConfig(config) {
    const header = ['{', '    // Plugin Configuration', '    // Only entries present here are eligible to load.', ''].join(
        '\n'
    )

    const body = JSON.stringify(config, null, 4).slice(1, -1).trim()
    const content = body ? `${header}${body}\n}\n` : `${header}}\n`
    fs.writeFileSync(CONFIG_PATH, content, 'utf8')
}

function hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function readInstalledPlugins() {
    if (!fs.existsSync(PLUGINS_DIR)) return []

    return fs
        .readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.') && !IGNORED_PLUGIN_FILES.has(entry.name))
        .map(entry => {
            const basePath = path.join(PLUGINS_DIR, entry.name)
            const packagePath = entry.isDirectory() ? path.join(basePath, 'package.json') : null
            const packageJson = packagePath ? readJson(packagePath, {}) : {}
            const entryFile = entry.isDirectory()
                ? fs.existsSync(path.join(basePath, 'index.jsc'))
                    ? path.join(basePath, 'index.jsc')
                    : path.join(basePath, 'index.js')
                : basePath

            return {
                name: entry.name.replace(/\.(jsc|js)$/i, ''),
                kind: entry.isDirectory() ? 'directory' : 'file',
                packageName: packageJson.name ?? null,
                version: packageJson.version ?? null,
                description: packageJson.description ?? null,
                official: packageJson.msrb?.officialPlugin === 'core' || entry.name === 'core',
                entryFile: path.relative(ROOT, entryFile).replace(/\\/g, '/'),
                sha256: hashFile(entryFile)
            }
        })
}

function getCatalogEntries() {
    const catalog = readJson(CATALOG_PATH, { plugins: [] })
    return Array.isArray(catalog.plugins) ? catalog.plugins : []
}

function findCatalogEntry(name) {
    return getCatalogEntries().find(plugin => plugin.name === name)
}

function verifyPlugin(plugin) {
    const catalogEntry = findCatalogEntry(plugin.name)
    const expected = plugin.name === 'core'
        ? readJson(path.join(PLUGINS_DIR, 'official-core.json'), null)?.indexSha256 ?? catalogEntry?.sha256
        : catalogEntry?.sha256

    if (!expected || expected.includes('placeholder')) {
        return { status: 'unknown', expected: expected ?? null, actual: plugin.sha256, message: 'No trusted checksum' }
    }

    if (!plugin.sha256) {
        return { status: 'failed', expected, actual: null, message: 'Entry file missing' }
    }

    if (plugin.sha256.toLowerCase() !== expected.toLowerCase()) {
        return { status: 'failed', expected, actual: plugin.sha256, message: 'Checksum mismatch' }
    }

    return { status: 'verified', expected, actual: plugin.sha256, message: 'Checksum verified' }
}

function getState() {
    const config = readPluginConfig()
    const installed = readInstalledPlugins().map(plugin => {
        const entry = config[plugin.name]
        const catalogEntry = findCatalogEntry(plugin.name)
        return {
            ...plugin,
            configured: Boolean(entry),
            enabled: Boolean(entry && entry.enabled !== false),
            priority: entry?.priority ?? null,
            config: entry?.config ?? {},
            catalog: catalogEntry ?? null,
            integrity: verifyPlugin(plugin)
        }
    })

    return {
        bot: readJson(path.join(ROOT, 'package.json'), {}),
        config,
        installed,
        catalog: getCatalogEntries(),
        officialCore: readJson(path.join(PLUGINS_DIR, 'official-core.json'), null),
        updateRepo: UPDATE_REPO,
        updateBranch: UPDATE_BRANCH
    }
}

function readBody(req) {
    return new Promise(resolve => {
        let body = ''
        req.on('data', chunk => {
            body += chunk
        })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {})
            } catch {
                resolve({})
            }
        })
    })
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data, null, 2))
}

function sendHtml(res) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
}

function getInstalledPlugin(name) {
    return readInstalledPlugins().find(plugin => plugin.name === name)
}

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res)
        return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, getState())
        return
    }

    const verifyMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/verify$/)
    if (req.method === 'POST' && verifyMatch) {
        const name = decodeURIComponent(verifyMatch[1])
        const plugin = getInstalledPlugin(name)
        if (!plugin) {
            sendJson(res, 404, { error: `Plugin "${name}" is not installed` })
            return
        }
        sendJson(res, 200, verifyPlugin(plugin))
        return
    }

    const toggleMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/toggle$/)
    if (req.method === 'POST' && toggleMatch) {
        const name = decodeURIComponent(toggleMatch[1])
        const body = await readBody(req)
        const plugin = getInstalledPlugin(name)

        if (!plugin) {
            sendJson(res, 404, { error: `Plugin "${name}" is not installed` })
            return
        }

        const integrity = verifyPlugin(plugin)
        if (body.enabled && integrity.status === 'failed') {
            sendJson(res, 409, { error: integrity.message, integrity })
            return
        }

        const config = readPluginConfig()
        config[name] = {
            ...(config[name] ?? {}),
            enabled: Boolean(body.enabled),
            priority: config[name]?.priority ?? (name === 'core' ? 100 : 50)
        }
        writePluginConfig(config)
        sendJson(res, 200, getState())
        return
    }

    const addMatch = url.pathname.match(/^\/api\/catalog\/([^/]+)\/add$/)
    if (req.method === 'POST' && addMatch) {
        const name = decodeURIComponent(addMatch[1])
        const item = findCatalogEntry(name)
        const plugin = getInstalledPlugin(name)

        if (!item) {
            sendJson(res, 404, { error: `Catalog plugin "${name}" not found` })
            return
        }

        if (!plugin) {
            sendJson(res, 409, {
                error: `Plugin "${name}" is not installed locally yet`,
                installUrl: item.installUrl ?? null,
                supportUrl: item.supportUrl ?? null,
                purchaseUrl: item.purchaseUrl ?? null
            })
            return
        }

        const integrity = verifyPlugin(plugin)
        if (integrity.status === 'failed') {
            sendJson(res, 409, { error: integrity.message, integrity })
            return
        }

        const config = readPluginConfig()
        config[name] = {
            ...(config[name] ?? {}),
            enabled: true,
            priority: config[name]?.priority ?? 50
        }
        writePluginConfig(config)
        sendJson(res, 200, getState())
        return
    }

    sendJson(res, 404, { error: 'Not found' })
}

function startServer(port, attemptsLeft = 10) {
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(error => sendJson(res, 500, { error: error.message }))
    })

    server.on('error', error => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
            startServer(port + 1, attemptsLeft - 1)
            return
        }
        throw error
    })

    server.listen(port, '127.0.0.1', () => {
        console.log(`Plugin manager available at http://127.0.0.1:${port}`)
    })
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Microsoft Rewards Bot Plugin Desk</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --ink: #17191c;
      --muted: #5b626c;
      --line: #d9dee5;
      --soft: #eef2f6;
      --good: #0b7a53;
      --warn: #9a5b00;
      --bad: #b42318;
      --accent: #0067b8;
      --accent-2: #163b73;
      --shadow: 0 14px 36px rgba(23, 25, 28, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(180deg, #ffffff 0, var(--bg) 320px),
        var(--bg);
      font-family: "Aptos", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    main { width: min(1280px, calc(100vw - 28px)); margin: 0 auto; padding: 22px 0 40px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: end;
      padding: 10px 0 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 30px; line-height: 1.05; letter-spacing: 0; }
    .subtitle { margin: 7px 0 0; color: var(--muted); max-width: 760px; font-size: 14px; }
    .topline { display: flex; flex-wrap: wrap; gap: 8px; justify-content: end; }
    .metric {
      min-width: 150px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      box-shadow: var(--shadow);
    }
    .metric span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .metric strong { display: block; margin-top: 3px; font-size: 14px; overflow-wrap: anywhere; }
    .tabs {
      display: flex;
      gap: 4px;
      margin: 18px 0 14px;
      border-bottom: 1px solid var(--line);
    }
    .tab {
      border: 0;
      border-bottom: 3px solid transparent;
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      padding: 12px 14px 10px;
      font-weight: 700;
    }
    .tab.active { color: var(--accent-2); border-bottom-color: var(--accent); }
    .panel { display: none; }
    .panel.active { display: block; }
    .toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
    .toolbar h2 { margin: 0; font-size: 18px; }
    .count { color: var(--muted); font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; }
    .name { margin: 0; font-size: 17px; line-height: 1.25; }
    .desc { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .pill {
      border: 1px solid var(--line);
      background: var(--soft);
      color: var(--muted);
      border-radius: 999px;
      padding: 4px 7px;
      font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .pill.good { color: var(--good); border-color: rgba(11,122,83,.3); background: #eefaf5; }
    .pill.warn { color: var(--warn); border-color: rgba(154,91,0,.3); background: #fff7e6; }
    .pill.bad { color: var(--bad); border-color: rgba(180,35,24,.3); background: #fff0ee; }
    .checksum {
      margin-top: 10px;
      padding: 8px;
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--muted);
      font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    button, a.button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      border-radius: 6px;
      padding: 8px 10px;
      font: 700 13px "Aptos", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      text-decoration: none;
      min-height: 34px;
    }
    button.secondary, a.secondary { background: white; color: var(--accent-2); border-color: var(--line); }
    button.danger { background: var(--bad); border-color: var(--bad); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 24px;
      color: var(--muted);
      background: rgba(255,255,255,.65);
    }
    .settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 12px;
    }
    .kv { display: grid; grid-template-columns: 140px minmax(0,1fr); gap: 8px; font-size: 13px; }
    .kv div { padding: 7px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: 420px;
      background: var(--ink);
      color: white;
      padding: 12px 14px;
      border-radius: 7px;
      box-shadow: var(--shadow);
      transform: translateY(18px);
      opacity: 0;
      transition: .16s ease;
      font-size: 13px;
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    @media (max-width: 820px) {
      header { grid-template-columns: 1fr; }
      .topline { justify-content: start; }
      .metric { min-width: min(100%, 180px); }
      .tabs { overflow-x: auto; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Plugin Desk</h1>
        <p class="subtitle">Local management for installed plugins, Core entitlement, marketplace entries, checksums, and update readiness.</p>
      </div>
      <div class="topline">
        <div class="metric"><span>Bot</span><strong id="bot-version">loading</strong></div>
        <div class="metric"><span>Core</span><strong id="core-status">loading</strong></div>
        <div class="metric"><span>Updates</span><strong id="update-status">loading</strong></div>
      </div>
    </header>

    <nav class="tabs" aria-label="Plugin desk sections">
      <button class="tab active" data-tab="installed">Installed</button>
      <button class="tab" data-tab="catalog">Catalog</button>
      <button class="tab" data-tab="updates">Updates</button>
      <button class="tab" data-tab="settings">Settings</button>
    </nav>

    <section id="installed" class="panel active">
      <div class="toolbar"><h2>Installed Plugins</h2><span id="installed-count" class="count"></span></div>
      <div id="installed-list" class="grid"></div>
    </section>

    <section id="catalog" class="panel">
      <div class="toolbar"><h2>Catalog</h2><span id="catalog-count" class="count"></span></div>
      <div id="catalog-list" class="grid"></div>
    </section>

    <section id="updates" class="panel">
      <div class="toolbar"><h2>Update Manifest</h2><span class="count">npm start checks automatically</span></div>
      <div id="updates-list" class="settings"></div>
    </section>

    <section id="settings" class="panel">
      <div class="toolbar"><h2>Local Configuration</h2><span class="count">plugins/plugins.jsonc</span></div>
      <div id="settings-list" class="settings"></div>
    </section>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script>
    const $ = selector => document.querySelector(selector)
    const installedEl = $('#installed-list')
    const catalogEl = $('#catalog-list')
    const updatesEl = $('#updates-list')
    const settingsEl = $('#settings-list')
    const toastEl = $('#toast')
    let lastState = null

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
    }

    function toast(message) {
      toastEl.textContent = message
      toastEl.classList.add('show')
      setTimeout(() => toastEl.classList.remove('show'), 2600)
    }

    async function api(path, options) {
      const response = await fetch(path, options)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Request failed')
      return data
    }

    function pill(text, kind = '') {
      return '<span class="pill ' + kind + '">' + esc(text) + '</span>'
    }

    function integrityPill(integrity) {
      if (!integrity) return pill('not checked', 'warn')
      if (integrity.status === 'verified') return pill('verified', 'good')
      if (integrity.status === 'failed') return pill('checksum failed', 'bad')
      return pill('checksum unknown', 'warn')
    }

    function pluginCard(plugin) {
      const enabled = plugin.enabled
      const action = enabled
        ? '<button class="danger" data-toggle="' + esc(plugin.name) + '" data-enabled="false">Disable</button>'
        : '<button data-toggle="' + esc(plugin.name) + '" data-enabled="true">Enable</button>'
      return '<article class="card">' +
        '<div class="head"><div><h3 class="name">' + esc(plugin.name) + '</h3><p class="desc">' + esc(plugin.description || plugin.packageName || 'Local plugin') + '</p></div>' +
        '<div>' + (enabled ? pill('enabled', 'good') : pill(plugin.configured ? 'disabled' : 'not configured', 'warn')) + '</div></div>' +
        '<div class="meta">' +
        pill(plugin.version || 'no version') +
        pill(plugin.kind) +
        (plugin.official ? pill('official core', 'good') : '') +
        integrityPill(plugin.integrity) +
        (plugin.priority !== null ? pill('priority ' + plugin.priority) : '') +
        '</div>' +
        '<div class="checksum">entry: ' + esc(plugin.entryFile) + '<br>sha256: ' + esc(plugin.sha256 || 'missing') + '<br>expected: ' + esc(plugin.integrity?.expected || 'not pinned') + '</div>' +
        '<div class="actions">' + action + '<button class="secondary" data-verify="' + esc(plugin.name) + '">Verify</button></div>' +
        '</article>'
    }

    function catalogCard(plugin, installedNames) {
      const installed = installedNames.has(plugin.name)
      const local = lastState.installed.find(item => item.name === plugin.name)
      const links = [
        plugin.supportUrl ? '<a class="button secondary" href="' + esc(plugin.supportUrl) + '" target="_blank" rel="noreferrer">Support</a>' : '',
        plugin.purchaseUrl ? '<a class="button secondary" href="' + esc(plugin.purchaseUrl) + '" target="_blank" rel="noreferrer">Purchase</a>' : '',
        plugin.installUrl ? '<a class="button secondary" href="' + esc(plugin.installUrl) + '" target="_blank" rel="noreferrer">Source</a>' : ''
      ].join('')

      return '<article class="card">' +
        '<div class="head"><div><h3 class="name">' + esc(plugin.name) + '</h3><p class="desc">' + esc(plugin.description || 'Marketplace plugin') + '</p></div>' +
        '<div>' + (installed ? integrityPill(local?.integrity) : pill(plugin.license || 'external')) + '</div></div>' +
        '<div class="meta">' +
        pill(plugin.version || 'no version') +
        pill(plugin.botVersionRange || 'any bot') +
        pill(plugin.price || 'free') +
        '</div>' +
        '<div class="checksum">expected sha256: ' + esc(plugin.sha256 || 'provided by author') + '</div>' +
        '<div class="actions"><button data-add="' + esc(plugin.name) + '">' + (installed ? 'Enable' : 'Check install') + '</button>' + links + '</div>' +
        '</article>'
    }

    function renderUpdates(state) {
      $('#update-status').textContent = state.updateBranch + ' branch'
      updatesEl.innerHTML = '<article class="card"><div class="kv">' +
        '<div>Repository</div><div>' + esc(state.updateRepo) + '</div>' +
        '<div>Branch</div><div>' + esc(state.updateBranch) + '</div>' +
        '<div>Local bot</div><div>' + esc(state.bot.version || 'unknown') + '</div>' +
        '<div>Source</div><div>GitHub branch package.json, then immutable commit tarball</div>' +
        '<div>Docker</div><div>Notification only; pull or rebuild the image</div>' +
        '</div><div class="actions"><button class="secondary" data-refresh>Refresh</button></div></article>'
    }

    function renderSettings(state) {
      settingsEl.innerHTML = '<article class="card"><div class="kv">' +
        '<div>Config path</div><div>plugins/plugins.jsonc</div>' +
        '<div>Configured</div><div>' + esc(Object.keys(state.config || {}).join(', ') || 'none') + '</div>' +
        '<div>Core manifest</div><div>' + esc(state.officialCore ? state.officialCore.indexSha256 : 'missing') + '</div>' +
        '<div>Auto-update</div><div>Enabled on npm start for local installs; Docker is notification-only</div>' +
        '</div></article>'
    }

    async function load() {
      const state = await api('/api/state')
      lastState = state
      $('#bot-version').textContent = state.bot.version || 'unknown'
      $('#installed-count').textContent = state.installed.length + ' found'
      $('#catalog-count').textContent = state.catalog.length + ' listed'
      $('#core-status').textContent = state.officialCore
        ? 'manifest ' + state.officialCore.version + ' / ' + state.officialCore.indexSha256.slice(0, 12)
        : 'manifest missing'

      installedEl.innerHTML = state.installed.length
        ? state.installed.map(pluginCard).join('')
        : '<div class="empty">No plugins installed.</div>'

      const installedNames = new Set(state.installed.map(plugin => plugin.name))
      catalogEl.innerHTML = state.catalog.length
        ? state.catalog.map(plugin => catalogCard(plugin, installedNames)).join('')
        : '<div class="empty">No catalog entries yet.</div>'

      renderUpdates(state)
      renderSettings(state)
    }

    document.addEventListener('click', async event => {
      const tab = event.target.closest('[data-tab]')
      const toggle = event.target.closest('[data-toggle]')
      const add = event.target.closest('[data-add]')
      const verify = event.target.closest('[data-verify]')
      const refresh = event.target.closest('[data-refresh]')

      if (tab) {
        document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab))
        document.querySelectorAll('.panel').forEach(item => item.classList.toggle('active', item.id === tab.dataset.tab))
        return
      }

      try {
        if (toggle) {
          await api('/api/plugins/' + encodeURIComponent(toggle.dataset.toggle) + '/toggle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: toggle.dataset.enabled === 'true' })
          })
          toast('Plugin configuration updated')
          await load()
        }
        if (verify) {
          const result = await api('/api/plugins/' + encodeURIComponent(verify.dataset.verify) + '/verify', { method: 'POST' })
          toast(result.message)
          await load()
        }
        if (add) {
          await api('/api/catalog/' + encodeURIComponent(add.dataset.add) + '/add', { method: 'POST' })
          toast('Catalog plugin enabled')
          await load()
        }
        if (refresh) {
          await load()
          toast('State refreshed')
        }
      } catch (error) {
        toast(error.message)
      }
    })

    load().catch(error => toast(error.message))
  </script>
</body>
</html>`

startServer(DEFAULT_PORT)
