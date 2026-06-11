const fs = require('fs')
const path = require('path')

function createRuntimeLaunchers(options = {}) {
    const root = path.resolve(options.root || process.cwd())
    const platform = options.platform || process.platform
    const nodePath = options.nodePath || process.execPath
    const runtimeDir = path.join(root, '.core')
    const startScript = path.join(root, 'scripts', 'start.js')

    function atomicWrite(filePath, content, mode = 0o600) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${Date.now()}.tmp`)
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode })
        fs.renameSync(tempPath, filePath)
        if (platform !== 'win32') fs.chmodSync(filePath, mode)
    }

    function ensureDeskLauncher() {
        fs.mkdirSync(runtimeDir, { recursive: true })
        if (platform === 'win32') {
            const filePath = path.join(runtimeDir, 'start-desk.cmd')
            atomicWrite(
                filePath,
                [
                    '@echo off',
                    'title Rewards Desk - Starting',
                    'color 0B',
                    `cd /d "${root}"`,
                    'echo.',
                    'echo   Rewards Desk is preparing...',
                    'echo   Updates and local files are being checked.',
                    'echo.',
                    `"${nodePath}" "${startScript}"`,
                    'set "MSRB_EXIT=%errorlevel%"',
                    'if not "%MSRB_EXIT%"=="0" (',
                    '  echo.',
                    '  echo Rewards Desk could not start. Review the error above.',
                    '  pause',
                    ')',
                    'exit /b %MSRB_EXIT%',
                    ''
                ].join('\r\n')
            )
            return filePath
        }

        const filePath = path.join(runtimeDir, 'start-desk.sh')
        atomicWrite(
            filePath,
            `#!/usr/bin/env sh\ncd ${shellQuote(root)} || exit 1\nprintf '\\n  Rewards Desk is preparing...\\n  Updates and local files are being checked.\\n\\n'\n${shellQuote(nodePath)} ${shellQuote(startScript)}\nstatus=$?\nif [ "$status" -ne 0 ]; then printf '\\nStartup failed. Press Enter to close.\\n'; read answer; fi\nexit "$status"\n`,
            0o700
        )
        return filePath
    }

    function ensureAgentLauncher() {
        fs.mkdirSync(runtimeDir, { recursive: true })
        const logsDir = path.join(root, 'logs')
        fs.mkdirSync(logsDir, { recursive: true })
        if (platform === 'win32') {
            const filePath = path.join(runtimeDir, 'start-background.cmd')
            atomicWrite(
                filePath,
                [
                    '@echo off',
                    `cd /d "${root}"`,
                    `"${nodePath}" "${startScript}" --background >> "${path.join(logsDir, 'background-agent.log')}" 2>&1`,
                    ''
                ].join('\r\n')
            )
            return filePath
        }

        const filePath = path.join(runtimeDir, 'start-background.sh')
        atomicWrite(
            filePath,
            `#!/usr/bin/env sh\ncd ${shellQuote(root)} || exit 1\nexec ${shellQuote(nodePath)} ${shellQuote(startScript)} --background\n`,
            0o700
        )
        return filePath
    }

    return { ensureAgentLauncher, ensureDeskLauncher, runtimeDir }
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

module.exports = { createRuntimeLaunchers }
