'use strict'

// End-to-end check of the shipped example plugin (docs/examples/earnings-estimator)
// through the EXACT production wiring: the real V8 sandbox + the shared data store's
// file-backed storage + panel validator + settings resolution. This is what proves a
// third party can build a settings+storage+panel plugin with zero Node access.
// Skips cleanly if isolated-vm is unavailable.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../plugins/plugin-data-store')

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

const EXAMPLE = path.join(__dirname, '..', '..', 'docs', 'examples', 'earnings-estimator')

if (!available) {
    test(`example estimator plugin (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
    test('earnings-estimator runs sandboxed and produces the Desk panel', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-ex-'))
        const name = 'earnings-estimator'
        fs.mkdirSync(path.join(root, 'plugins', name), { recursive: true })
        fs.copyFileSync(path.join(EXAMPLE, 'plugin.json'), path.join(root, 'plugins', name, 'plugin.json'))
        const source = fs.readFileSync(path.join(EXAMPLE, 'index.js'), 'utf8')

        // User set pointsPerEuro=100 in the Desk (proves the settings path + resolution).
        store.writeSettingsValues(root, name, { pointsPerEuro: 100, days: 10 })
        const settings = store.resolveSettings(root, name, {})
        assert.equal(settings.pointsPerEuro, 100)

        const storage = store.createStorage(root, name)
        const sandbox = await createPluginSandbox({
            source,
            settings,
            storage,
            onPanel: (data) => store.writePanel(root, name, data),
            timeoutMs: 4000,
        })
        try {
            // Two account runs: 300 then 500 points -> total 800, runs 2.
            await sandbox.runLifecycle('onAccountEnd', { email: 'acct_a', result: { collectedPoints: 300 } })
            await sandbox.runLifecycle('onAccountEnd', { email: 'acct_b', result: { collectedPoints: 500 } })
        } finally {
            sandbox.dispose()
        }

        // Storage persisted through the real file-backed store.
        const persisted = store.createStorage(root, name)
        assert.equal(persisted.get('totalPoints'), 800)
        assert.equal(persisted.get('runs'), 2)

        // The panel the Desk would render: 800/100 = 8.00 € worth now.
        const panel = store.readPanel(root, name)
        assert.equal(panel.title, 'Earnings estimate')
        const worth = panel.stats.find((s) => s.label === 'Worth now')
        assert.equal(worth.value, '8.00 €')
        const projected = panel.stats.find((s) => /Over 10 days/.test(s.label))
        // avg 400 pts/run * 10 days / 100 = 40.00 €
        assert.equal(projected.value, '40.00 €')

        fs.rmSync(root, { recursive: true, force: true })
    })
}
