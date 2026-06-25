'use strict'

// Phase 2 — auto-update / held / revocation behaviour of ensureMarketplacePlugin.
// Calls the installer directly with a plain (already-verified) catalog object + an
// in-memory fetcher + a temp root, so it is network-free and deterministic.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureMarketplacePlugin } = require('../scripts/plugin-installer')
const { findLatestEntry, cmpVersion } = require('../scripts/security/marketplace-catalog')

const NOW = '2026-06-25T00:00:00Z'
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-au-'))
const entry = (name, version, code) => ({ name, version, sha256: sha256(Buffer.from(code)), installUrl: `mem://${name}@${version}` })
const catalog = (entries, extra) => Object.assign({ format: 'msrb-marketplace', sequence: 1, plugins: entries, revoked: [] }, extra || {})
const fetcherFor = (map) => async (url) => { if (!(url in map)) throw new Error('404 ' + url); return Buffer.from(map[url]) }
const indexOf = (root, name) => path.join(root, 'plugins', name, 'index.js')
const FETCH = fetcherFor({ 'mem://p@1.0.0': 'v1code', 'mem://p@2.0.0': 'v2code' })

test('unpinned plugin installs the LATEST catalog version', async () => {
    const root = tmp()
    const c = catalog([entry('p', '1.0.0', 'v1code'), entry('p', '2.0.0', 'v2code')])
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: c, fetcher: FETCH, now: NOW })
    assert.equal(r.installed, true)
    assert.equal(r.version, '2.0.0')
    assert.equal(fs.readFileSync(indexOf(root, 'p'), 'utf8'), 'v2code')
})

test('unpinned plugin AUTO-UPDATES when a newer version appears', async () => {
    const root = tmp()
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code')]), fetcher: FETCH, now: NOW })
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code'), entry('p', '2.0.0', 'v2code')]), fetcher: FETCH, now: NOW })
    assert.equal(r.reason, 'updated')
    assert.equal(r.version, '2.0.0')
    assert.equal(fs.readFileSync(indexOf(root, 'p'), 'utf8'), 'v2code')
})

test('autoUpdate:false HOLDS the installed version and reports updateAvailable', async () => {
    const root = tmp()
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code')]), fetcher: FETCH, now: NOW })
    const c = catalog([entry('p', '1.0.0', 'v1code'), entry('p', '2.0.0', 'v2code')])
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: c, fetcher: FETCH, autoUpdate: false, now: NOW })
    assert.equal(r.version, '1.0.0', 'held at the installed version')
    assert.equal(r.updateAvailable, '2.0.0')
    assert.equal(fs.readFileSync(indexOf(root, 'p'), 'utf8'), 'v1code')
})

test('Trusted Mode plugins are held back from silent auto-update', async () => {
    const root = tmp()
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code')]), fetcher: FETCH, now: NOW })
    const c = catalog([entry('p', '1.0.0', 'v1code'), entry('p', '2.0.0', 'v2code')])
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: c, fetcher: FETCH, trust: 'full', now: NOW })
    assert.equal(r.version, '1.0.0', 'trusted plugin stays put until a manual update')
    assert.equal(r.updateAvailable, '2.0.0')
})

test('a pinned version installs exactly and is never auto-updated', async () => {
    const root = tmp()
    const c = catalog([entry('p', '1.0.0', 'v1code'), entry('p', '2.0.0', 'v2code')])
    const r = await ensureMarketplacePlugin({ root, name: 'p', requestedVersion: '1.0.0', catalog: c, fetcher: FETCH, now: NOW })
    assert.equal(r.version, '1.0.0')
    assert.equal(r.updateAvailable, '2.0.0', 'still surfaces that a newer one exists')
    assert.equal(fs.readFileSync(indexOf(root, 'p'), 'utf8'), 'v1code')
})

test('revocation deletes the installed plugin folder (fail closed)', async () => {
    const root = tmp()
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code')]), fetcher: FETCH, now: NOW })
    assert.ok(fs.existsSync(indexOf(root, 'p')))
    const c = catalog([entry('p', '1.0.0', 'v1code')], { revoked: [{ name: 'p' }] })
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: c, fetcher: FETCH, now: NOW })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'revoked')
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'p')), false, 'folder removed')
})

test('kill switch purges and refuses every plugin', async () => {
    const root = tmp()
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([entry('p', '1.0.0', 'v1code')]), fetcher: FETCH, now: NOW })
    const c = catalog([entry('p', '1.0.0', 'v1code')], { killSwitch: true })
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: c, fetcher: FETCH, now: NOW })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'kill-switch')
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'p')), false)
})

test('findLatestEntry + cmpVersion pick the highest version', () => {
    assert.equal(cmpVersion('2.0.0', '1.9.9'), 1)
    assert.equal(cmpVersion('1.0.0', '1.0.0'), 0)
    assert.equal(cmpVersion('1.2.0', '1.10.0'), -1)
    const c = catalog([entry('p', '1.0.0', 'a'), entry('p', '2.3.1', 'b'), entry('p', '2.0.0', 'c')])
    assert.equal(findLatestEntry(c, 'p').version, '2.3.1')
    assert.equal(findLatestEntry(c, 'missing'), undefined)
})
