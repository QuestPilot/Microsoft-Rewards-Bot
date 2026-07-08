'use strict'

// Behavior harness for the Rewards Desk (scripts/app-window.js).
//
// Unlike tests/app-window.test.js (which greps the source TEXT and therefore
// breaks the moment code is moved into new files), this boots the Desk as a
// real subprocess and asserts its HTTP contract: the localhost security gate
// (token + host/origin), the docs viewer, the plugins listing, and the
// path-traversal guard. It is the refactor-safe anchor — it must keep passing
// as the monolith is split into modules, and it proves actual behavior.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const APP = path.join(__dirname, '..', 'desk', 'app-window.js')

let child
let port
let token
let stderr = ''

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port
            srv.close(() => resolve(p))
        })
    })
}

// Minimal HTTP client with FULL header control (fetch forbids setting Host).
function request(reqPath, { method = 'GET', host, token: tok, origin, body: reqBody } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {}
        if (host !== null) headers.host = host || `127.0.0.1:${port}`
        if (tok) headers['x-msrb-token'] = tok
        if (origin) headers.origin = origin
        if (reqBody != null) headers['content-length'] = Buffer.byteLength(reqBody)
        const req = http.request(
            { host: '127.0.0.1', port, path: reqPath, method, headers },
            res => {
                let body = ''
                res.on('data', c => (body += c))
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
            }
        )
        req.on('error', reject)
        req.setTimeout(8000, () => req.destroy(new Error('request timeout')))
        req.end(reqBody != null ? reqBody : undefined)
    })
}

async function waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        try {
            const res = await request('/', { token: null, host: `127.0.0.1:${port}` })
            if (res.status === 200) return res
        } catch {
            // server not listening yet — retry
        }
        if (Date.now() > deadline) {
            throw new Error(`Desk did not become ready in ${timeoutMs}ms.\n--- stderr ---\n${stderr.slice(-2000)}`)
        }
        await new Promise(r => setTimeout(r, 150))
    }
}

function killTree(proc) {
    return new Promise(resolve => {
        if (!proc || !proc.pid || proc.exitCode !== null) return resolve()
        if (process.platform === 'win32') {
            const k = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
            k.on('exit', () => resolve())
            k.on('error', () => {
                try { proc.kill('SIGKILL') } catch {}
                resolve()
            })
        } else {
            try { process.kill(-proc.pid, 'SIGKILL') } catch {
                try { proc.kill('SIGKILL') } catch {}
            }
            resolve()
        }
    })
}

before(async () => {
    port = await freePort()
    child = spawn(process.execPath, [APP], {
        // MSRB_DESK_LAN=0 keeps the test server bound to loopback only (no 0.0.0.0 bind
        // → no Windows Firewall prompt in CI; the host/origin gate assertions stay exact).
        env: { ...process.env, MSRB_APP_NO_OPEN: '1', MSRB_APP_PORT: String(port), MSRB_DESK_LAN: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // group-lead on POSIX so killTree can take down the spawned account worker too
        detached: process.platform !== 'win32'
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    const ready = await waitReady()
    const m = ready.body.match(/var API_TOKEN = ("[^"]*");/)
    assert.ok(m, 'served HTML must embed the per-process API_TOKEN')
    token = JSON.parse(m[1])
    assert.ok(token && token.length >= 20, 'API_TOKEN must be a non-empty random token')
})

after(async () => {
    await killTree(child)
})

test('GET / serves the SPA without auth and embeds a usable token', async () => {
    const res = await request('/', { token: null })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] || '', /text\/html/)
})

test('/api/* without a token is rejected (401)', async () => {
    const res = await request('/api/plugins', { token: null })
    assert.equal(res.status, 401)
})

test('/api/* with a mismatched Host header is rejected (403)', async () => {
    const res = await request('/api/plugins', { token, host: '127.0.0.1:1' })
    assert.equal(res.status, 403)
})

test('/api/* with a mismatched Origin header is rejected (403)', async () => {
    const res = await request('/api/plugins', { token, origin: 'http://evil.example' })
    assert.equal(res.status, 403)
})

test('GET /__desk_ping is ungated and advertises the Desk for remote embedding', async () => {
    const res = await request('/__desk_ping', { token: null })
    assert.equal(res.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.desk, true)
    assert.equal(typeof data.port, 'number')
    assert.ok('lanUrl' in data && 'lanEnabled' in data, 'ping reports LAN coordinates')
    // Reached by an HTTPS page (the remote dashboard) → must opt in to Private Network Access.
    assert.equal(res.headers['access-control-allow-private-network'], 'true')
})

test('OPTIONS preflight from the pinned Nexus origin is allowed', async () => {
    const res = await request('/__desk_ping', { method: 'OPTIONS', token: null, origin: 'https://bot.lgtw.tf' })
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'https://bot.lgtw.tf')
    assert.equal(res.headers['access-control-allow-private-network'], 'true')
})

test('POST /api/alive is accepted (lets a refreshed page cancel a pending shutdown)', async () => {
    const res = await request('/api/alive', { method: 'POST', token })
    assert.equal(res.status, 204)
})

test('GET /api/plugins returns the plugin listing shape', async () => {
    const res = await request('/api/plugins', { token })
    assert.equal(res.status, 200)
    const data = JSON.parse(res.body)
    assert.ok(Array.isArray(data.plugins), 'response has a plugins array')
    assert.ok('hasCoreLicense' in data, 'response reports core license state')
    assert.ok(data.plugins.some(p => p.name === 'core'), 'core plugin is listed')
})

test('GET /api/docs lists the documentation pages', async () => {
    const res = await request('/api/docs', { token })
    assert.equal(res.status, 200)
    const list = JSON.parse(res.body)
    assert.ok(Array.isArray(list.files) && list.files.length > 0, 'docs list has a non-empty files array')
    assert.ok(list.files.some(d => d.name === 'plugins.md'), 'plugins.md is listed')
})

test('GET /api/docs?file=<name> serves raw markdown', async () => {
    const res = await request('/api/docs?file=plugins.md', { token })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] || '', /text\/markdown/)
    assert.ok(res.body.length > 0, 'markdown body is non-empty')
})

