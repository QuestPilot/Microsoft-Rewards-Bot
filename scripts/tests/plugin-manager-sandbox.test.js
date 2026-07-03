'use strict'

// Integration test for PluginManager's trust routing (Phase 1 / Task #4):
//   - a plugin marked trust:'sandbox' runs inside the isolate (no Node fs),
//   - a first-party plugin (no trust hint) runs in-process (fs works),
//   - host notifications and lifecycle events forward into the isolate.
//
// Requires a built dist/ (the suite already does — see dist-package-sync.test.js)
// and isolated-vm. Skips cleanly if either is unavailable.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const distPM = path.join(__dirname, '..', '..', 'dist', 'core', 'PluginManager.js')
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
    const rec = level => (_source, tag, message) => logs.push(`${level}|${tag}|${message}`)
    return { logger: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') } }
}

if (!available) {
    test(`PluginManager sandbox routing (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    let fixture
    let origCwd

    before(() => {
        fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-pm-'))
        const plugins = path.join(fixture, 'plugins')
        fs.mkdirSync(path.join(plugins, 'demo-sandbox'), { recursive: true })
        fs.mkdirSync(path.join(plugins, 'demo-trusted'), { recursive: true })
        fs.mkdirSync(path.join(plugins, 'demo-flaky'), { recursive: true })
        fs.writeFileSync(
            path.join(plugins, 'plugins.jsonc'),
            JSON.stringify(
                {
                    'demo-sandbox': { enabled: true, trust: 'sandbox' },
                    'demo-trusted': { enabled: true },
                    'demo-flaky': { enabled: true, trust: 'sandbox' }
                },
                null,
                2
            )
        )
        fs.writeFileSync(
            path.join(plugins, 'demo-sandbox', 'index.js'),
            `module.exports = {
                name: 'demo-sandbox', version: '1.0.0',
                register(ctx){
                    try { require('fs'); ctx.log.info('main','DEMO','fs:LEAKED'); }
                    catch (e) { ctx.log.info('main','DEMO','fs:blocked'); }
                    ctx.registerNotificationSink(function(n){ ctx.log.info('main','DEMO','notif:' + n.title); });
                },
                onAccountStart(ctx){ ctx.log.info('main','DEMO','start:' + ctx.email); }
            }`
        )
        fs.writeFileSync(
            path.join(plugins, 'demo-trusted', 'index.js'),
            `const fs = require('fs');
             module.exports = {
                name: 'demo-trusted', version: '1.0.0',
                register(ctx){ ctx.log.info('main','TRUST','fs:' + (typeof fs.readFileSync)); }
             }`
        )
        fs.writeFileSync(
            path.join(plugins, 'demo-flaky', 'index.js'),
            `module.exports = {
                name: 'demo-flaky', version: '1.0.0', register(){},
                onAccountStart(ctx){ ctx.log.info('main','FLAKY','flaky:run'); throw new Error('boom'); }
            }`
        )
        origCwd = process.cwd()
        process.chdir(fixture)
    })

    after(() => {
        if (origCwd) process.chdir(origCwd)
        try { fs.rmSync(fixture, { recursive: true, force: true }) } catch {}
    })

    test('routes untrusted -> isolate, first-party -> in-process, and forwards events', async () => {
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        const dump = () => '\n' + logs.join('\n')

        // The sandboxed plugin must NOT have Node fs, and must register cleanly.
        assert.ok(logs.some(l => l.includes('fs:blocked')), `sandboxed plugin must not reach fs; got:${dump()}`)
        assert.ok(!logs.some(l => l.includes('fs:LEAKED')), `sandboxed plugin leaked fs!${dump()}`)
        assert.ok(
            logs.some(l => l.includes('Registered sandboxed plugin: demo-sandbox@1.0.0')),
            `sandboxed plugin should register; got:${dump()}`
        )

        // The first-party plugin runs in-process, so real fs is available.
        assert.ok(logs.some(l => l.includes('fs:function')), `trusted plugin should run in-process; got:${dump()}`)

        // Host notification forwards across the boundary into the plugin's sink.
        await pm.notify({ title: 'Hello', message: 'x' })
        assert.ok(logs.some(l => l.includes('notif:Hello')), `notification should reach the sandbox sink; got:${dump()}`)

        // Lifecycle event forwards across the boundary, but the RAW email must not:
        // sandboxed plugins receive an HMAC token (acct_...), never the PII.
        await pm.notifyAccountStart('secret-user@example.com')
        assert.ok(logs.some(l => /start:acct_[0-9a-f]{16}/.test(l)), `sandbox should get a tokenized email; got:${dump()}`)
        assert.ok(!logs.some(l => l.includes('secret-user@example.com')), `raw email must NOT cross into the sandbox;${dump()}`)

        await pm.destroyAll()
    })

    test('circuit breaker disables a repeatedly-failing sandboxed plugin', async () => {
        const logs = []
        const pm = new PluginManager(makeBot(logs))
        await pm.loadPlugins()
        for (let i = 0; i < 4; i++) await pm.notifyAccountStart(`u${i}@x.com`)
        const dump = () => '\n' + logs.join('\n')
        const runs = logs.filter(l => l.includes('flaky:run')).length
        assert.equal(runs, 3, `flaky plugin should run exactly 3 times before the breaker trips; got ${runs}${dump()}`)
        assert.ok(logs.some(l => l.includes('disabled after 3 failures')), `breaker should disable the plugin;${dump()}`)
        await pm.destroyAll()
    })

    test('MSRB_DISABLE_PLUGINS=1 panic switch disables all non-core plugins', async () => {
        const prev = process.env.MSRB_DISABLE_PLUGINS
        process.env.MSRB_DISABLE_PLUGINS = '1'
        try {
            const logs = []
            const pm = new PluginManager(makeBot(logs))
            await pm.loadPlugins()
            const dump = () => '\n' + logs.join('\n')
            assert.ok(!logs.some(l => l.includes('Registered sandboxed plugin')), `no third-party plugin should load;${dump()}`)
            assert.ok(!logs.some(l => l.includes('fs:')), `no plugin register() should run;${dump()}`)
            assert.ok(logs.some(l => l.includes('MSRB_DISABLE_PLUGINS=1')), `should warn that plugins are disabled;${dump()}`)
            await pm.destroyAll()
        } finally {
            if (prev === undefined) delete process.env.MSRB_DISABLE_PLUGINS
            else process.env.MSRB_DISABLE_PLUGINS = prev
        }
    })
}
