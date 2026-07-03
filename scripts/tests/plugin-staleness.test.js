'use strict'

// Auto bot-version staleness: a plugin is stamped (server-side) with the bot version
// at publish time; the bot doesn't block, it just flags "may be outdated" once it has
// moved well ahead of that stamp.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { isPluginStale } = require('../security/marketplace-catalog')
const { ensureMarketplacePlugin } = require('../plugins/plugin-installer')

test('isPluginStale flags only when the bot is well ahead of the publish stamp', () => {
    assert.equal(isPluginStale('4.5.15', '4.5.15'), false, 'same version')
    assert.equal(isPluginStale('4.5.15', '4.5.35'), false, '+20 == window, not over')
    assert.equal(isPluginStale('4.5.15', '4.5.36'), true, '+21 > window')
    assert.equal(isPluginStale('4.5.0', '4.6.0'), true, 'minor bump')
    assert.equal(isPluginStale('4.5.0', '5.0.0'), true, 'major bump')
    assert.equal(isPluginStale('4.6.0', '4.5.0'), false, 'bot OLDER than publish stamp')
    assert.equal(isPluginStale('', '4.5.0'), false, 'no stamp')
    assert.equal(isPluginStale('4.5.0', ''), false, 'no bot version')
    assert.equal(isPluginStale('4.5.0', '4.5.30', 5), true, 'tighter custom window')
    assert.equal(isPluginStale('4.5.0', '4.5.03', 5), false, 'within tighter window')
})

test('the installer stamps publishedBotVersion into the marker + result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-stale-'))
    const code = 'module.exports={register(){}}'
    const sha = crypto.createHash('sha256').update(Buffer.from(code)).digest('hex')
    const catalog = {
        format: 'msrb-marketplace',
        sequence: 1,
        plugins: [{ name: 'p', version: '1.0.0', sha256: sha, installUrl: 'mem://p', publishedBotVersion: '4.5.0' }],
        revoked: [],
    }
    const r = await ensureMarketplacePlugin({ root, name: 'p', catalog, fetcher: async () => Buffer.from(code), now: '2026-06-25T00:00:00Z' })
    assert.equal(r.installed, true)
    assert.equal(r.publishedBotVersion, '4.5.0')
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'p', '.installed.json'), 'utf8'))
    assert.equal(marker.publishedBotVersion, '4.5.0')
})
