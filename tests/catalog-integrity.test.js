'use strict'

// Guards plugins/catalog.json integrity pins against drift.
//
// The loader (src/core/PluginManager.ts assertCatalogHash) fails CLOSED when a
// catalogued plugin's sha256 does not match its index file — so a stale pin
// silently breaks that plugin the moment it is enabled. The release checker
// historically validated only the 'core' entry, which let the run-summary and
// run-health pins drift unnoticed. This test re-hashes every single-file pin
// exactly as the loader does and fails if any catalog entry is out of date.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'catalog.json'), 'utf8'))

// 'core' uses per-target bytecode hashes (validated by the core release check),
// not a single top-level sha256, so it is intentionally excluded here.
const singleFilePins = catalog.plugins.filter(p => p.name !== 'core' && p.sha256)

test('catalog has single-file pins to validate', () => {
    assert.ok(singleFilePins.length > 0, 'expected at least one non-core pinned plugin')
})

for (const plugin of singleFilePins) {
    test(`catalog sha256 matches index.js for "${plugin.name}"`, () => {
        const indexPath = path.join(ROOT, 'plugins', plugin.name, 'index.js')
        assert.ok(fs.existsSync(indexPath), `bundled plugin file missing: plugins/${plugin.name}/index.js`)
        const actual = crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex')
        assert.equal(
            actual,
            plugin.sha256.toLowerCase(),
            `plugins/catalog.json sha256 for "${plugin.name}" is stale (loader would fail closed). Update it to ${actual}.`
        )
    })
}
