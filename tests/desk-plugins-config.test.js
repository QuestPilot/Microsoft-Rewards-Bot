'use strict'

// Unit tests for the extracted Desk plugins-config helper (scripts/desk/plugins-config.js):
// JSONC parsing, enabled/list derivation, and the comment-preserving toggle surgery
// (the part the audit flagged as fragile). Uses a temp plugins.jsonc fixture.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginsConfig } = require('../scripts/desk/plugins-config')

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
