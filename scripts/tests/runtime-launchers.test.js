const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { mock } = require('node:test')

const { createRuntimeLaunchers } = require('../launchers/runtime-launchers')

// The launchers bake in an ABSOLUTE nodePath snapshot (process.execPath at write time).
// If that exact binary later moves — Node upgraded in place at a new path, a
// portable/nvm-managed install replaced — running the stale launcher used to fail with a
// bare OS "path not found" error before Node (or any of our own logging) ever ran. Every
// generated launcher must fall back to `node` on PATH when the baked path is gone.
const STALE_NODE_PATH = 'C:\\definitely\\not\\a\\real\\node.exe'

function fixture(platform) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-runtime-launchers-'))
    return { root, launchers: createRuntimeLaunchers({ root, platform, nodePath: STALE_NODE_PATH }) }
}

test('Windows Desk launcher falls back to PATH node when the baked path is gone', () => {
    const { launchers } = fixture('win32')
    const content = fs.readFileSync(launchers.ensureDeskLauncher(), 'utf8')
    assert.match(content, /if exist "C:\\definitely\\not\\a\\real\\node\.exe" \(set "MSRB_NODE=C:\\definitely\\not\\a\\real\\node\.exe"\) else \(set "MSRB_NODE=node"\)/)
    assert.match(content, /"%MSRB_NODE%" "%MSRB_ROOT%\\scripts\\start\.js"/)
})

test('Windows agent and notifier launchers also fall back to PATH node', () => {
    const { launchers } = fixture('win32')
    const agent = fs.readFileSync(launchers.ensureAgentLauncher(), 'utf8')
    assert.match(agent, /else \(set "MSRB_NODE=node"\)/)
    assert.match(agent, /"%MSRB_NODE%" "%MSRB_ROOT%\\scripts\\start\.js" --background/)

    const notifier = fs.readFileSync(launchers.ensureNotifierLauncher(), 'utf8')
    assert.match(notifier, /else \(set "MSRB_NODE=node"\)/)
    assert.match(notifier, /"%MSRB_NODE%" ".*notifier-daemon\.js"/)
})

test('macOS/Linux Desk launcher falls back to PATH node when the baked path is gone', () => {
    const { launchers } = fixture('linux')
    const content = fs.readFileSync(launchers.ensureDeskLauncher(), 'utf8')
    assert.match(content, /NODE_BIN='C:\\definitely\\not\\a\\real\\node\.exe'/)
    assert.match(content, /\[ -x "\$NODE_BIN" \] \|\| NODE_BIN=node/)
    assert.match(content, /"\$NODE_BIN" .*start\.js/)
})

test('macOS/Linux agent and notifier launchers also fall back to PATH node', () => {
    const { launchers } = fixture('linux')
    const agent = fs.readFileSync(launchers.ensureAgentLauncher(), 'utf8')
    assert.match(agent, /\[ -x "\$NODE_BIN" \] \|\| NODE_BIN=node/)
    assert.match(agent, /exec "\$NODE_BIN" .*start\.js.*--background/)

    const notifier = fs.readFileSync(launchers.ensureNotifierLauncher(), 'utf8')
    assert.match(notifier, /\[ -x "\$NODE_BIN" \] \|\| NODE_BIN=node/)
    assert.match(notifier, /exec "\$NODE_BIN" .*notifier-daemon\.js/)
})

test('re-ensuring an unchanged launcher never touches the file on disk (no rename)', () => {
    // start-desk.cmd runs its Node command synchronously, so the parent cmd.exe stays
    // open on the file for the whole run. If a self-heal call (or the "Install shortcuts"
    // button) regenerates that exact file while it's the currently-running launcher,
    // renaming a new version onto it can EPERM (Windows sharing violation) — even though
    // the directory itself is writable. Skipping the write when content is unchanged
    // (the common case on every ordinary launch) avoids ever attempting that rename.
    const { launchers } = fixture('win32')
    const filePath = launchers.ensureDeskLauncher()

    const renameMock = mock.method(fs, 'renameSync')
    try {
        launchers.ensureDeskLauncher() // same inputs → identical content
        assert.equal(renameMock.mock.callCount(), 0, 'unchanged content must not be rewritten')

        // A real change (different nodePath) must still go through and rewrite the file.
        const root = launchers.runtimeDir.replace(/[\\/]scripts[\\/]runtime$/, '')
        const changed = createRuntimeLaunchers({ root, platform: 'win32', nodePath: 'C:\\a\\different\\node.exe' })
        changed.ensureDeskLauncher()
        assert.equal(renameMock.mock.callCount(), 1, 'a genuine content change must still be written')
        assert.match(fs.readFileSync(filePath, 'utf8'), /C:\\a\\different\\node\.exe/)
    } finally {
        renameMock.mock.restore()
    }
})
