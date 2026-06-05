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
    isBackgroundLaunch,
    resolveNpmInvocation,
    shouldBuildRuntime,
    shouldRunUpdater
}
