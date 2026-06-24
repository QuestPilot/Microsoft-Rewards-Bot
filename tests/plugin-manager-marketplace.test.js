'use strict'

// Integration test for PluginManager marketplace enforcement (#10/#11):
// a source:'marketplace' plugin loads ONLY when the signed catalog vouches for it
// (valid signature + pinned sha256 matches the file). Otherwise it is refused
// (fail closed). Generates a real Ed25519 key and signs a catalog in-test.

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

const SOURCE = `module.exports = { name:'mkt-demo', version:'1.0.0', register(ctx){ ctx.log.info('main','MKT','mkt-loaded'); } }`

if (!available) {
    test(`PluginManager marketplace enforcement (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    let fixture
    let origCwd
    let prevKeysDir

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mkt-pm-'))
        const plugins = path.join(fixture, 'plugins')
        const keys = path.join(fixture, 'keys')
        fs.mkdirSync(path.join(plugins, 'mkt-demo'), { recursive: true })
        fs.mkdirSync(keys, { recursive: true })
        fs.writeFileSync(path.join(plugins, 'mkt-demo', 'index.js'), SOURCE)
        fs.writeFileSync(
            path.join(plugins, 'plugins.jsonc'),
            JSON.stringify({ 'mkt-demo': { enabled: true, source: 'marketplace', version: '1.0.0' } }, null, 2)
        )

        const sha = crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex')
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
        fs.writeFileSync(path.join(keys, 'k.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
        const catalog = {
            format: 'msrb-marketplace',
            version: 1,
            sequence: 1,
            issuedAt: new Date().toISOString(),
            ttlSeconds: 31536000,
            killSwitch: false,
            plugins: [{ name: 'mkt-demo', version: '1.0.0', sha256: sha, installUrl: 'x' }],
            revoked: []
        }
        const json = JSON.stringify(catalog, null, 2)
        fs.writeFileSync(path.join(plugins, 'marketplace.json'), json)
        fs.writeFileSync(path.join(plugins, 'marketplace.sig'), signBytes(Buffer.from(json, 'utf8'), privateKey) + '\n')

        prevKeysDir = process.env.MSRB_MARKETPLACE_KEYS_DIR
        process.env.MSRB_MARKETPLACE_KEYS_DIR = keys
        origCwd = process.cwd()
        process.chdir(fixture)
    })

    after(() => {
        if (origCwd) process.chdir(origCwd)
        if (prevKeysDir === undefined) delete process.env.MSRB_MARKETPLACE_KEYS_DIR
        else process.env.MSRB_MARKETPLACE_KEYS_DIR = prevKeysDir
        try { fs.rmSync(fixture, { recursive: true, force: true }) } catch {}
    })

    test('loads a marketplace plugin vouched for by the signed catalog', async () => {
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')
        assert.ok(logs.some(l => l.includes('Registered sandboxed plugin: mkt-demo@1.0.0')), `should register;${dump()}`)
        assert.ok(logs.some(l => l.includes('mkt-loaded')), `register() should run in the sandbox;${dump()}`)
        await pm.destroyAll()
    })

    test('refuses a marketplace plugin when the catalog is tampered (fail closed)', async () => {
        // Corrupt the signed catalog: signature no longer matches the bytes.
        const cat = path.join(fixture, 'plugins', 'marketplace.json')
        fs.writeFileSync(cat, fs.readFileSync(cat, 'utf8') + ' ')
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')
        assert.ok(!logs.some(l => l.includes('Registered sandboxed plugin: mkt-demo')), `must NOT load untrusted plugin;${dump()}`)
        assert.ok(
            logs.some(l => l.includes('Failed to load plugin "mkt-demo"') && l.includes('marketplace catalog is not trusted')),
            `should fail closed with a marketplace reason;${dump()}`
        )
        await pm.destroyAll()
    })
}
