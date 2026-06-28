'use strict'

// Security regression: a marketplace plugin elevated to Trusted Mode (trust:'full',
// runs IN-PROCESS, not sandboxed) is STILL verified against the signed catalog
// before any of its code runs. Tampered catalog => refused (fail closed). Valid =>
// loads in-process and logs a loud Trusted-Mode warning.

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

const SOURCE = `module.exports = { name:'trust-demo', version:'1.0.0', register(ctx){ ctx.log.info('main','TRUST','trusted-loaded'); } }`

if (!available) {
    test(`marketplace trusted-mode verification (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    let fixture
    let origCwd
    let prevKeysDir
    let privateKeyPem

    function writeCatalog() {
        const sha = crypto.createHash('sha256').update(Buffer.from(SOURCE)).digest('hex')
        const catalog = JSON.stringify(
            {
                format: 'msrb-marketplace',
                version: 1,
                sequence: 1,
                issuedAt: new Date().toISOString(),
                ttlSeconds: 31536000,
                killSwitch: false,
                plugins: [{ name: 'trust-demo', version: '1.0.0', apiVersion: '1.0.0', sha256: sha, installUrl: 'x' }],
                revoked: [],
            },
            null,
            2,
        )
        fs.writeFileSync(path.join(fixture, 'plugins', 'marketplace.json'), catalog)
        fs.writeFileSync(path.join(fixture, 'plugins', 'marketplace.sig'), signBytes(Buffer.from(catalog, 'utf8'), privateKeyPem) + '\n')
    }

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mkt-trust-'))
        fs.mkdirSync(path.join(fixture, 'plugins', 'trust-demo'), { recursive: true })
        fs.mkdirSync(path.join(fixture, 'keys'), { recursive: true })
        fs.writeFileSync(path.join(fixture, 'plugins', 'trust-demo', 'index.js'), SOURCE)
        fs.writeFileSync(
            path.join(fixture, 'plugins', 'plugins.jsonc'),
            JSON.stringify({ 'trust-demo': { enabled: true, source: 'marketplace', trust: 'full', version: '1.0.0' } }, null, 2),
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

    test('a valid Trusted-Mode marketplace plugin loads in-process and warns', async () => {
        writeCatalog()
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')
        assert.ok(
            logs.some(l => l.includes('Registered plugin: trust-demo@1.0.0') && !l.includes('sandboxed')),
            `should load IN-PROCESS (not sandboxed);${dump()}`,
        )
        assert.ok(logs.some(l => l.includes('trusted-loaded')), `register() ran in-process;${dump()}`)
        assert.ok(logs.some(l => l.includes('TRUSTED MODE')), `should warn about trusted mode;${dump()}`)
        await pm.destroyAll()
    })

    test('a Trusted-Mode marketplace plugin is REFUSED when the catalog is tampered (fail closed)', async () => {
        writeCatalog()
        const cat = path.join(fixture, 'plugins', 'marketplace.json')
        fs.writeFileSync(cat, fs.readFileSync(cat, 'utf8') + ' ')
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')
        assert.ok(!logs.some(l => l.includes('Registered plugin: trust-demo')), `must NOT load an untrusted full-access plugin;${dump()}`)
        assert.ok(
            logs.some(l => l.includes('Failed to load plugin "trust-demo"') && l.includes('marketplace catalog is not trusted')),
            `should fail closed with a marketplace reason;${dump()}`,
        )
        await pm.destroyAll()
    })
}
