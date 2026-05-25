const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('runtime package mirror includes package.json for compiled helpers', () => {
    const packagePath = path.join(root, 'node_modules', 'microsoft-rewards-bot', 'package.json')
    assert.ok(fs.existsSync(packagePath), 'node_modules/microsoft-rewards-bot/package.json is missing')

    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    assert.equal(packageJson.name, 'microsoft-rewards-bot')
    assert.equal(packageJson.engines.node, '24.15.0')
})

test('official Core loader resolves the current bytecode target', () => {
    const coreLoader = path.join(root, 'plugins', 'core', 'index.js')
    assert.ok(fs.existsSync(coreLoader), 'plugins/core/index.js is missing')

    const loaded = require(coreLoader)
    assert.ok(loaded)
})
