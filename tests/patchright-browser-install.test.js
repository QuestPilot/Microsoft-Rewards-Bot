const assert = require('node:assert/strict')
const test = require('node:test')

const { ensurePatchrightChromium } = require('../scripts/ensure-patchright-browser')

test('Patchright Chromium installation is skipped when the executable exists', () => {
    let spawnCalls = 0
    const result = ensurePatchrightChromium({
        root: process.cwd(),
        patchright: { chromium: { executablePath: () => 'chromium.exe' } },
        fsApi: { existsSync: () => true },
        spawnSync: () => {
            spawnCalls += 1
            return { status: 0 }
        }
    })

    assert.equal(result.installed, false)
    assert.equal(spawnCalls, 0)
})

test('Patchright Chromium is installed once when the executable is missing', () => {
    let installed = false
    const calls = []
    const result = ensurePatchrightChromium({
        root: process.cwd(),
        nodePath: 'node.exe',
        cliPath: 'patchright-cli.js',
        stdio: 'pipe',
        patchright: { chromium: { executablePath: () => 'chromium.exe' } },
        fsApi: { existsSync: () => installed },
        spawnSync: (command, args, options) => {
            calls.push({ command, args, options })
            installed = true
            return { status: 0 }
        }
    })

    assert.equal(result.installed, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'node.exe')
    assert.deepEqual(calls[0].args, ['patchright-cli.js', 'install', 'chromium'])
})

test('Patchright Chromium installation failures stop startup with a clear error', () => {
    assert.throws(
        () =>
            ensurePatchrightChromium({
                root: process.cwd(),
                cliPath: 'patchright-cli.js',
                stdio: 'pipe',
                patchright: { chromium: { executablePath: () => 'chromium.exe' } },
                fsApi: { existsSync: () => false },
                spawnSync: () => ({ status: 1 })
            }),
        /installation failed with exit code 1/
    )
})
