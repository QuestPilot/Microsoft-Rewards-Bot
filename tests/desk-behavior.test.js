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

const APP = path.join(__dirname, '..', 'scripts', 'app-window.js')

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
function request(reqPath, { method = 'GET', host, token: tok, origin } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {}
        if (host !== null) headers.host = host || `127.0.0.1:${port}`
        if (tok) headers['x-msrb-token'] = tok
        if (origin) headers.origin = origin
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
        req.end()
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
        env: { ...process.env, MSRB_APP_NO_OPEN: '1', MSRB_APP_PORT: String(port) },
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

// Refactor-safe UI contract: asserts the SERVED HTML (not the source text), so it
// survives splitting html() into modules. This behaviorally covers the element-ID
// and removed-legacy-control invariants that tests/app-window.test.js currently
// guards by grepping source — letting those grep anchors be retired during the
// Desk refactor without losing coverage.
test('GET / renders the expected view containers and controls', async () => {
    const html = (await request('/', { token: null })).body
    const required = [
        'view-accounts', 'view-console', 'view-settings', 'view-core', 'view-plugins', 'view-docs',
        'btn-run', 'btn-stop', 'tog-startup-desk', 'tog-startup-agent',
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
