const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createStartupManager } = require('../scripts/startup-manager')

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