test('GET /api/docs?file=<traversal> is blocked (404)', async () => {
    const res = await request('/api/docs?file=../package.json', { token })
    assert.equal(res.status, 404)
})

test('GET /api/state returns a state object', async () => {
    const res = await request('/api/state', { token })
    assert.equal(res.status, 200)
    const state = JSON.parse(res.body)
    assert.equal(typeof state, 'object')
    assert.ok(state !== null)
})

// Regression: the Settings page reads s.globalTimeout and s.searchSettings.* to
// populate the "Global timeout" / search-tuning fields on load (see the ss.*
// reads in app-window.js's settings renderer). The GET handler used to omit
// both from its response, so those fields — and the parallelSearching /
// scrollRandomResults / clickRandomResults toggles — always rendered blank or
// default on every page load, even though the value was correctly saved to
// config.json. Users reported this as "changes to config.json never apply".
test('GET /api/settings echoes globalTimeout and searchSettings so saved values survive a reload', async () => {
    const res = await request('/api/settings', { token })
    assert.equal(res.status, 200)
    const settings = JSON.parse(res.body)
    assert.ok('globalTimeout' in settings, 'globalTimeout must be present so the Settings page does not blank it out')
    assert.equal(typeof settings.searchSettings, 'object')
    assert.ok(settings.searchSettings !== null)
    for (const key of ['searchResultVisitTime', 'searchDelay', 'readDelay', 'parallelSearching', 'scrollRandomResults', 'clickRandomResults']) {
        assert.ok(key in settings.searchSettings, `searchSettings.${key} must be present`)
    }
})

// Regression: the "Next run at HH:MM (in Xh Ym)" countdown used to be computed
// entirely client-side from the BROWSER's local clock (next.setHours(...)), so it
// silently ignored scheduler.timezone — wrong the moment Desk is viewed from a
// different timezone than the configured one (e.g. a VPS bot viewed remotely).
// schedulerNextRunAt is the fix: computed server-side via the same Scheduler.ts
// Intl timezone math the real scheduler loop uses, so the client only ever diffs
// two absolute instants.
test('GET /api/settings reports a server-computed schedulerNextRunAt when the scheduler is enabled', async () => {
    const disabled = await request('/api/settings', { token })
    assert.equal(JSON.parse(disabled.body).schedulerNextRunAt, null, 'disabled scheduler must report no next run')

    const patch = await request('/api/settings', {
        method: 'POST',
        token,
        body: JSON.stringify({ scheduler: { enabled: true, startTime: '08:00', timezone: 'Europe/Paris' } })
    })
    assert.equal(patch.status, 204)

    try {
        const enabled = await request('/api/settings', { token })
        assert.equal(enabled.status, 200)
        const settings = JSON.parse(enabled.body)
        assert.ok(settings.schedulerNextRunAt, 'enabled scheduler must report a next run timestamp')
        const nextRun = new Date(settings.schedulerNextRunAt)
        assert.ok(!Number.isNaN(nextRun.getTime()), 'schedulerNextRunAt must be a valid ISO timestamp')
        assert.ok(nextRun.getTime() > Date.now(), 'the next run must be in the future')
    } finally {
        // Restore the repo's real config.json to its original (disabled) state.
        const restore = await request('/api/settings', {
            method: 'POST',
            token,
            body: JSON.stringify({ scheduler: { enabled: false } })
        })
        assert.equal(restore.status, 204)
    }
})

// Refactor-safe UI contract: asserts the SERVED HTML (not the source text), so it
// survives splitting html() into modules. This behaviorally covers the element-ID
// and removed-legacy-control invariants that tests/app-window.test.js currently
// guards by grepping source — letting those grep anchors be retired during the
// Desk refactor without losing coverage.
test('GET / renders the expected view containers and controls', async () => {
    const html = (await request('/', { token: null })).body
    const required = [
        'view-accounts', 'view-console', 'view-settings', 'view-core', 'view-plugins', 'view-docs',
        'btn-run', 'btn-stop', 'tog-startup-desk', 'tog-remote-access',
        'storage-toggle', 'lic-view-manage', 'install-btn', 'desktop-uninstall'
    ]
    for (const id of required) {
        assert.ok(html.includes(`id="${id}"`), `served HTML must contain #${id}`)
    }
    // Legacy controls removed in the desktop redesign must not reappear.
    for (const gone of ['id="modal"', 'id="lic-input"', 'id="lic-submit"', 'id="lic-skip"']) {
        assert.ok(!html.includes(gone), `served HTML must not contain ${gone}`)
    }
})

test('GET / wires the token into the page and links the web manifest', async () => {
    const html = (await request('/', { token: null })).body
    assert.match(html, /var API_TOKEN = "[^"]+"/, 'client must receive the per-process token')
    assert.match(html, /\/manifest\.json/, 'desktop window links a web manifest')
    assert.match(html, /Rewards Bot/, 'app title present')
})
