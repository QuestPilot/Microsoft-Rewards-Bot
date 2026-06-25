'use strict'

// Integration test for the full bot-side loop: PluginManager SYNCS the signed
// catalog from core-api (injected catalogFetcher) -> caches plugins/marketplace.json
// + .sig -> verifies it -> auto-installs the plugin (injected marketplaceFetcher) ->
// loads it sandboxed. No catalog is pre-placed on disk; the sync must create it.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const distPM = path.join(__dirname, '..', 'dist', 'core', 'PluginManager.js')
const { signBytes } = require('../scripts/security/SignedManifest')

let PluginManager
let available = fs.existsSync(distPM)
let skipReason = 'dist not built — run `npm run build`'
if (available) {
    try {
        require('isolated-vm')
        ;({ PluginManager } = require(distPM))
    } catch (err) {
        available = false
        skipReason = `dependency unavailable: ${err && err.message ? err.message : err}`
    }
}

function makeBot(logs) {
    const rec = level => (_s, tag, message) => logs.push(`${level}|${tag}|${message}`)
    return { logger: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') } }
}

const SOURCE = `module.exports = { name:'sync-demo', version:'1.0.0', register(ctx){ ctx.log.info('main','SYNC','synced-and-loaded'); } }`
const CATALOG_URL = 'https://bot.lgtw.tf/api/marketplace/catalog'

if (!available) {
    test(`marketplace catalog sync (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    let fixture
    let origCwd
    let prevKeysDir
    let privateKeyPem

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mkt-sync-'))
        fs.mkdirSync(path.join(fixture, 'plugins'), { recursive: true })
        fs.mkdirSync(path.join(fixture, 'keys'), { recursive: true })
        fs.writeFileSync(
            path.join(fixture, 'plugins', 'plugins.jsonc'),
            JSON.stringify({ 'sync-demo': { enabled: true, source: 'marketplace', version: '1.0.0' } }, null, 2),
        )
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
        fs.writeFileSync(path.join(fixture, 'keys', 'k.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
        privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
        prevKeysDir = process.env.MSRB_MARKETPLACE_KEYS_DIR
        process.env.MSRB_MARKETPLACE_KEYS_DIR = path.join(fixture, 'keys')
        origCwd = process.cwd()
        process.chdir(fixture)
    })

    after(() => {
        if (origCwd) process.chdir(origCwd)
        if (prevKeysDir === undefined) delete process.env.MSRB_MARKETPLACE_KEYS_DIR
        else process.env.MSRB_MARKETPLACE_KEYS_DIR = prevKeysDir
        try { fs.rmSync(fixture, { recursive: true, force: true }) } catch {}
    })

    test('fetches + caches the signed catalog from the configured URL, then installs', async () => {
        const sha = crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex')
        const catalog = JSON.stringify(
            {
                format: 'msrb-marketplace',
                version: 1,
                sequence: 5,
                issuedAt: new Date().toISOString(),
                ttlSeconds: 31536000,
                killSwitch: false,
                plugins: [
                    {
                        name: 'sync-demo',
                        version: '1.0.0',
                        apiVersion: '1.0.0',
                        sha256: sha,
                        installUrl: 'https://cdn.jsdelivr.net/gh/QuestPilot/marketplace-plugins@abc/sync-demo/1.0.0/index.js',
                    },
                ],
                revoked: [],
            },
            null,
            2,
        )
        const signature = signBytes(Buffer.from(catalog, 'utf8'), privateKeyPem)

        const catalogPath = path.join(fixture, 'plugins', 'marketplace.json')
        assert.ok(!fs.existsSync(catalogPath), 'precondition: no cached catalog on disk')

        const logs = []
        let fetchedCatalogUrl = null
        const pm = new PluginManager(makeBot(logs), {
            marketplaceCatalogUrl: CATALOG_URL,
            catalogFetcher: async url => {
                fetchedCatalogUrl = url
                return { catalog, signature }
            },
            marketplaceFetcher: async () => Buffer.from(SOURCE),
        })
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')

        assert.equal(fetchedCatalogUrl, CATALOG_URL, `catalog fetched from the configured URL;${dump()}`)
        assert.ok(fs.existsSync(catalogPath), `catalog cached to plugins/marketplace.json;${dump()}`)
        assert.ok(fs.existsSync(path.join(fixture, 'plugins', 'marketplace.sig')), `signature cached;${dump()}`)
        assert.ok(fs.existsSync(path.join(fixture, 'plugins', 'sync-demo', 'index.js')), `plugin installed;${dump()}`)
        assert.ok(logs.some(l => l.includes('Registered sandboxed plugin: sync-demo@1.0.0')), `loaded sandboxed;${dump()}`)
        assert.ok(logs.some(l => l.includes('synced-and-loaded')), `register() ran in the sandbox;${dump()}`)
        await pm.destroyAll()
    })
}
