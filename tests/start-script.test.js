const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const startScript = require('../scripts/start')

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-start-'))
}

test('background launch skips updater unless explicitly enabled', () => {
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js'], {}), true)
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js', '--background'], {}), false)
    assert.equal(
        startScript.shouldRunUpdater(['node', 'scripts/start.js', '--background'], { MSRB_BACKGROUND_UPDATE: '1' }),
        true
    )
})

test('background launch reuses dist when available and builds only when missing', () => {
    const root = tempRoot()
    try {
        assert.equal(startScript.hasBuiltRuntime(root), false)
        assert.equal(startScript.shouldBuildRuntime(['node', 'scripts/start.js', '--background'], root), true)

        fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(root, 'dist', 'index.js'), '')
        fs.writeFileSync(path.join(root, 'dist', 'package.json'), '{}')

        assert.equal(startScript.hasBuiltRuntime(root), true)
        assert.equal(startScript.shouldBuildRuntime(['node', 'scripts/start.js', '--background'], root), false)
        assert.equal(startScript.shouldBuildRuntime(['node', 'scripts/start.js'], root), true)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('start script resolves npm from portable Node runtime before global npm', () => {
    const root = tempRoot()
    try {
        const nodePath = path.join(root, 'runtime', 'node.exe')
        const npmPath = path.join(root, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js')
        fs.mkdirSync(path.dirname(npmPath), { recursive: true })
        fs.writeFileSync(nodePath, '')
        fs.writeFileSync(npmPath, '')

        const npm = startScript.resolveNpmInvocation({}, nodePath)

        assert.equal(npm.command, nodePath)
        assert.deepEqual(npm.argsPrefix, [npmPath])
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
