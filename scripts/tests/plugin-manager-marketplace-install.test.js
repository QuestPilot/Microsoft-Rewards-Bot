'use strict'

// Integration test: PluginManager AUTO-INSTALLS a source:'marketplace' plugin that
// is NOT yet on disk. It downloads via an injected fetcher, verifies the signed
// catalog + pinned sha256, writes plugins/<name>/index.js, then loads it sandboxed.
// Complements plugin-manager-marketplace.test.js (which pre-places the file).
// Generates a real Ed25519 key and signs the catalog in-test.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const distPM = path.join(__dirname, '..', '..', 'dist', 'core', 'PluginManager.js')
const { signBytes } = require('../security/SignedManifest')

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

const SOURCE = `module.exports = { name:'auto-demo', version:'2.1.0', register(ctx){ ctx.log.info('main','AUTO','auto-installed-and-loaded'); } }`
const INSTALL_URL = 'https://cdn.jsdelivr.net/gh/example/auto-demo@2.1.0/index.js'

if (!available) {
    test(`PluginManager marketplace auto-install (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    let fixture
    let origCwd
    let prevKeysDir

    // (Re)write a freshly-signed catalog pinning `sha` for auto-demo, with a new key.
    function writeCatalog(sha) {
        const plugins = path.join(fixture, 'plugins')
        const keys = path.join(fixture, 'keys')
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
        fs.writeFileSync(path.join(keys, 'k.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
        const catalog = {
            format: 'msrb-marketplace',
            version: 1,
            sequence: 1,
            issuedAt: new Date().toISOString(),
            ttlSeconds: 31536000,
            killSwitch: false,
            plugins: [{ name: 'auto-demo', version: '2.1.0', apiVersion: '1.0.0', sha256: sha, installUrl: INSTALL_URL }],
            revoked: []
        }
        const json = JSON.stringify(catalog, null, 2)
        fs.writeFileSync(path.join(plugins, 'marketplace.json'), json)
        fs.writeFileSync(path.join(plugins, 'marketplace.sig'), signBytes(Buffer.from(json, 'utf8'), privateKey) + '\n')
    }

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mkt-auto-'))
        fs.mkdirSync(path.join(fixture, 'plugins'), { recursive: true })
        fs.mkdirSync(path.join(fixture, 'keys'), { recursive: true })
        // Deliberately do NOT create plugins/auto-demo/ — the manager must fetch it.
        fs.writeFileSync(
            path.join(fixture, 'plugins', 'plugins.jsonc'),
            JSON.stringify({ 'auto-demo': { enabled: true, source: 'marketplace', version: '2.1.0' } }, null, 2)
        )
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

    test('downloads, verifies, installs, then loads a marketplace plugin not yet on disk', async () => {
        writeCatalog(crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex'))
        const indexPath = path.join(fixture, 'plugins', 'auto-demo', 'index.js')
        assert.ok(!fs.existsSync(indexPath), 'precondition: plugin not on disk')

        const logs = []
        let fetchedUrl = null
        const pm = new PluginManager(makeBot(logs), {
            marketplaceFetcher: async url => {
                fetchedUrl = url
                return Buffer.from(SOURCE)
            }
        })
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')

        assert.equal(fetchedUrl, INSTALL_URL, `fetcher should be called with the catalog installUrl;${dump()}`)
        assert.ok(fs.existsSync(indexPath), `plugin source should be written to disk;${dump()}`)
        assert.ok(
            fs.existsSync(path.join(fixture, 'plugins', 'auto-demo', '.installed.json')),
            `install marker should be written;${dump()}`
        )
        assert.ok(logs.some(l => l.includes('Installed marketplace plugin: auto-demo@2.1.0')), `should log install;${dump()}`)
        assert.ok(logs.some(l => l.includes('Registered sandboxed plugin: auto-demo@2.1.0')), `should load sandboxed;${dump()}`)
        assert.ok(logs.some(l => l.includes('auto-installed-and-loaded')), `register() should run in the sandbox;${dump()}`)
        await pm.destroyAll()
    })

    test('refuses to install when fetched bytes do not match the pinned sha256 (fail closed)', async () => {
        writeCatalog(crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex'))
        fs.rmSync(path.join(fixture, 'plugins', 'auto-demo'), { recursive: true, force: true })

        const logs = []
        const pm = new PluginManager(makeBot(logs), {
            marketplaceFetcher: async () => Buffer.from(SOURCE + '// tampered')
        })
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')

        assert.ok(
            !fs.existsSync(path.join(fixture, 'plugins', 'auto-demo', 'index.js')),
            `tampered plugin must NOT be written;${dump()}`
        )
        assert.ok(!logs.some(l => l.includes('Registered sandboxed plugin: auto-demo')), `must NOT load;${dump()}`)
        assert.ok(logs.some(l => l.includes('not installed (sha-mismatch)')), `should report sha-mismatch;${dump()}`)
        await pm.destroyAll()
    })
}
