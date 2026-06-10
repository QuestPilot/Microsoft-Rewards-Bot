const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const startScript = require('../scripts/start')
const packageJson = require('../package.json')

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-start-'))
}

test('build no longer runs the legacy session migration', () => {
    assert.equal(packageJson.scripts.prebuild, undefined)
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'migrate-legacy-sessions.js')), false)
})

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

test('terminal mode config controls the app window launcher', () => {
    const root = tempRoot()
    try {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true })
        fs.writeFileSync(path.join(root, 'src', 'config.json'), JSON.stringify({ terminal: { enabled: false } }))

        assert.equal(startScript.terminalModeEnabled(startScript.readConfig(root)), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { MSRB_FORCE_APP_WINDOW: '1' }, root), true)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--terminal'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--background'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--attach'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--ui-child'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { MSRB_TERMINAL_MODE: '1' }, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { CI: 'true' }, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { FORCE_HEADLESS: '1' }, root), false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('app window launcher can be explicitly disabled or forced by environment', () => {
    assert.equal(startScript.hasGuiEnvironment({ MSRB_FORCE_APP_WINDOW: '1', CI: 'true' }), true)
    assert.equal(startScript.hasGuiEnvironment({ MSRB_NO_APP_WINDOW: '1' }), false)
    assert.equal(startScript.hasGuiEnvironment({ CI: '1' }), false)
    assert.equal(startScript.hasGuiEnvironment({ FORCE_HEADLESS: '1' }), false)
})

test('app window mode is the default when terminal mode is not explicitly enabled', () => {
    assert.equal(startScript.terminalModeEnabled(null), false)
    assert.equal(startScript.terminalModeEnabled({}), false)
    assert.equal(startScript.terminalModeEnabled({ terminal: { enabled: true } }), true)
})
