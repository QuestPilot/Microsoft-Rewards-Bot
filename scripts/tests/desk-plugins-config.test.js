'use strict'

// Unit tests for the extracted Desk plugins-config helper (scripts/desk/plugins-config.js):
// JSONC parsing, enabled/list derivation, and the comment-preserving toggle surgery
// (the part the audit flagged as fragile). Uses a temp plugins.jsonc fixture.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginsConfig } = require('../desk/plugins-config')

const JSONC = `{
  // the official core plugin
  "core": { "enabled": true, "priority": 10 },
  "run-summary": {
    "enabled": false, // off by default
    "priority": 5,
  },
  "my-plugin": { "enabled": true }
}`

let root
let pc

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-pcfg-'))
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plugins', 'plugins.jsonc'), JSONC)
    pc = createPluginsConfig({ root, atomicWriteText: (p, c) => fs.writeFileSync(p, c) })
})
after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('parses JSONC (comments + trailing commas) into a config object', () => {
    const cfg = pc.readPluginsConfig()
    assert.equal(cfg.core.priority, 10)
    assert.equal(cfg['run-summary'].enabled, false)
    assert.equal(cfg['my-plugin'].enabled, true)
})

test('isPluginEnabled treats missing enabled as enabled, false as disabled', () => {
    assert.equal(pc.isPluginEnabled('core'), true)
    assert.equal(pc.isPluginEnabled('run-summary'), false)
    assert.equal(pc.isPluginEnabled('absent'), false)
})

test('readPluginsList sorts by priority and annotates official/description', () => {
    const list = pc.readPluginsList()
    assert.deepEqual(list.map(p => p.name), ['core', 'run-summary', 'my-plugin'])
    assert.equal(list.find(p => p.name === 'core').official, true)
    assert.equal(list.find(p => p.name === 'my-plugin').official, false)
    assert.equal(list.find(p => p.name === 'my-plugin').description, 'Custom plugin.')
})

test('setPluginEnabled flips the flag AND preserves comments', () => {
    assert.equal(pc.setPluginEnabled('run-summary', true), true)
    const raw = fs.readFileSync(path.join(root, 'plugins', 'plugins.jsonc'), 'utf8')
    assert.ok(raw.includes('// off by default'), 'comment must survive the toggle')
    assert.ok(raw.includes('// the official core plugin'), 'other comments must survive too')
    assert.equal(pc.readPluginsConfig()['run-summary'].enabled, true, 'flag must now be enabled')
    // other entries untouched
    assert.equal(pc.readPluginsConfig().core.enabled, true)
})

test('setPluginEnabled throws for an unknown plugin', () => {
    assert.throws(() => pc.setPluginEnabled('ghost', true), /Plugin not found/)
})

test('setPluginTrust inserts a trust field when absent (preserving comments)', () => {
    assert.equal(pc.setPluginTrust('my-plugin', 'full'), true)
    const raw = fs.readFileSync(path.join(root, 'plugins', 'plugins.jsonc'), 'utf8')
    assert.ok(raw.includes('// the official core plugin'), 'comments must survive')
    assert.equal(pc.readPluginsConfig()['my-plugin'].trust, 'full')
    assert.equal(pc.readPluginsConfig()['my-plugin'].enabled, true, 'other fields untouched')
})

test('setPluginTrust replaces an existing trust value', () => {
    pc.setPluginTrust('my-plugin', 'full')
    assert.equal(pc.setPluginTrust('my-plugin', 'sandbox'), true)
    assert.equal(pc.readPluginsConfig()['my-plugin'].trust, 'sandbox')
})

test('setPluginTrust rejects an invalid level', () => {
    assert.throws(() => pc.setPluginTrust('my-plugin', 'root'), /Invalid trust level/)
})

test('addMarketplacePlugin appends a new marketplace entry to plugins.jsonc', () => {
    assert.equal(pc.addMarketplacePlugin('cool-plugin', '1.0.0'), true)
    const cfg = pc.readPluginsConfig()
    assert.ok(cfg['cool-plugin'], 'entry must exist')
    assert.equal(cfg['cool-plugin'].enabled, true)
    assert.equal(cfg['cool-plugin'].source, 'marketplace')
    assert.equal(cfg['cool-plugin'].version, '1.0.0')
    // existing entries untouched
    assert.equal(cfg.core.priority, 10)
})

