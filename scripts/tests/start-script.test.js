const assert = require('assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const startScript = require('../start')
const packageJson = require('../../package.json')
const startSource = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8')

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-start-'))
}

test('build no longer runs the legacy session migration', () => {
    assert.equal(packageJson.scripts.prebuild, undefined)
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'migrate-legacy-sessions.js')), false)
})

test('launcher ensures Patchright Chromium before opening the interface', () => {
    assert.match(startSource, /ensurePatchrightChromium\(\{ root: ROOT \}\)/)
    assert.ok(
        startSource.indexOf('ensurePatchrightChromium({ root: ROOT })') <
            startSource.indexOf('if (shouldLaunchInterface())')
    )
})

test('first start creates missing config and account files from examples', () => {
    const root = tempRoot()
    try {
        const src = path.join(root, 'src')
        fs.mkdirSync(src, { recursive: true })
        fs.writeFileSync(path.join(src, 'config.example.json'), '{"example":"config"}\n')
        fs.writeFileSync(path.join(src, 'accounts.example.json'), '[{"example":"account"}]\n')

        const created = startScript.bootstrapUserFiles(root, { log() {} })

        assert.deepEqual(created, { config: true, accounts: true })
        assert.equal(fs.readFileSync(path.join(src, 'config.json'), 'utf8'), '{"example":"config"}\n')
        assert.equal(fs.readFileSync(path.join(src, 'accounts.json'), 'utf8'), '[{"example":"account"}]\n')
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('first start never overwrites existing config or account storage', () => {
    const root = tempRoot()
    try {
        const src = path.join(root, 'src')
        fs.mkdirSync(src, { recursive: true })
        fs.writeFileSync(path.join(src, 'config.example.json'), '{"example":true}')
        fs.writeFileSync(path.join(src, 'accounts.example.json'), '[{"example":true}]')
        fs.writeFileSync(path.join(src, 'config.json'), '{"user":true}')
        fs.writeFileSync(path.join(src, 'accounts.enc.json'), '{"encrypted":true}')

        const created = startScript.bootstrapUserFiles(root, { log() {} })

        assert.deepEqual(created, { config: false, accounts: false })
        assert.equal(fs.readFileSync(path.join(src, 'config.json'), 'utf8'), '{"user":true}')
        assert.equal(fs.readFileSync(path.join(src, 'accounts.enc.json'), 'utf8'), '{"encrypted":true}')
        assert.equal(fs.existsSync(path.join(src, 'accounts.json')), false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('first start creates only the missing user file', () => {
    const root = tempRoot()
    try {
        const src = path.join(root, 'src')
        fs.mkdirSync(src, { recursive: true })
        fs.writeFileSync(path.join(src, 'config.example.json'), '{"example":true}')
        fs.writeFileSync(path.join(src, 'accounts.example.json'), '[{"example":true}]')
        fs.writeFileSync(path.join(src, 'accounts.json'), '[{"user":true}]')

        const created = startScript.bootstrapUserFiles(root, { log() {} })

        assert.deepEqual(created, { config: true, accounts: false })
        assert.equal(fs.readFileSync(path.join(src, 'accounts.json'), 'utf8'), '[{"user":true}]')
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('background launch skips updater unless explicitly enabled', () => {
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js'], {}), true)
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js', '--background'], {}), false)
    assert.equal(
        startScript.shouldRunUpdater(['node', 'scripts/start.js', '--background'], { MSRB_BACKGROUND_UPDATE: '1' }),
        true
    )
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js'], { MSRB_POST_UPDATE_RESTART: '1' }), false)
    assert.equal(startScript.shouldRunUpdater(['node', 'scripts/start.js', 'harvester'], {}), false)
})

test('harvester is a direct terminal-only launch mode', () => {
    const argv = ['node', 'scripts/start.js', 'harvester']
    assert.equal(startScript.isHarvesterLaunch(argv), true)
    assert.equal(startScript.isHarvesterLaunch(['node', 'scripts/start.js']), false)
    assert.equal(startScript.isTerminalForced(argv, {}), true)
    assert.equal(startScript.shouldLaunchInterface(argv, { MSRB_FORCE_APP_WINDOW: '1' }), false)
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
        assert.equal(
            startScript.shouldBuildRuntime(['node', 'scripts/start.js', '--background'], root, {
                MSRB_POST_UPDATE_RESTART: '1'
            }),
            true
        )
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('successful auto-update restarts once with the post-update guard', () => {
    let captured = null
    const child = new EventEmitter()
    child.unrefCalled = false
    child.unref = () => {
        child.unrefCalled = true
    }

    const spawn = (command, args, options) => {
        captured = { command, args, options }
        return child
    }

    const result = startScript.launchPostUpdateRestart(
        ['node', 'scripts/start.js', '--terminal'],
        { EXISTING: '1' },
        spawn
    )

    assert.equal(result, child)
    assert.equal(captured.command, process.execPath)
    assert.deepEqual(captured.args, ['scripts/start.js', '--terminal'])
    assert.equal(captured.options.detached, true)
    assert.equal(captured.options.env.EXISTING, '1')
    assert.equal(captured.options.env.MSRB_POST_UPDATE_RESTART, '1')
    assert.equal(child.unrefCalled, true)
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
        assert.equal(
            startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { MSRB_FORCE_APP_WINDOW: '1' }, root),
            true
        )
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--terminal'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--background'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--attach'], {}, root), false)
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js', '--ui-child'], {}, root), false)
        assert.equal(
            startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { MSRB_TERMINAL_MODE: '1' }, root),
            false
        )
        assert.equal(startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { CI: 'true' }, root), false)
        assert.equal(
            startScript.shouldLaunchInterface(['node', 'scripts/start.js'], { FORCE_HEADLESS: '1' }, root),
            false
        )
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

test('on Linux, a bare DISPLAY from xvfb-run is not mistaken for a real desktop', () => {
    // xvfb-run (a common workaround for headless Chromium launch issues on a
    // server) exports DISPLAY for a virtual, windowless X server — indistinguishable
    // from a real desktop by DISPLAY alone. Without a real desktop session variable
    // alongside it, this must stay headless so scheduler.enabled runs via the CLI
    // bot process instead of being silently routed into the click-to-run Desk GUI.
    assert.equal(startScript.hasGuiEnvironment({ DISPLAY: ':99' }, 'linux'), false)
    assert.equal(
        startScript.hasGuiEnvironment({ DISPLAY: ':99', XDG_CURRENT_DESKTOP: 'GNOME' }, 'linux'),
        true
    )
    assert.equal(startScript.hasGuiEnvironment({ DISPLAY: ':0', DESKTOP_SESSION: 'gnome' }, 'linux'), true)
    assert.equal(startScript.hasGuiEnvironment({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true)
    assert.equal(startScript.hasGuiEnvironment({}, 'linux'), false)
    // An explicit override still wins regardless of the desktop-session heuristic.
    assert.equal(
        startScript.hasGuiEnvironment({ DISPLAY: ':99', MSRB_FORCE_APP_WINDOW: '1' }, 'linux'),
        true
    )
})

test('app window mode is the default when terminal mode is not explicitly enabled', () => {
    assert.equal(startScript.terminalModeEnabled(null), false)
    assert.equal(startScript.terminalModeEnabled({}), false)
    assert.equal(startScript.terminalModeEnabled({ terminal: { enabled: true } }), true)
})
