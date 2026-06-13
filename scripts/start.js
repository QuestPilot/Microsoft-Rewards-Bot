const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { UpdateManager } = require('./updater/UpdateManager')
const { bootstrapUserFiles, migrateUserFiles } = require('./updater/ConfigMigrator')
const { ensurePatchrightChromium } = require('./ensure-patchright-browser')

const ROOT = path.resolve(__dirname, '..')

function run(command, args, label = command) {
    const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
    const result = childProcess.spawnSync(executable, args, {
        stdio: 'inherit',
        shell: false
    })

    if (result.error) {
        console.error(`[START] Failed to run ${label}: ${result.error.message}`)
        process.exit(1)
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1)
    }
}

function resolveNpmInvocation(env = process.env, nodePath = process.execPath) {
    if (env.npm_execpath) {
        return {
            command: nodePath,
            argsPrefix: [env.npm_execpath],
            label: 'npm'
        }
    }

    const portableNpm = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(portableNpm)) {
        return {
            command: nodePath,
            argsPrefix: [portableNpm],
            label: 'npm'
        }
    }

    return {
        command: 'npm',
        argsPrefix: [],
        label: 'npm'
    }
}

function isBackgroundLaunch(argv = process.argv) {
    return argv.includes('--background')
}

function isAttachLaunch(argv = process.argv) {
    return argv.includes('--attach')
}

function isTerminalForced(argv = process.argv, env = process.env) {
    return argv.includes('--terminal') || env.MSRB_TERMINAL_MODE === '1'
}

function isUiChild(argv = process.argv, env = process.env) {
    return argv.includes('--ui-child') || env.MSRB_UI_CHILD === '1'
}

function isDockerRuntime(fsApi = fs) {
    if (process.platform === 'win32') return false
    if (fsApi.existsSync('/.dockerenv')) return true
    try {
        return /docker|containerd|kubepods/i.test(fsApi.readFileSync('/proc/1/cgroup', 'utf8'))
    } catch {
        return false
    }
}

function readConfig(root = ROOT) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'src', 'config.json'), 'utf8'))
    } catch {
        return null
    }
}

function terminalModeEnabled(config = readConfig()) {
    return config?.terminal?.enabled === true
}

function hasGuiEnvironment(env = process.env) {
    if (env.MSRB_FORCE_APP_WINDOW === '1') return true
    if (env.MSRB_NO_APP_WINDOW === '1' || env.CI === 'true' || env.CI === '1' || env.FORCE_HEADLESS === '1') return false
    if (isDockerRuntime()) return false
    if (process.platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
    return true
}

function shouldLaunchInterface(argv = process.argv, env = process.env, root = ROOT) {
    if (isBackgroundLaunch(argv) || isAttachLaunch(argv) || isTerminalForced(argv, env) || isUiChild(argv, env)) {
        return false
    }
    return hasGuiEnvironment(env) && !terminalModeEnabled(readConfig(root))
}

function shouldRunUpdater(argv = process.argv, env = process.env) {
    if (env.MSRB_POST_UPDATE_RESTART === '1') return false
    if (!isBackgroundLaunch(argv)) return true
    return env.MSRB_BACKGROUND_UPDATE === '1'
}

function hasBuiltRuntime(root = ROOT) {
    return fs.existsSync(path.join(root, 'dist', 'index.js')) && fs.existsSync(path.join(root, 'dist', 'package.json'))
}

function shouldBuildRuntime(argv = process.argv, root = ROOT, env = process.env) {
    if (env.MSRB_POST_UPDATE_RESTART === '1') return true
    if (!isBackgroundLaunch(argv)) return true
    return !hasBuiltRuntime(root)
}

function runNpm(args) {
    const npm = resolveNpmInvocation()
    run(npm.command, [...npm.argsPrefix, ...args], `${npm.label} ${args.join(' ')}`)
}

function launchAppWindow() {
    const child = childProcess.spawn(process.execPath, ['./scripts/app-window.js'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
            ...process.env,
            MSRB_TERMINAL_MODE: '0'
        }
    })
    child.unref()
}

