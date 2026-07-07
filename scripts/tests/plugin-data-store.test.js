'use strict'

// Unit tests for the shared plugin capability backend (scripts/plugins/plugin-data-store.js):
// manifest reading, settings resolution + coercion, scoped storage (+ size cap), and
// the panel validator (fixed vocabulary, never HTML).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../plugins/plugin-data-store')

let root
before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-store-'))
    fs.mkdirSync(path.join(root, 'plugins', 'estimator'), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'plugins', 'estimator', 'plugin.json'),
        JSON.stringify({
            name: 'estimator',
            version: '1.0.0',
            permissions: ['settings', 'storage', 'ui.panel', 'points.read'],
            settings: [
                { key: 'pointsPerEuro', type: 'number', label: 'Points per €', default: 1500, min: 1 },
                { key: 'days', type: 'number', label: 'Days', default: 30, min: 1, max: 3650 },
                { key: 'label', type: 'text', label: 'Label', default: 'hi' },
            ],
        }),
    )
})
after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('readManifest returns declared permissions + a validated settings schema', () => {
    const m = store.readManifest(root, 'estimator')
    assert.equal(m.name, 'estimator')
    assert.deepEqual(m.permissions, ['settings', 'storage', 'ui.panel', 'points.read'])
    assert.equal(m.settings.length, 3)
    assert.equal(store.readManifest(root, 'nope').settings.length, 0)
})

test('resolveSettings layers defaults < config < user overrides, coercing types', () => {
    // defaults only
    let s = store.resolveSettings(root, 'estimator', {})
    assert.equal(s.pointsPerEuro, 1500)
    assert.equal(s.days, 30)
    // plugins.jsonc config overrides a default (and is coerced + clamped to min)
    s = store.resolveSettings(root, 'estimator', { pointsPerEuro: '2000', days: -5 })
    assert.equal(s.pointsPerEuro, 2000)
    assert.equal(s.days, 1, 'clamped to min')
    // Desk-written user values win over config
    store.writeSettingsValues(root, 'estimator', { days: 90, label: 'custom' })
    s = store.resolveSettings(root, 'estimator', { days: 10 })
    assert.equal(s.days, 90, 'user value overrides config')
    assert.equal(s.label, 'custom')
})

test('writeSettingsValues ignores keys not in the schema', () => {
    const clean = store.writeSettingsValues(root, 'estimator', { days: 7, bogus: 'x' })
    assert.equal(clean.days, 7)
    assert.equal(clean.bogus, undefined)
})

test('createStorage persists scoped key/values across instances', () => {
    const s1 = store.createStorage(root, 'estimator')
    s1.set('total', 4200)
    s1.set('obj', { a: 1 })
    assert.equal(s1.get('total'), 4200)
    assert.deepEqual(s1.get('obj'), { a: 1 })
    assert.deepEqual(s1.keys().sort(), ['obj', 'total'])
    // A fresh instance reads what the first persisted.
    const s2 = store.createStorage(root, 'estimator')
    assert.equal(s2.get('total'), 4200)
    s2.delete('total')
    assert.equal(s2.get('total'), undefined)
    assert.equal(store.createStorage(root, 'estimator').get('total'), undefined)
})

test('storage enforces the size cap', () => {
    const s = store.createStorage(root, 'estimator')
    assert.throws(() => s.set('big', 'x'.repeat(store.MAX_STORAGE_BYTES + 10)), /storage exceeds/)
})

test('net grants: granted hosts are the declared ∩ consented set', () => {
    const name = 'net-plugin'
    fs.mkdirSync(path.join(root, 'plugins', name), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'plugins', name, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0', permissions: ['storage', 'net:api.example.com', 'net:cdn.example.com'] }),
    )
    assert.deepEqual(store.netHostsFromManifest(store.readManifest(root, name)).sort(), ['api.example.com', 'cdn.example.com'])
    // Nothing consented yet -> no reachable hosts.
    assert.deepEqual(store.grantedNetHosts(root, name), [])
    // Consent to one host only.
    store.writeGrant(root, name, 'net:api.example.com', true)
    assert.deepEqual(store.grantedNetHosts(root, name), ['api.example.com'])
    // A grant for a host NOT declared in the manifest is ignored by the intersection.
    store.writeGrant(root, name, 'net:not-declared.com', true)
    assert.deepEqual(store.grantedNetHosts(root, name), ['api.example.com'])
    // Revoke.
    store.writeGrant(root, name, 'net:api.example.com', false)
    assert.deepEqual(store.grantedNetHosts(root, name), [])
})

test('writePanel keeps a fixed vocabulary and caps/strips everything', () => {
    const panel = store.writePanel(root, 'estimator', {
        title: 'Earnings',
        stats: [{ label: 'Total', value: '4200 pts', hint: 'so far' }, { junk: true }],
        lines: ['≈ 2.80 €', 12345],
        evil: '<script>alert(1)</script>', // dropped — not in the vocabulary
    })
    assert.equal(panel.title, 'Earnings')
    assert.equal(panel.stats.length, 2)
    assert.equal(panel.stats[0].value, '4200 pts')
    assert.equal(panel.stats[1].label, '', 'malformed stat stringified to empty label')
    assert.equal(panel.lines[1], '12345', 'non-string line coerced')
    assert.equal(panel.evil, undefined, 'unknown fields never persist')
    assert.ok(panel.updatedAt, 'stamped with a time')
    const read = store.readPanel(root, 'estimator')
    assert.equal(read.title, 'Earnings')
})
