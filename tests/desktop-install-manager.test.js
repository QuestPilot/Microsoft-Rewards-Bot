const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createDesktopInstallManager } = require('../scripts/desktop-install-manager')

function fixture(platform) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-install-'))
    const home = path.join(root, 'home')
    const appData = path.join(home, 'AppData', 'Roaming')
    const calls = []
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'start.js'), '')
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'png')
    fs.writeFileSync(path.join(root, 'assets', 'logo.ico'), 'ico')
    const execFileSync = (command, args, options = {}) => {
        calls.push([command, args, options])
        if (options.env?.MSRB_SHORTCUT_PATH) {
            fs.mkdirSync(path.dirname(options.env.MSRB_SHORTCUT_PATH), { recursive: true })
            fs.writeFileSync(options.env.MSRB_SHORTCUT_PATH, 'shortcut')
        }
        return ''
    }
    return {
        root,
        home,
        calls,
        manager: createDesktopInstallManager({
            root,
            home,
            platform,
            execFileSync,
            env: { APPDATA: appData, ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
        })
    }
}

test('Windows installer creates icon shortcuts and a visible startup launcher', () => {
    const { root, calls, manager } = fixture('win32')
    const result = manager.install()

    assert.equal(result.desktop, true)
    assert.equal(result.menu, true)
    assert.equal(result.complete, true)
    assert.equal(calls.filter(([command]) => command === 'powershell.exe').length, 2)
    const launcher = fs.readFileSync(path.join(root, '.core', 'start-desk.cmd'), 'utf8')
    assert.match(launcher, /Rewards Desk is preparing/)
    assert.match(launcher, /scripts\\start\.js/)
    assert.match(launcher, /\.msrb-write-test-/)
    assert.match(launcher, /-Verb RunAs/)
    assert.match(launcher, /--msrb-elevated/)
    assert.match(launcher, /MSRB_ELEVATED_RELAUNCH/)
    const removed = manager.uninstall()
    assert.equal(removed.desktop, false)
    assert.equal(removed.menu, false)
})

test('Linux installer creates application-menu and desktop entries with the project icon', () => {
    const { home, manager } = fixture('linux')
    const result = manager.install()
    const menu = fs.readFileSync(path.join(home, '.local', 'share', 'applications', 'rewards-desk.desktop'), 'utf8')

    assert.equal(result.desktop, true)
    assert.equal(result.menu, true)
    assert.equal(result.complete, true)
    assert.match(menu, /Terminal=true/)
    assert.match(menu, /assets[\\/]logo\.png/)
    const removed = manager.uninstall()
    assert.equal(removed.desktop, false)
    assert.equal(removed.menu, false)
})

test('macOS installer creates an application bundle for Finder and Dock pinning', () => {
    const { home, manager } = fixture('darwin')
    const result = manager.install()

    assert.equal(result.menu, true)
    assert.equal(result.complete, true)
    assert.equal(fs.existsSync(path.join(home, 'Applications', 'Rewards Desk.app', 'Contents', 'Info.plist')), true)
    assert.equal(fs.existsSync(path.join(home, 'Applications', 'Rewards Desk.app', 'Contents', 'Resources', 'AppIcon.png')), true)
    const removed = manager.uninstall()
    assert.equal(removed.menu, false)
})

test('installer status becomes incomplete when a shortcut is removed manually', () => {
    const { home, manager } = fixture('win32')
    manager.install()
    fs.rmSync(path.join(home, 'Desktop', 'Rewards Desk.lnk'))

    const result = manager.status()
    assert.equal(result.desktop, false)
    assert.equal(result.menu, true)
    assert.equal(result.complete, false)
})
