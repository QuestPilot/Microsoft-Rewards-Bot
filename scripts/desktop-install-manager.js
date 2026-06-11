const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRuntimeLaunchers } = require('./runtime-launchers')

function createDesktopInstallManager(options = {}) {
    const root = path.resolve(options.root || process.cwd())
    const platform = options.platform || process.platform
    const home = options.home || os.homedir()
    const env = options.env || process.env
    const execFileSync = options.execFileSync || childProcess.execFileSync
    const launchers = createRuntimeLaunchers({ root, platform })
    const iconPng = path.join(root, 'assets', 'logo.png')
    const iconIco = path.join(root, 'assets', 'logo.ico')

    function atomicWrite(filePath, content, mode = 0o600) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const tempPath = `${filePath}.${process.pid}-${Date.now()}.tmp`
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode })
        fs.renameSync(tempPath, filePath)
        if (platform !== 'win32') fs.chmodSync(filePath, mode)
    }

    function run(command, args, extraEnv = {}) {
        return execFileSync(command, args, {
            cwd: root,
            encoding: 'utf8',
            env: { ...env, ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        })
    }

    function windowsPaths() {
        const desktop = path.join(home, 'Desktop', 'Rewards Desk.lnk')
        const startMenu = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Rewards Desk.lnk')
        return { desktop, startMenu }
    }

    function createWindowsShortcut(shortcutPath, launcherPath) {
        const script =
            '$ws=New-Object -ComObject WScript.Shell;' +
            '$s=$ws.CreateShortcut($env:MSRB_SHORTCUT_PATH);' +
            '$s.TargetPath=$env:ComSpec;' +
            '$s.Arguments=("/c `"`""+$env:MSRB_LAUNCHER+"`"`"");' +
            '$s.WorkingDirectory=$env:MSRB_ROOT;' +
            '$s.IconLocation=($env:MSRB_ICON+",0");' +
            '$s.Description="Microsoft Rewards Bot local control panel";' +
            '$s.Save()'
        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true })
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            MSRB_SHORTCUT_PATH: shortcutPath,
            MSRB_LAUNCHER: launcherPath,
            MSRB_ROOT: root,
            MSRB_ICON: iconIco
        })
    }

    function linuxPaths() {
        return {
            menu: path.join(home, '.local', 'share', 'applications', 'rewards-desk.desktop'),
            desktop: path.join(home, 'Desktop', 'Rewards Desk.desktop')
        }
    }

    function linuxDesktopEntry(launcherPath) {
        return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Rewards Desk\nComment=Microsoft Rewards Bot local control panel\nExec=/bin/sh ${desktopQuote(launcherPath)}\nIcon=${iconPng}\nTerminal=true\nCategories=Utility;\nStartupNotify=true\n`
    }

    function macAppPath() {
        return path.join(home, 'Applications', 'Rewards Desk.app')
    }

    function installMacApp() {
        const appPath = macAppPath()
        const executable = path.join(appPath, 'Contents', 'MacOS', 'RewardsDesk')
        const resources = path.join(appPath, 'Contents', 'Resources')
        atomicWrite(
            path.join(appPath, 'Contents', 'Info.plist'),
            `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Rewards Desk</string><key>CFBundleDisplayName</key><string>Rewards Desk</string><key>CFBundleIdentifier</key><string>tf.lgtw.rewardsdesk</string><key>CFBundleExecutable</key><string>RewardsDesk</string><key>CFBundleIconFile</key><string>AppIcon.png</string></dict></plist>\n`
        )
        atomicWrite(
            executable,
            `#!/bin/sh\nopen -a Terminal ${shellQuote(launchers.ensureDeskLauncher())}\n`,
            0o700
        )
        fs.mkdirSync(resources, { recursive: true })
        fs.copyFileSync(iconPng, path.join(resources, 'AppIcon.png'))
        return appPath
    }

    function status() {
        if (platform === 'win32') {
            const paths = windowsPaths()
            return {
                supported: true,
                platform,
                desktop: fs.existsSync(paths.desktop),
                menu: fs.existsSync(paths.startMenu)
            }
        }
        if (platform === 'darwin') {
            return {
                supported: true,
                platform,
                desktop: fs.existsSync(macAppPath()),
                menu: fs.existsSync(macAppPath())
            }
        }
        if (platform === 'linux') {
            const paths = linuxPaths()
            return {
                supported: true,
                platform,
                desktop: fs.existsSync(paths.desktop),
                menu: fs.existsSync(paths.menu)
            }
        }
        return { supported: false, platform, desktop: false, menu: false }
    }

    function install() {
        if (platform === 'win32') {
            const paths = windowsPaths()
            const launcherPath = launchers.ensureDeskLauncher()
            createWindowsShortcut(paths.desktop, launcherPath)
            createWindowsShortcut(paths.startMenu, launcherPath)
            return status()
        }
        if (platform === 'darwin') {
            installMacApp()
            return status()
        }
        if (platform === 'linux') {
            const paths = linuxPaths()
            const entry = linuxDesktopEntry(launchers.ensureDeskLauncher())
            atomicWrite(paths.menu, entry, 0o755)
            if (fs.existsSync(path.dirname(paths.desktop))) atomicWrite(paths.desktop, entry, 0o755)
            return status()
        }
        throw new Error('Desktop installation is not supported on this platform')
    }

    function uninstall() {
        if (platform === 'win32') {
            const paths = windowsPaths()
            fs.rmSync(paths.desktop, { force: true })
            fs.rmSync(paths.startMenu, { force: true })
            return status()
        }
        if (platform === 'darwin') {
            fs.rmSync(macAppPath(), { recursive: true, force: true })
            return status()
        }
        if (platform === 'linux') {
            const paths = linuxPaths()
            fs.rmSync(paths.desktop, { force: true })
            fs.rmSync(paths.menu, { force: true })
            return status()
        }
        throw new Error('Desktop installation is not supported on this platform')
    }

    return { install, status, uninstall }
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

function desktopQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

module.exports = { createDesktopInstallManager }
