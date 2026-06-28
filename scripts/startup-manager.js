const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRuntimeLaunchers } = require('./runtime-launchers')

const DESK_TASK = 'Microsoft Rewards Bot Rewards Desk'
const AGENT_TASK = 'Microsoft Rewards Bot Core Agent'
const AGENT_SERVICE = 'msrb-core-agent.service'
const DESK_LAUNCH_AGENT = 'com.msrb.rewards-desk'
const CORE_LAUNCH_AGENT = 'com.msrb.core-agent'

function createStartupManager(options = {}) {
    const root = path.resolve(options.root || process.cwd())
    const platform = options.platform || process.platform
    const home = options.home || os.homedir()
    const env = options.env || process.env
    const execFileSync = options.execFileSync || childProcess.execFileSync
    const launchers = createRuntimeLaunchers({ root, platform })

    function run(command, args, extraEnv = {}) {
        try {
            const stdout = execFileSync(command, args, {
                cwd: root,
                encoding: 'utf8',
                env: { ...env, ...extraEnv },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            })
            return { ok: true, stdout: String(stdout || '').trim(), stderr: '' }
        } catch (error) {
            return {
                ok: false,
                stdout: String(error.stdout || '').trim(),
                stderr: String(error.stderr || error.message || '').trim()
            }
        }
    }

    function atomicWrite(filePath, content, mode = 0o600) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${Date.now()}.tmp`)
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode })
        fs.renameSync(tempPath, filePath)
        if (platform !== 'win32') fs.chmodSync(filePath, mode)
    }

    function launcher(mode) {
        return mode === 'desk' ? launchers.ensureDeskLauncher() : launchers.ensureAgentLauncher()
    }

    function windowsTaskState(name) {
        return run('schtasks.exe', ['/Query', '/TN', name]).ok
    }

    function windowsStartupPath(mode) {
        const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
        const name = mode === 'desk' ? 'Rewards Desk.cmd' : 'Rewards Core Agent.cmd'
        return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', name)
    }

    function installWindowsStartup(mode) {
        const launcherPath = launcher(mode)
        const content =
            mode === 'desk'
                ? `@echo off\r\ncall "${launcherPath}"\r\n`
                : `@echo off\r\nstart "" /min cmd.exe /c ""${launcherPath}""\r\n`
        atomicWrite(windowsStartupPath(mode), content)
    }

    function removeWindowsTask(name, strict = true) {
        if (!windowsTaskState(name)) return
        const result = run('schtasks.exe', ['/Delete', '/TN', name, '/F'])
        if (result.ok) return
        const elevated = run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$p=Start-Process -FilePath "schtasks.exe" -ArgumentList @("/Delete","/TN",$env:MSRB_TASK_NAME,"/F") -Verb RunAs -Wait -PassThru;exit $p.ExitCode'
        ], { MSRB_TASK_NAME: name })
        if (!elevated.ok && strict) {
            throw new Error(elevated.stderr || elevated.stdout || `Could not remove legacy task ${name}`)
        }
    }

    function removeLegacyDeskRegistryEntry() {
        run('reg.exe', ['DELETE', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RewardsDesk', '/f'])
    }

    function legacyDeskRegistryInstalled() {
        return run('reg.exe', ['QUERY', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RewardsDesk']).ok
    }

    function launchAgentPath(label) {
        return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
    }

    function installLaunchAgent(label, mode) {
        const executable = launcher(mode)
        const logDir = path.join(root, 'data', 'logs')
        fs.mkdirSync(logDir, { recursive: true })
        atomicWrite(
            launchAgentPath(label),
            `<?xml version="1.0" encoding="UTF-8"?>\n` +
                `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
                `<plist version="1.0"><dict>\n` +
                `<key>Label</key><string>${label}</string>\n` +
                `<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xmlEscape(executable)}</string></array>\n` +
                `<key>RunAtLoad</key><true/>\n` +
                `<key>KeepAlive</key><${mode === 'agent' ? 'true' : 'false'}/>\n` +
                `<key>StandardOutPath</key><string>${xmlEscape(path.join(logDir, `${mode}.log`))}</string>\n` +
                `<key>StandardErrorPath</key><string>${xmlEscape(path.join(logDir, `${mode}.log`))}</string>\n` +
                `</dict></plist>\n`
        )
        run('launchctl', ['bootout', `gui/${process.getuid?.() || 0}`, launchAgentPath(label)])
        const result = run('launchctl', ['bootstrap', `gui/${process.getuid?.() || 0}`, launchAgentPath(label)])
        if (!result.ok) throw new Error(result.stderr || result.stdout || `Could not install ${label}`)
    }

    function removeLaunchAgent(label) {
        const filePath = launchAgentPath(label)
        run('launchctl', ['bootout', `gui/${process.getuid?.() || 0}`, filePath])
        fs.rmSync(filePath, { force: true })
    }

    function deskLinuxPath() {
        return path.join(home, '.config', 'autostart', 'rewards-desk.desktop')
    }

    function installLinuxDesk() {
        atomicWrite(
            deskLinuxPath(),
            `[Desktop Entry]\nType=Application\nName=Rewards Desk\nExec=/bin/sh ${desktopQuote(launcher('desk'))}\nX-GNOME-Autostart-enabled=true\n`,
            0o600
        )
    }

    function agentLinuxPath() {
        return path.join(home, '.config', 'systemd', 'user', AGENT_SERVICE)
    }

    function installLinuxAgent() {
        const executable = launcher('agent')
        atomicWrite(
            agentLinuxPath(),
            `[Unit]\nDescription=Microsoft Rewards Bot Core Agent\nAfter=network-online.target\n\n` +
                `[Service]\nType=simple\nWorkingDirectory=${systemdQuote(root)}\nExecStart=/bin/sh ${systemdQuote(executable)}\n` +
                `Restart=on-failure\nRestartSec=15\nEnvironment=NODE_ENV=production\n\n` +
                `[Install]\nWantedBy=default.target\n`,
            0o600
        )
        const reload = run('systemctl', ['--user', 'daemon-reload'])
        if (!reload.ok) throw new Error(reload.stderr || 'systemd user daemon-reload failed')
        const enable = run('systemctl', ['--user', 'enable', '--now', AGENT_SERVICE])
        if (!enable.ok) throw new Error(enable.stderr || enable.stdout || 'Could not enable Core agent service')
    }

    function removeLinuxAgent() {
        run('systemctl', ['--user', 'disable', '--now', AGENT_SERVICE])
        fs.rmSync(agentLinuxPath(), { force: true })
        run('systemctl', ['--user', 'daemon-reload'])
    }

    function status() {
        if (platform === 'win32') {
            const deskStartup = fs.existsSync(windowsStartupPath('desk'))
            const agentStartup = fs.existsSync(windowsStartupPath('agent'))
            return {
                desk: {
                    installed: deskStartup || windowsTaskState(DESK_TASK) || legacyDeskRegistryInstalled(),
                    method: deskStartup ? 'startup-folder' : 'legacy-task-scheduler'
                },
                agent: {
                    installed: agentStartup || windowsTaskState(AGENT_TASK),
                    method: agentStartup ? 'startup-folder' : 'legacy-task-scheduler',
                    supported: true
                }
            }
        }
        if (platform === 'darwin') {
            return {
                desk: { installed: fs.existsSync(launchAgentPath(DESK_LAUNCH_AGENT)), method: 'launch-agent' },
                agent: { installed: fs.existsSync(launchAgentPath(CORE_LAUNCH_AGENT)), method: 'launch-agent', supported: true }
            }
        }
        if (platform === 'linux') {
            const enabled = run('systemctl', ['--user', 'is-enabled', AGENT_SERVICE])
            return {
                desk: { installed: fs.existsSync(deskLinuxPath()), method: 'desktop-autostart' },
                agent: { installed: enabled.stdout === 'enabled', method: 'systemd-user', supported: true }
            }
        }
        return {
            desk: { installed: false, method: 'unsupported' },
            agent: { installed: false, method: 'unsupported', supported: false }
        }
    }

    function setDeskEnabled(enable) {
        if (platform === 'win32') {
            removeLegacyDeskRegistryEntry()
            if (enable) {
                installWindowsStartup('desk')
                removeWindowsTask(DESK_TASK, false)
            } else {
                fs.rmSync(windowsStartupPath('desk'), { force: true })
                removeWindowsTask(DESK_TASK)
            }
        } else if (platform === 'darwin') {
            if (enable) installLaunchAgent(DESK_LAUNCH_AGENT, 'desk')
            else removeLaunchAgent(DESK_LAUNCH_AGENT)
        } else if (platform === 'linux') {
            if (enable) installLinuxDesk()
            else fs.rmSync(deskLinuxPath(), { force: true })
        } else {
            throw new Error('Desk startup is not supported on this platform')
        }
        return status().desk
    }

    function setAgentEnabled(enable) {
        if (platform === 'win32') {
            if (enable) {
                installWindowsStartup('agent')
                removeWindowsTask(AGENT_TASK, false)
            } else {
                fs.rmSync(windowsStartupPath('agent'), { force: true })
                removeWindowsTask(AGENT_TASK)
            }
        } else if (platform === 'darwin') {
            if (enable) installLaunchAgent(CORE_LAUNCH_AGENT, 'agent')
            else removeLaunchAgent(CORE_LAUNCH_AGENT)
        } else if (platform === 'linux') {
            if (enable) installLinuxAgent()
            else removeLinuxAgent()
        } else {
            throw new Error('Core agent startup is not supported on this platform')
        }
        return status().agent
    }

    return { setAgentEnabled, setDeskEnabled, status }
}

function systemdQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function desktopQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

module.exports = { createStartupManager }
