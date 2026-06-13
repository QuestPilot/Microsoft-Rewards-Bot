'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

function resolvePatchrightCli(root) {
    const packagePath = require.resolve('patchright/package.json', { paths: [root] })
    return path.join(path.dirname(packagePath), 'cli.js')
}

function ensurePatchrightChromium(options = {}) {
    const root = path.resolve(options.root || path.join(__dirname, '..'))
    const fsApi = options.fsApi || fs
    const spawnSync = options.spawnSync || childProcess.spawnSync
    const nodePath = options.nodePath || process.execPath
    const patchright = options.patchright || require('patchright')
    const executablePath = patchright.chromium.executablePath()

    if (fsApi.existsSync(executablePath)) {
        return { installed: false, executablePath }
    }

    const cliPath = options.cliPath || resolvePatchrightCli(root)
    console.log('[START] Patchright Chromium is missing. Installing it now...')
    const result = spawnSync(nodePath, [cliPath, 'install', 'chromium'], {
        cwd: root,
        stdio: options.stdio || 'inherit',
        shell: false
    })

    if (result.error) {
        throw new Error(`Could not start the Patchright Chromium installer: ${result.error.message}`)
    }
    if (result.status !== 0) {
        throw new Error(`Patchright Chromium installation failed with exit code ${result.status ?? 'unknown'}`)
    }
    if (!fsApi.existsSync(executablePath)) {
        throw new Error(`Patchright reported success, but Chromium is still missing at ${executablePath}`)
    }

    console.log('[START] Patchright Chromium installed successfully.')
    return { installed: true, executablePath }
}

if (require.main === module) {
    try {
        ensurePatchrightChromium()
    } catch (error) {
        console.error(`[START] ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    }
}

module.exports = { ensurePatchrightChromium, resolvePatchrightCli }
