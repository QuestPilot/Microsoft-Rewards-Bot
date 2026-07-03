'use strict'

// Verifies the on-demand marketplace installer (scripts/plugin-installer.js):
// fail-closed checks (catalog membership, revocation, version gating, sha256) and
// the install / up-to-date / re-install paths. Uses a fake fetcher (network-free).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureMarketplacePlugin } = require('../plugins/plugin-installer')

const SOURCE = `module.exports = { name: 'mkt', version: '1.0.0', register(){} }`
const SHA = crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex')

function catalog(over = {}) {
    return {
        format: 'msrb-marketplace',
        version: 1,
        sequence: 1,
        plugins: [{ name: 'mkt', version: '1.0.0', sha256: SHA, apiVersion: '1.0.0', botVersionRange: '>=4.0.0', installUrl: 'mem://mkt' }],
        revoked: [],
        ...over
    }
}

let root
let fetchCalls
const fetcher = async () => { fetchCalls++; return Buffer.from(SOURCE) }

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-inst-')) })
after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

function base(over = {}) {
    return { root, name: 'mkt', catalog: catalog(), fetcher, botVersion: '4.5.15', apiVersion: '1.0.0', ...over }
}

test('installs a fresh marketplace plugin and writes a verified marker', async () => {
    fetchCalls = 0
    const r = await ensureMarketplacePlugin(base())
    assert.deepEqual({ installed: r.installed, reason: r.reason, version: r.version }, { installed: true, reason: 'installed', version: '1.0.0' })
    const indexPath = path.join(root, 'plugins', 'mkt', 'index.js')
    assert.equal(fs.readFileSync(indexPath, 'utf8'), SOURCE)
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'mkt', '.installed.json'), 'utf8'))
    assert.equal(marker.version, '1.0.0')
    assert.equal(marker.sha256, SHA)
})

test('is idempotent: a second run is up-to-date and does not re-fetch', async () => {
    fetchCalls = 0
    const r = await ensureMarketplacePlugin(base())
    assert.equal(r.reason, 'up-to-date')
    assert.equal(fetchCalls, 0, 'must not re-download when already current')
})

test('rejects a sha256 mismatch (does not write tampered code)', async () => {
    const r = await ensureMarketplacePlugin(base({
        name: 'evil', root,
        catalog: catalog({ plugins: [{ name: 'evil', version: '1.0.0', sha256: 'd'.repeat(64), installUrl: 'mem://evil' }] }),
        fetcher: async () => Buffer.from('console.log("pwned")')
    }))
    assert.equal(r.reason, 'sha-mismatch')
    assert.ok(!fs.existsSync(path.join(root, 'plugins', 'evil', 'index.js')), 'tampered code must not be written')
})

test('refuses a revoked plugin', async () => {
    const r = await ensureMarketplacePlugin(base({ catalog: catalog({ revoked: [{ name: 'mkt', version: '1.0.0' }] }) }))
    assert.equal(r.reason, 'revoked')
})

test('refuses a plugin not present in the catalog', async () => {
    const r = await ensureMarketplacePlugin(base({ name: 'ghost' }))
    assert.equal(r.reason, 'not-in-catalog')
})

test('refuses an incompatible bot version', async () => {
    const r = await ensureMarketplacePlugin(base({
        catalog: catalog({ plugins: [{ name: 'mkt', version: '1.0.0', sha256: SHA, botVersionRange: '>=5.0.0', installUrl: 'mem://mkt' }] })
    }))
    assert.equal(r.reason, 'incompatible-bot')
})

test('refuses an incompatible plugin API major version', async () => {
    const r = await ensureMarketplacePlugin(base({
        catalog: catalog({ plugins: [{ name: 'mkt', version: '1.0.0', sha256: SHA, apiVersion: '2.0.0', installUrl: 'mem://mkt' }] })
    }))
    assert.equal(r.reason, 'incompatible-api')
})

test('re-installs when the catalog version changes', async () => {
    // fresh dir for a clean version-bump scenario
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-inst2-'))
    try {
        const v1 = `module.exports = { name:'mkt', version:'1.0.0', register(){} }`
        const v2 = `module.exports = { name:'mkt', version:'2.0.0', register(){} }`
        const sha1 = crypto.createHash('sha256').update(Buffer.from(v1)).digest('hex')
        const sha2 = crypto.createHash('sha256').update(Buffer.from(v2)).digest('hex')
        const cat1 = { format: 'msrb-marketplace', version: 1, sequence: 1, plugins: [{ name: 'mkt', version: '1.0.0', sha256: sha1, installUrl: 'x' }], revoked: [] }
        const cat2 = { format: 'msrb-marketplace', version: 1, sequence: 2, plugins: [{ name: 'mkt', version: '2.0.0', sha256: sha2, installUrl: 'x' }], revoked: [] }
        await ensureMarketplacePlugin({ root: dir, name: 'mkt', catalog: cat1, fetcher: async () => Buffer.from(v1), botVersion: '4.5.15', apiVersion: '1.0.0' })
        const r = await ensureMarketplacePlugin({ root: dir, name: 'mkt', catalog: cat2, fetcher: async () => Buffer.from(v2), botVersion: '4.5.15', apiVersion: '1.0.0' })
        assert.equal(r.reason, 'updated')
        assert.equal(r.version, '2.0.0')
        assert.equal(fs.readFileSync(path.join(dir, 'plugins', 'mkt', 'index.js'), 'utf8'), v2)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
