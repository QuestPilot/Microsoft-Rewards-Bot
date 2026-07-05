const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createStartupManager } = require('../launchers/startup-manager')

function fixture(platform) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-startup-'))
    const home = path.join(root, 'home')
    const calls = []
    const tasks = new Set()
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'start.js'), '')
    const execFileSync = (command, args) => {
        calls.push([command, args])
        if (command === 'schtasks.exe' && args[0] === '/Query') {
            if (!tasks.has(args.at(-1))) throw new Error('not found')
            return ''
        }
        if (command === 'schtasks.exe' && args[0] === '/Create') {
            tasks.add(args[args.indexOf('/TN') + 1])
            return ''
        }
        if (command === 'schtasks.exe' && args[0] === '/Delete') {
            tasks.delete(args[args.indexOf('/TN') + 1])
            return ''
        }
        if (command === 'systemctl' && args.includes('is-enabled')) {
            return calls.some(([, callArgs]) => callArgs.includes('enable')) ? 'enabled' : 'disabled'
        }
        return ''
    }
    return {
        root,
        home,
        calls,
        manager: createStartupManager({ root, home, platform, execFileSync, env: {} })
    }
}

test('Windows uses per-user Startup entries without administrator rights', () => {
    const { root, calls, manager } = fixture('win32')
    manager.setDeskEnabled(true)
    manager.setAgentEnabled(true)
    const status = manager.status()

    assert.equal(status.desk.installed, true)
    assert.equal(status.agent.installed, true)
    assert.equal(status.desk.method, 'startup-folder')
    assert.equal(status.agent.method, 'startup-folder')
    assert.equal(calls.some(([command, args]) => command === 'schtasks.exe' && args[0] === '/Create'), false)
    assert.match(fs.readFileSync(path.join(root, 'scripts', 'runtime', 'start-desk.cmd'), 'utf8'), /scripts\\start\.js"/)
    assert.match(fs.readFileSync(path.join(root, 'scripts', 'runtime', 'start-background.cmd'), 'utf8'), /--background/)
})

test('Windows requests elevation only to remove an inaccessible legacy task', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-startup-elevated-'))
    const home = path.join(root, 'home')
    const calls = []
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'start.js'), '')
    const manager = createStartupManager({
        root,
        home,
        platform: 'win32',
        env: { APPDATA: path.join(home, 'AppData', 'Roaming') },
        execFileSync(command, args) {
            calls.push([command, args])
            if (command === 'schtasks.exe' && args[0] === '/Query') return ''
            if (command === 'schtasks.exe' && args[0] === '/Delete') {
                const error = new Error('Access is denied')
                error.stderr = 'Access is denied'
                throw error
            }
            if (command === 'powershell.exe') return ''
            return ''
        }
    })

    manager.setDeskEnabled(true)
    assert.ok(calls.some(([command, args]) => command === 'powershell.exe' && args.includes('-Command')))
    assert.equal(calls.some(([command, args]) => command === 'schtasks.exe' && args[0] === '/Create'), false)
})

test('macOS uses LaunchAgents for both startup modes', () => {
    const { home, manager } = fixture('darwin')
    manager.setDeskEnabled(true)
    manager.setAgentEnabled(true)

    assert.equal(manager.status().desk.installed, true)
    assert.equal(manager.status().agent.installed, true)
    assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.msrb.rewards-desk.plist')), true)
    assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.msrb.core-agent.plist')), true)
})

test('Linux uses desktop autostart for Desk and systemd user service for Core agent', () => {
    const { home, manager } = fixture('linux')
    manager.setDeskEnabled(true)
    manager.setAgentEnabled(true)

    assert.equal(fs.existsSync(path.join(home, '.config', 'autostart', 'rewards-desk.desktop')), true)
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'msrb-core-agent.service')), true)
})

test('Windows update notifier installs a minimized Startup entry pointing at the daemon script', () => {
    const { root, home, manager } = fixture('win32')
    manager.setNotifierEnabled(true)
    const status = manager.status()

    assert.equal(status.notifier.installed, true)
    assert.equal(status.notifier.method, 'startup-folder')
    const runtimeScript = fs.readFileSync(path.join(root, 'scripts', 'runtime', 'start-notifier.cmd'), 'utf8')
    assert.match(runtimeScript, /notifier-daemon\.js/)
    const startupEntry = fs.readFileSync(
        path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Rewards Update Notifier.cmd'),
        'utf8'
    )
    assert.match(startupEntry, /start "" \/min/)

    manager.setNotifierEnabled(false)
    assert.equal(manager.status().notifier.installed, false)
})

test('macOS update notifier uses a LaunchAgent, distinct from Desk and the Core agent', () => {
    const { home, manager } = fixture('darwin')
    manager.setNotifierEnabled(true)

    assert.equal(manager.status().notifier.installed, true)
    assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.msrb.update-notifier.plist')), true)
})

test('Linux update notifier uses desktop autostart, never systemd (must never run headless)', () => {
    const { home, manager } = fixture('linux')
    manager.setNotifierEnabled(true)

    assert.equal(manager.status().notifier.installed, true)
    assert.equal(fs.existsSync(path.join(home, '.config', 'autostart', 'rewards-update-notifier.desktop')), true)
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'msrb-update-notifier.service')), false)

    manager.setNotifierEnabled(false)
    assert.equal(fs.existsSync(path.join(home, '.config', 'autostart', 'rewards-update-notifier.desktop')), false)
})