test('addMarketplacePlugin throws when the plugin is already in plugins.jsonc', () => {
    assert.throws(() => pc.addMarketplacePlugin('cool-plugin', '1.0.1'), /Already in plugins\.jsonc/)
})

test('addMarketplacePlugin rejects invalid name or version', () => {
    assert.throws(() => pc.addMarketplacePlugin('BAD NAME!', '1.0.0'), /Invalid plugin name/)
    assert.throws(() => pc.addMarketplacePlugin('valid-name', 'not-a-version'), /Invalid version/)
})

test('setPluginVersion replaces the pinned version (preserving comments)', () => {
    assert.equal(pc.setPluginVersion('cool-plugin', '2.0.0'), true)
    assert.equal(pc.readPluginsConfig()['cool-plugin'].version, '2.0.0')
    const raw = fs.readFileSync(path.join(root, 'plugins', 'plugins.jsonc'), 'utf8')
    assert.ok(raw.includes('// the official core plugin'), 'comments must survive')
    assert.throws(() => pc.setPluginVersion('cool-plugin', 'nope'), /Invalid version/)
})

test('setPluginAutoUpdate inserts then flips the autoUpdate flag', () => {
    assert.equal(pc.readPluginsList().find(p => p.name === 'cool-plugin').autoUpdate, true, 'defaults to on')
    assert.equal(pc.setPluginAutoUpdate('cool-plugin', false), true)
    assert.equal(pc.readPluginsConfig()['cool-plugin'].autoUpdate, false)
    assert.equal(pc.setPluginAutoUpdate('cool-plugin', true), true)
    assert.equal(pc.readPluginsConfig()['cool-plugin'].autoUpdate, true)
})

test('removePlugin deletes the entry and leaves the rest valid', () => {
    assert.ok(pc.readPluginsConfig()['cool-plugin'], 'present before removal')
    assert.equal(pc.removePlugin('cool-plugin'), true)
    const cfg = pc.readPluginsConfig()
    assert.equal(cfg['cool-plugin'], undefined, 'entry is gone')
    // surrounding entries intact and file still parses
    assert.equal(cfg.core.priority, 10)
    assert.equal(cfg['my-plugin'].enabled, true)
    // Tolerant contract: an unknown name is a no-op returning false (NOT a throw), so a
    // folder-only "unmanaged" plugin with no config entry can still be removed on disk.
    assert.equal(pc.removePlugin('ghost'), false)
})

test('listInstalledFolders finds on-disk plugins independent of plugins.jsonc', () => {
    const dir = path.join(root, 'plugins')
    // A folder plugin with index.js, a bare file plugin, a .jsc folder, and noise.
    fs.mkdirSync(path.join(dir, 'disk-plugin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'disk-plugin', 'index.js'), 'module.exports={}')
    fs.writeFileSync(path.join(dir, 'file-plugin.js'), 'module.exports={}')
    fs.mkdirSync(path.join(dir, 'compiled'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'compiled', 'index.jsc'), 'x')
    fs.mkdirSync(path.join(dir, 'empty-dir'), { recursive: true }) // no entry point -> ignored
    fs.writeFileSync(path.join(dir, 'marketplace.json'), '{}') // ignored non-plugin file
    const found = pc.listInstalledFolders()
    assert.ok(found.includes('disk-plugin'), 'folder plugin detected')
    assert.ok(found.includes('file-plugin'), 'bare .js plugin detected (extension stripped)')
    assert.ok(found.includes('compiled'), '.jsc folder plugin detected')
    assert.ok(!found.includes('empty-dir'), 'a dir with no entry point is not a plugin')
    assert.ok(!found.includes('marketplace'), 'ignored files are not plugins')
    assert.ok(!found.includes('plugins'), 'the jsonc file is not a plugin')
})
