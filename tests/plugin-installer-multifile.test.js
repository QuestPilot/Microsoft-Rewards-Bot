'use strict'

// Phase 3 — multi-file (tree) install path of ensureMarketplacePlugin. A signed
// catalog entry carries a files[] manifest; the installer fetches + verifies every
// file (fail closed) and swaps the whole tree into place. Network-free + deterministic.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureMarketplacePlugin } = require('../scripts/plugin-installer')

const NOW = '2026-06-25T00:00:00Z'
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mf-'))
const dirOf = (root, name) => path.join(root, 'plugins', name)

function treeEntry(name, version, files) {
    const manifest = Object.keys(files).sort().map((p) => ({ path: p, sha256: sha256(files[p]) }))
    const manifestSha256 = sha256(manifest.map((f) => f.path + ':' + f.sha256).join('\n'))
    return { name, version, installUrl: `mem://${name}/${version}/`, files: manifest, manifestSha256, sha256: manifestSha256 }
}
const catalog = (entries) => ({ format: 'msrb-marketplace', sequence: 1, plugins: entries, revoked: [] })
function treeFetcher(name, version, files) {
    const prefix = `mem://${name}/${version}/`
    return async (url) => {
        if (!url.startsWith(prefix)) throw new Error('404 ' + url)
        const rel = url.slice(prefix.length)
        if (!(rel in files)) throw new Error('404 ' + url)
        return Buffer.from(files[rel])
    }
}

test('installs a multi-file plugin, verifying every file', async () => {
    const root = tmp()
    const files = { 'index.js': 'module.exports={register(){}}', 'package.json': '{"name":"p"}', 'lib/util.js': 'exports.x=1', 'README.md': '# p' }
    const e = treeEntry('p', '1.0.0', files)
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: treeFetcher('p', '1.0.0', files), now: NOW })
    assert.equal(r.installed, true)
    assert.equal(r.version, '1.0.0')
    for (const [p, c] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dirOf(root, 'p'), p), 'utf8'), c)
    const marker = JSON.parse(fs.readFileSync(path.join(dirOf(root, 'p'), '.installed.json'), 'utf8'))
    assert.equal(marker.manifestSha256, e.manifestSha256)
    assert.equal(marker.files.length, 4)
})

test('is idempotent / self-heals a correct tree without re-fetching', async () => {
    const root = tmp()
    const files = { 'index.js': 'a', 'b.js': 'b' }
    const e = treeEntry('p', '1.0.0', files)
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: treeFetcher('p', '1.0.0', files), now: NOW })
    let calls = 0
    const counting = async (url) => { calls++; return treeFetcher('p', '1.0.0', files)(url) }
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: counting, now: NOW })
    assert.equal(r.reason, 'up-to-date')
    assert.equal(calls, 0, 'must not re-fetch a tree that already matches the manifest')
})

test('fail-closed: a tampered file aborts the whole install (nothing written)', async () => {
    const root = tmp()
    const files = { 'index.js': 'good', 'evil.js': 'good' }
    const e = treeEntry('p', '1.0.0', files)
    const base = treeFetcher('p', '1.0.0', files)
    const tampered = async (url) => (url.endsWith('evil.js') ? Buffer.from('PWNED') : base(url))
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: tampered, now: NOW })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'sha-mismatch')
    assert.equal(fs.existsSync(dirOf(root, 'p')), false, 'no partial tree on failure')
})

test('rejects a manifest with no index.js entry point', async () => {
    const root = tmp()
    const files = { 'main.js': 'x' }
    const e = treeEntry('p', '1.0.0', files)
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: treeFetcher('p', '1.0.0', files), now: NOW })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'no-entry-file')
})

test('an update replaces the tree and drops files removed in the new version', async () => {
    const root = tmp()
    const v1 = { 'index.js': 'v1', 'old.js': 'old' }
    const v2 = { 'index.js': 'v2', 'new.js': 'new' }
    await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([treeEntry('p', '1.0.0', v1)]), fetcher: treeFetcher('p', '1.0.0', v1), now: NOW })
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([treeEntry('p', '2.0.0', v2)]), fetcher: treeFetcher('p', '2.0.0', v2), now: NOW })
    assert.equal(r.reason, 'updated')
    assert.equal(fs.readFileSync(path.join(dirOf(root, 'p'), 'index.js'), 'utf8'), 'v2')
    assert.equal(fs.existsSync(path.join(dirOf(root, 'p'), 'new.js')), true)
    assert.equal(fs.existsSync(path.join(dirOf(root, 'p'), 'old.js')), false, 'the removed file is gone after the swap')
})

test('refuses a manifest path that escapes the plugin directory (zip-slip guard)', async () => {
    const root = tmp()
    const e = {
        name: 'p', version: '1.0.0', installUrl: 'mem://p/1.0.0/', sha256: 'x', manifestSha256: 'x',
        files: [{ path: '../evil.js', sha256: sha256('x') }, { path: 'index.js', sha256: sha256('i') }],
    }
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog: catalog([e]), fetcher: async () => Buffer.from('x'), now: NOW })
    assert.equal(r.installed, false)
    assert.equal(r.reason, 'bad-manifest')
    assert.equal(fs.existsSync(dirOf(root, 'p')), false)
})
