'use strict'

// Verifies the plugin sandbox (scripts/plugin-sandbox.js) is a real capability
// boundary: the public API is bridged, plain data crosses, and the untrusted
// plugin cannot reach Node APIs. Also checks DoS containment (timeout) and that
// a disposed sandbox refuses further calls. The bridged logger follows the
// public PluginLogger contract: log.info(source, tag, message).

const { test } = require('node:test')
const assert = require('node:assert/strict')

let createPluginSandbox
try {
    ;({ createPluginSandbox } = require('../plugins/plugin-sandbox'))
} catch (err) {
    // isolated-vm is a native module; if it cannot load on this platform the
    // sandbox is unavailable and the bot falls back (warn/popup, headless
    // fail-closed). Skip rather than fail so CI on unsupported targets is clear.
    test('plugin sandbox (isolated-vm unavailable on this platform — skipped)', { skip: String(err && err.message || err) }, () => {})
}

function makeLog() {
    const lines = []
    const push = level => (_source, _tag, message) => lines.push(`${level}:${message}`)
    return { lines, log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') } }
}

if (createPluginSandbox) {
    test('exposes name/version metadata and runs register()', async () => {
        const { lines, log } = makeLog()
        const sb = await createPluginSandbox({
            source: `module.exports = {
                name: 'demo', version: '1.2.3',
                register(ctx){ ctx.log.info('main', 'DEMO', 'registered v' + ctx.apiVersion); }
            }`,
            apiVersion: '1.0.0',
            log
        })
        try {
            assert.equal(sb.name, 'demo')
            assert.equal(sb.version, '1.2.3')
            assert.ok(lines.includes('info:registered v1.0.0'), `register should log; got ${JSON.stringify(lines)}`)
        } finally {
            sb.dispose()
        }
    })

    test('plugin receives its own config (plain JSON only)', async () => {
        const { lines, log } = makeLog()
        const sb = await createPluginSandbox({
            source: `module.exports = { name:'c', version:'1', register(ctx){ ctx.log.info('main','C','cfg:' + ctx.config.greeting); } }`,
            config: { greeting: 'hi' },
            log
        })
        try {
            assert.ok(lines.includes('info:cfg:hi'))
        } finally {
            sb.dispose()
        }
    })

    test('notification sinks receive emitted notifications', async () => {
        const { lines, log } = makeLog()
        const sb = await createPluginSandbox({
            source: `module.exports = {
                name:'n', version:'1',
                register(ctx){ ctx.registerNotificationSink(function(notif){ ctx.log.info('main','N','sink:' + notif.type); }); }
            }`,
            log
        })
        try {
            assert.equal(sb.sinkCount, 1, 'sandbox should report one registered sink')
            await sb.emitNotification({ type: 'run-complete', points: 42 })
            assert.ok(lines.includes('info:sink:run-complete'), `sink should fire; got ${JSON.stringify(lines)}`)
        } finally {
            sb.dispose()
        }
    })

    test('lifecycle hooks receive their payload (e.g. tokenized email)', async () => {
        const { lines, log } = makeLog()
        const sb = await createPluginSandbox({
            source: `module.exports = {
                name:'l', version:'1', register(){},
                onAccountStart(ctx){ ctx.log.info('main','L','start:' + ctx.email); }
            }`,
            log
        })
        try {
            assert.equal(sb.hooks.onAccountStart, true)
            assert.equal(sb.sinkCount, 0)
            await sb.runLifecycle('onAccountStart', { email: 'tok_abc123' })
            assert.ok(lines.includes('info:start:tok_abc123'), `lifecycle should fire; got ${JSON.stringify(lines)}`)
        } finally {
            sb.dispose()
        }
    })

    test('plugin cannot see Node globals (process undefined, require blocked)', async () => {
        const { lines, log } = makeLog()
        const sb = await createPluginSandbox({
            source: `module.exports = { name:'s', version:'1', register(ctx){
                ctx.log.info('main','S','process:' + (typeof process));
                ctx.log.info('main','S','global:' + (typeof globalThis.process));
                ctx.log.info('main','S','childproc:' + (typeof globalThis.require));
                try { require('fs'); ctx.log.info('main','S','req:LEAKED'); } catch (e) { ctx.log.info('main','S','req:blocked'); }
            } }`,
            log
        })
        try {
            assert.ok(lines.includes('info:process:undefined'), `process must be undefined; got ${JSON.stringify(lines)}`)
            assert.ok(lines.includes('info:global:undefined'), 'globalThis.process must be undefined')
            assert.ok(lines.includes('info:childproc:undefined'), 'there is no global require in the isolate')
            assert.ok(lines.includes('info:req:blocked'), 'calling require() must be blocked, not leak fs')
        } finally {
            sb.dispose()
        }
    })

    test('require() inside a plugin is blocked (fails to load)', async () => {
        await assert.rejects(
            createPluginSandbox({ source: `const fs = require('fs'); module.exports = { name:'evil', version:'1', register(){} }` }),
            /require\("fs"\) is blocked/
        )
    })

    test('touching process at load throws (no host crash)', async () => {
        await assert.rejects(
            createPluginSandbox({ source: `process.exit(1); module.exports = { name:'evil', version:'1', register(){} }` }),
            /process is not defined|is not defined/
        )
    })

    test('an infinite loop at load is killed by the timeout (DoS containment)', async () => {
        const started = Date.now()
        await assert.rejects(
            createPluginSandbox({ source: `while(true){} module.exports = { name:'dos', version:'1', register(){} }`, timeoutMs: 500 }),
            /timed out|timeout|disposed/i
        )
        assert.ok(Date.now() - started < 5000, 'must not hang the host process')
    })

    test('a disposed sandbox refuses further calls', async () => {
        const { log } = makeLog()
        const sb = await createPluginSandbox({ source: `module.exports = { name:'d', version:'1', register(){} }`, log })
        sb.dispose()
        await assert.rejects(sb.emitNotification({ type: 'x' }), /disposed/)
    })
}
