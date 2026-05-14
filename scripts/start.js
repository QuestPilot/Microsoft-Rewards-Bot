const childProcess = require('child_process')
const { UpdateManager } = require('./updater/UpdateManager')

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

function runNpm(args) {
    if (process.env.npm_execpath) {
        run(process.execPath, [process.env.npm_execpath, ...args], `npm ${args.join(' ')}`)
        return
    }

    run('npm', args, `npm ${args.join(' ')}`)
}

async function main() {
    const updater = new UpdateManager()
    await updater.run()

    runNpm(['run', 'build'])
    run(process.execPath, ['./dist/index.js'], 'bot')
}

main().catch(error => {
    console.error(`[START] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
