const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { UpdateManager } = require('./updater/UpdateManager')

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
    if (!isBackgroundLaunch(argv)) return true
    return env.MSRB_BACKGROUND_UPDATE === '1'
}

function hasBuiltRuntime(root = ROOT) {
    return fs.existsSync(path.join(root, 'dist', 'index.js')) && fs.existsSync(path.join(root, 'dist', 'package.json'))
}

function shouldBuildRuntime(argv = process.argv, root = ROOT) {
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

async function main() {
    if (shouldRunUpdater()) {
        const updater = new UpdateManager()
        await updater.run()
    } else {
        console.log('[START] Background launch: skipping update check. Set MSRB_BACKGROUND_UPDATE=1 to enable it.')
    }

    if (shouldBuildRuntime()) {
        runNpm(['run', 'build'])
    } else {
        console.log('[START] Background launch: using existing dist build.')
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
    hasBuiltRuntime,
    hasGuiEnvironment,
    isBackgroundLaunch,
    isAttachLaunch,
    isDockerRuntime,
    isTerminalForced,
    isUiChild,
    readConfig,
    resolveNpmInvocation,
    shouldBuildRuntime,
    launchAppWindow,
    shouldLaunchInterface,
    shouldRunUpdater,
    terminalModeEnabled
}
