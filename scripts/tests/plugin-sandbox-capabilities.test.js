'use strict'

// Verifies the Phase 2 capabilities are bridged into the V8 isolate correctly and stay
// JSON-only: a sandboxed plugin can read ctx.settings, use ctx.storage (round-tripped to
// the host), and push a ctx.ui.panel snapshot — with NO Node access. Skips cleanly if
// isolated-vm is unavailable.

const { test } = require('node:test')
const assert = require('node:assert/strict')

let createPluginSandbox
let available = true
let skipReason = ''
try {
    require('isolated-vm')
    ;({ createPluginSandbox } = require('../plugins/plugin-sandbox'))
} catch (err) {
    available = false
    skipReason = `dependency unavailable: ${err && err.message ? err.message : err}`
}

if (!available) {
    test(`plugin sandbox capabilities (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    test('sandboxed plugin reads settings, uses storage, and pushes a panel', async () => {
        // A host-side in-memory storage double + a panel sink.
        const backing = new Map()
        const storage = {
            get: (k) => (backing.has(k) ? backing.get(k) : undefined),
            set: (k, v) => backing.set(k, v),
            delete: (k) => backing.delete(k),
            keys: () => [...backing.keys()],
        }
        let lastPanel = null
        const source = `
            module.exports = {
                name: 'cap-demo', version: '1.0.0',
                register(ctx) {
                    ctx.storage.set('seen', (ctx.storage.get('seen') || 0) + 1);
                    var euros = (ctx.storage.get('seen') * 100) / ctx.settings.pointsPerEuro;
                    ctx.ui.panel({ title: 'Demo', stats: [{ label: 'Euros', value: euros.toFixed(2) }] });
                    // Prove the sandbox is still sealed.
                    ctx.storage.set('hasProcess', typeof process === 'undefined' ? 'no' : 'yes');
                }
            }`
        const sandbox = await createPluginSandbox({
            source,
            settings: { pointsPerEuro: 50 },
            storage,
            onPanel: (data) => { lastPanel = data },
            timeoutMs: 4000,
        })
        try {
            assert.equal(sandbox.name, 'cap-demo')
            // storage round-tripped to the host
            assert.equal(backing.get('seen'), 1)
            assert.equal(backing.get('hasProcess'), 'no', 'process must be undefined inside the isolate')
            // settings were readable (100 / 50 = 2.00)
            assert.ok(lastPanel, 'panel pushed')
            assert.equal(lastPanel.title, 'Demo')
            assert.equal(lastPanel.stats[0].value, '2.00')
        } finally {
            sandbox.dispose()
        }
    })

    test('ctx.fetch is bridged to the host broker and returns its JSON result', async () => {
        // A fake broker whose fetchJson echoes a canned response — proves the async
        // Reference bridge works without any real network.
        const calls = []
        const fetchBroker = {
            fetchJson: async (argsJson) => {
                calls.push(JSON.parse(argsJson))
                return JSON.stringify({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"price":42}' })
            },
        }
        const source = `
            module.exports = {
                name: 'net-demo', version: '1.0.0',
                async register(ctx) {
                    var res = await ctx.fetch('https://api.example.com/price', { method: 'GET' });
                    ctx.log.info('main', 'NET', 'status=' + res.status + ' body=' + res.body);
                }
            }`
        const logs = []
        const sandbox = await createPluginSandbox({
            source,
            fetchBroker,
            log: { info: (_s, _t, m) => logs.push(m) },
            timeoutMs: 4000,
        })
        try {
            assert.equal(calls.length, 1)
            assert.equal(calls[0].url, 'https://api.example.com/price')
            assert.ok(logs.some((l) => l.includes('status=200') && l.includes('price')), 'plugin saw the brokered response')
        } finally {
            sandbox.dispose()
        }
    })

    test('ctx.fetch rejects when no broker (no net permission) was wired', async () => {
        const source = `
            module.exports = {
                name: 'no-net', version: '1.0.0',
                async register(ctx) {
                    try { await ctx.fetch('https://api.example.com/x'); ctx.log.info('main','NET','UNEXPECTED'); }
                    catch (e) { ctx.log.info('main','NET','blocked:' + e.message); }
                }
            }`
        const logs = []
        const sandbox = await createPluginSandbox({ source, log: { info: (_s, _t, m) => logs.push(m) }, timeoutMs: 4000 })
        try {
            assert.ok(logs.some((l) => /blocked:.*no granted network/.test(l)), 'fetch without a grant is rejected')
        } finally {
            sandbox.dispose()
        }
    })

    test('storage persists across lifecycle calls within a run', async () => {
        const backing = new Map()
        const storage = {
            get: (k) => (backing.has(k) ? backing.get(k) : undefined),
            set: (k, v) => backing.set(k, v),
            delete: (k) => backing.delete(k),
            keys: () => [...backing.keys()],
        }
        const source = `
            module.exports = {
                name: 'acc', version: '1.0.0',
                register() {},
                onAccountEnd(ctx) { ctx.storage.set('runs', (ctx.storage.get('runs') || 0) + 1); }
            }`
        const sandbox = await createPluginSandbox({ source, storage, timeoutMs: 4000 })
        try {
            await sandbox.runLifecycle('onAccountEnd', { email: 'acct_x', result: { collectedPoints: 10 } })
            await sandbox.runLifecycle('onAccountEnd', { email: 'acct_x', result: { collectedPoints: 20 } })
            assert.equal(backing.get('runs'), 2)
        } finally {
            sandbox.dispose()
        }
    })
}