function launchPostUpdateRestart(argv = process.argv, env = process.env, spawn = childProcess.spawn) {
    const child = spawn(process.execPath, argv.slice(1), {
        cwd: ROOT,
        detached: true,
        stdio: 'inherit',
        windowsHide: false,
        env: {
            ...env,
            MSRB_POST_UPDATE_RESTART: '1'
        }
    })
    child.unref()
    return child
}

async function deskCommand(action) {
    const { createDesktopInstallManager } = require('./desktop-install-manager')
    const manager = createDesktopInstallManager({ root: ROOT })

    if (action === 'install') {
        try {
            const result = manager.install()
            console.log('[DESK] Rewards Desk shortcuts installed.')
            const installed = Object.entries(result).filter(([, v]) => v)
            if (installed.length) installed.forEach(([k]) => console.log(`  ✓ ${k}`))
        } catch (err) {
            console.error(`[DESK] Install failed: ${err.message}`)
            process.exit(1)
        }
    } else if (action === 'uninstall') {
        try {
            manager.uninstall()
            console.log('[DESK] Rewards Desk shortcuts removed.')
        } catch (err) {
            console.error(`[DESK] Uninstall failed: ${err.message}`)
            process.exit(1)
        }
    } else if (action === 'status' || !action) {
        try {
            const result = manager.status()
            console.log('[DESK] Shortcut status:')
            Object.entries(result).forEach(([k, v]) => console.log(`  ${v ? '✓' : '✗'} ${k}: ${v ? 'installed' : 'not installed'}`))
        } catch (err) {
            console.error(`[DESK] Status check failed: ${err.message}`)
            process.exit(1)
        }
    } else {
        console.error(`[DESK] Unknown action: ${action}`)
        console.error('Usage: npm start desk [install|uninstall|status]')
        process.exit(1)
    }
}

async function main() {
    if (process.argv[2] === 'desk') {
        await deskCommand(process.argv[3])
        return
    }

    if (shouldRunUpdater()) {
        const updater = new UpdateManager()
        const updateResult = await updater.run()
        if (updateResult.status === 'updated') {
            console.log('[START] Update applied. Restarting with the new version...')
            launchPostUpdateRestart()
            return
        }
    } else {
        console.log(
            process.env.MSRB_POST_UPDATE_RESTART === '1'
                ? '[START] Post-update restart: using the newly installed version.'
                : '[START] Background launch: skipping update check. Set MSRB_BACKGROUND_UPDATE=1 to enable it.'
        )
    }

    bootstrapUserFiles(ROOT)

    // Keep src/config.json and the accounts file in sync with the current
    // example templates on every start (idempotent: only writes when a new key
    // is added or a deprecated one is removed). This guarantees new features
    // reach existing users even when the latest code arrived without going
    // through the updater (manual copy, restore, etc.). Never block startup.
    try {
        migrateUserFiles(ROOT)
    } catch (error) {
        console.warn(`[START] Config migration skipped: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (shouldBuildRuntime(process.argv, ROOT, process.env)) {
        runNpm(['run', 'build'])
    } else {
        console.log('[START] Background launch: using existing dist build.')
    }
    if (!isAttachLaunch()) {
        ensurePatchrightChromium({ root: ROOT })
    }
    if (shouldLaunchInterface()) {
        console.log('[START] Opening app window. Use npm start -- --terminal for developer logs.')
        launchAppWindow()
        return
    }
    run(process.execPath, ['./dist/index.js', ...process.argv.slice(2)], 'bot')
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[START] ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
    })
}

module.exports = {
    bootstrapUserFiles,
    hasBuiltRuntime,
    hasGuiEnvironment,
    isBackgroundLaunch,
    isAttachLaunch,
    isDockerRuntime,
    isTerminalForced,
    isUiChild,
    launchPostUpdateRestart,
    readConfig,
    resolveNpmInvocation,
    shouldBuildRuntime,
    launchAppWindow,
    shouldLaunchInterface,
    shouldRunUpdater,
    terminalModeEnabled
}
