const fs = require('fs')
const path = require('path')

// Same bundled Chromium the Desk itself uses (scripts/desk/browser-launcher.js) —
// resolved separately here since this module writes plain batch/shell TEXT rather
// than spawning anything itself, and must not depend on the Desk module (which
// pulls in the whole app-window runtime).
function resolveBundledChromium() {
    try {
        const { chromium } = require('patchright')
        const executablePath = chromium.executablePath()
        if (executablePath && fs.existsSync(executablePath)) return executablePath
    } catch {
        return null
    }
    return null
}

function createRuntimeLaunchers(options = {}) {
    const root = path.resolve(options.root || process.cwd())
    const platform = options.platform || process.platform
    const nodePath = options.nodePath || process.execPath
    // nodePath is an absolute snapshot of whichever Node process last (re)wrote these
    // launchers — if that exact binary later moves (Node upgraded in place at a new
    // path, a portable/nvm-managed install replaced), the launcher would try to exec a
    // path that no longer exists and fail with a bare OS "path not found" error before
    // Node — and any of our own logging — ever runs. Fall back to whatever `node`
    // resolves to on PATH in that case (covers the common case: Node installed via the
    // official installer, which adds itself to PATH on every OS) instead of hard-failing.
    const winNodeSetup = `if exist "${nodePath}" (set "MSRB_NODE=${nodePath}") else (set "MSRB_NODE=node")`
    const shNodeSetup = `NODE_BIN=${shellQuote(nodePath)}\n[ -x "$NODE_BIN" ] || NODE_BIN=node\n`
    const runtimeDir = path.join(root, 'scripts', 'runtime')
    const startScript = path.join(root, 'scripts', 'start.js')
    const splashPath = path.join(root, 'scripts', 'desk', 'splash.html')
    const splashUrl = `file:///${splashPath.replace(/\\/g, '/')}`
    // Must match <title> in scripts/desk/splash.html exactly — this is how the
    // launcher finds and closes the splash window once the real Desk is ready.
    // Plain ASCII on purpose: batch files default to a legacy codepage and an em
    // dash here could mismatch what Chromium actually renders as the window
    // title, breaking the taskkill filter silently.
    const SPLASH_TITLE = 'Rewards Desk - Loading'

    function atomicWrite(filePath, content, mode = 0o600) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        // Skip entirely when the file already holds this exact content. Without this, a
        // Desk launcher regenerates start-desk.cmd on every ordinary launch (self-heal in
        // start.js) or "Install shortcuts" click — but start-desk.cmd runs its Node command
        // synchronously (no `start`), so the parent cmd.exe is STILL mid-script, holding
        // the file open, while that very Node process tries to rename a new version onto
        // it. Windows then refuses the rename (EPERM/sharing violation) even though the
        // directory itself is perfectly writable (the .tmp write above always succeeds —
        // only the rename-over-the-currently-open-file fails). The regenerated content is
        // identical to what's on disk on almost every call (nothing about the launcher
        // actually changed), so this also means we practically never touch the file again
        // after its first write — the collision this avoids essentially never gets hit.
        try {
            if (fs.readFileSync(filePath, 'utf8') === content) return
        } catch {
            // missing or unreadable → fall through to a real write
        }
        const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${Date.now()}.tmp`)
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode })
        fs.renameSync(tempPath, filePath)
        if (platform !== 'win32') fs.chmodSync(filePath, mode)
    }

    function ensureDeskLauncher() {
        fs.mkdirSync(runtimeDir, { recursive: true })
        const chromiumPath = resolveBundledChromium()
        // Splash flags mirror browser-launcher.js's openAppWindow: sandbox off so the
        // bundled Chromium launches under %LOCALAPPDATA%\ms-playwright, banner
        // suppression, and — same reason as that file's own comment on this exact
        // point — a profile dir UNIQUE PER INVOCATION. A shared fixed profile dir
        // means a second splash launched while an earlier one's Chrome process is
        // still holding the SingletonLock silently fails to open ANY window at all
        // (verified: this is exactly what happened using a fixed path here at first).
        const splashProfileSh = '/tmp/microsoft-rewards-bot-splash-$$'
        const splashArgsWin = chromiumPath
            ? `"${chromiumPath}" --app="${splashUrl}" --window-size=460,300 --window-position=%MSRB_SPLASH_POS% --no-sandbox --disable-setuid-sandbox --no-first-run --no-default-browser-check --disable-extensions --disable-infobars --test-type=webdriver --user-data-dir="%MSRB_SPLASH_PROFILE%"`
            : ''
        const splashArgsSh = chromiumPath
            ? `${shellQuote(chromiumPath)} --app=${shellQuote(splashUrl)} --window-size=460,300 --no-sandbox --disable-setuid-sandbox --no-first-run --no-default-browser-check --disable-extensions --disable-infobars --test-type=webdriver --user-data-dir=${splashProfileSh}`
            : ''
        if (platform === 'win32') {
            const filePath = path.join(runtimeDir, 'start-desk.cmd')
            atomicWrite(
                filePath,
                [
                    '@echo off',
                    'title Rewards Desk - Starting',
                    'color 0B',
                    'for %%i in ("%~dp0..\\..") do set "MSRB_ROOT=%%~fi"',
                    'set "MSRB_LAUNCHER=%~f0"',
                    'if /i "%~1"=="--msrb-elevated" set "MSRB_ELEVATED_RELAUNCH=1"',
                    'if /i "%~1"=="--msrb-minimized" set "MSRB_MINIMIZED_RELAUNCH=1"',
                    'cd /d "%MSRB_ROOT%"',
                    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p=Join-Path $env:MSRB_ROOT (\'.msrb-write-test-\'+[guid]::NewGuid().ToString(\'N\')+\'.tmp\');try{[IO.File]::WriteAllText($p,\'\');[IO.File]::Delete($p);exit 0}catch{Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue;exit 1}"',
                    'if not errorlevel 1 goto start',
                    'if "%MSRB_ELEVATED_RELAUNCH%"=="1" goto permission_error',
                    'echo.',
                    'echo   Administrator permission is required for this installation.',
                    'echo   Requesting permission to restart Rewards Desk...',
                    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{Start-Process -FilePath $env:MSRB_LAUNCHER -ArgumentList \'--msrb-elevated\' -WorkingDirectory $env:MSRB_ROOT -Verb RunAs -ErrorAction Stop;exit 0}catch{Write-Error $_;exit 1}"',
                    'set "MSRB_EXIT=%errorlevel%"',
                    'if not "%MSRB_EXIT%"=="0" (',
                    '  echo.',
                    '  echo Rewards Desk could not obtain administrator permission.',
                    '  pause',
                    ')',
                    'exit /b %MSRB_EXIT%',
                    ':permission_error',
                    'echo.',
                    'echo Rewards Desk still cannot write to its installation directory.',
                    'echo Check the folder permissions or reinstall to a writable location.',
                    'pause',
                    'exit /b 1',
                    ':start',
                    // Already the minimized re-invocation (or no bundled Chromium yet to
                    // show a splash with, e.g. the very first-ever run) — skip straight
                    // to doing the work in THIS window.
                    'if "%MSRB_MINIMIZED_RELAUNCH%"=="1" goto run',
                    // Set (and pass to the minimized child below, which inherits the
                    // environment) BEFORE launching, so the SAME value is available for
                    // cleanup later in :run — a fixed/shared profile dir would let a
                    // still-running earlier splash's SingletonLock silently block a new
                    // one from ever opening a window at all.
                    splashArgsWin ? 'set "MSRB_SPLASH_PROFILE=%TEMP%\\microsoft-rewards-bot-splash-%RANDOM%%RANDOM%"' : '',
                    // Centered position, computed fresh each launch (screen resolution
                    // can change between sessions). Falls back to a fixed offset if the
                    // PowerShell call ever fails, rather than not showing the splash.
                    splashArgsWin
                        ? `for /f "delims=" %%p in ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%MSRB_ROOT%\\scripts\\launchers\\win-window-helper.ps1" center 460 300') do set "MSRB_SPLASH_POS=%%p"`
                        : '',
                    splashArgsWin ? 'if not defined MSRB_SPLASH_POS set "MSRB_SPLASH_POS=120,120"' : '',
                    splashArgsWin ? `start "${SPLASH_TITLE}" ${splashArgsWin}` : '',
                    // Best-effort: bring the splash to the foreground once it appears.
                    // Windows' own focus-stealing prevention can still block this for a
                    // background-launched process (same limitation every app with a
                    // loading splash runs into) — harmless if it silently no-ops.
                    splashArgsWin
                        ? `start "" /min powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%MSRB_ROOT%\\scripts\\launchers\\win-window-helper.ps1" foreground "${SPLASH_TITLE}"`
                        : '',
                    // Splash is now the visible "loading" cue — relaunch minimized so
                    // this console window disappears from view (still running, still
                    // available if the user un-minimizes it from the taskbar).
                    // Explicit cmd.exe /c (not just "%~f0" directly) — matches the
                    // already-proven pattern installWindowsStartup uses for the
                    // agent/notifier minimized relaunch. Letting Windows resolve the
                    // .cmd file association on its own was observed to be unreliable
                    // here (intermittently never reached :run at all).
                    'start "" /min cmd.exe /c ""%~f0" --msrb-minimized"',
                    'exit /b 0',
                    ':run',
                    'echo.',
                    'echo   Rewards Desk is preparing...',
                    'echo   Updates and local files are being checked.',
                    'echo.',
                    'for %%i in ("%~dp0.") do set "MSRB_LAUNCHER_DIR=%%~fi"',
                    winNodeSetup,
                    `"%MSRB_NODE%" "%MSRB_ROOT%\\scripts\\start.js"`,
                    'set "MSRB_EXIT=%errorlevel%"',
                    `taskkill /FI "WINDOWTITLE eq ${SPLASH_TITLE}*" /F >nul 2>&1`,
                    'if defined MSRB_SPLASH_PROFILE rmdir /s /q "%MSRB_SPLASH_PROFILE%" >nul 2>&1',
                    // Best-effort foreground for the real Desk window too, once it has
                    // had a moment to appear. Same focus-stealing caveat as above.
                    'if "%MSRB_EXIT%"=="0" start "" /min powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%MSRB_ROOT%\\scripts\\launchers\\win-window-helper.ps1" foreground "Rewards Desk"',
                    // The write-test at :start only proves the ROOT folder accepts a new
                    // file — it does not prove Node itself (or a deeper path start.js
                    // touches) is accessible. Real users have hit both "cannot find the
                    // path specified" and "Access is denied" here on installs the write-
                    // test happily passed. Rather than guess which failures are actually
                    // permission-related (the same underlying problem shows different,
                    // locale-dependent OS text), retry ONCE with administrator permission
                    // on ANY failure — bounded by MSRB_ELEVATED_RELAUNCH so it can never
                    // loop, and a real (non-permission) bug still fails the same way, just
                    // after one extra UAC prompt instead of a dead end.
                    'if not "%MSRB_EXIT%"=="0" if not "%MSRB_ELEVATED_RELAUNCH%"=="1" goto retry_elevated',
                    'if not "%MSRB_EXIT%"=="0" (',
                    '  echo.',
                    '  echo Rewards Desk could not start. Review the error above.',
                    '  pause',
                    ')',
                    'exit /b %MSRB_EXIT%',
                    ':retry_elevated',
                    'echo.',
                    'echo   Rewards Desk could not start - retrying with administrator permission...',
                    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try{Start-Process -FilePath $env:MSRB_LAUNCHER -ArgumentList \'--msrb-elevated\' -WorkingDirectory $env:MSRB_ROOT -Verb RunAs -ErrorAction Stop;exit 0}catch{Write-Error $_;exit 1}"',
                    'if not errorlevel 1 exit /b 0',
                    'echo.',
                    'echo Rewards Desk could not start, and administrator permission was not granted.',
                    'echo Review the error above.',
                    'pause',
                    'exit /b 1',
                    ''
                ]
                    .filter(line => line !== '')
                    .join('\r\n')
            )
            return filePath
        }

        const filePath = path.join(runtimeDir, 'start-desk.sh')
        // macOS-only write-permission check + native admin-privileges relaunch —
        // mirrors the Windows PowerShell writability probe + UAC elevation above.
        // Deliberately NOT extended to Linux: there is no universal equivalent
        // (pkexec needs a polkit agent that isn't always running; gksudo/kdesudo are
        // effectively gone from current distros) — a failed elevation attempt there
        // would be more confusing than the plain permission error Node already gives.
        const macElevationCheck =
            platform === 'darwin'
                ? `if [ "$1" != "--msrb-elevated" ]; then\n` +
                  `  if ! ( touch .msrb-write-test-$$.tmp 2>/dev/null && rm -f .msrb-write-test-$$.tmp ); then\n` +
                  `    osascript -e "do shell script \\"$0 --msrb-elevated\\" with administrator privileges" || exit 1\n` +
                  `    exit 0\n` +
                  `  fi\n` +
                  `fi\n`
                : ''
        atomicWrite(
            filePath,
            `#!/usr/bin/env sh\n` +
                `cd ${shellQuote(root)} || exit 1\n` +
                macElevationCheck +
                (splashArgsSh ? `${splashArgsSh} >/dev/null 2>&1 &\nSPLASH_PID=$!\n` : '') +
                `printf '\\n  Rewards Desk is preparing...\\n  Updates and local files are being checked.\\n\\n'\n` +
                `export MSRB_LAUNCHER_DIR=${shellQuote(runtimeDir)}\n` +
                shNodeSetup +
                `"$NODE_BIN" ${shellQuote(startScript)}\n` +
                `status=$?\n` +
                (splashArgsSh
                    ? `kill "$SPLASH_PID" >/dev/null 2>&1\nrm -rf "${splashProfileSh}" >/dev/null 2>&1\n`
                    : '') +
                `if [ "$status" -ne 0 ]; then printf '\\nStartup failed. Press Enter to close.\\n'; read answer; fi\n` +
                `exit "$status"\n`,
            0o700
        )
        return filePath
    }

    function ensureAgentLauncher() {
        fs.mkdirSync(runtimeDir, { recursive: true })
        if (platform === 'win32') {
            const filePath = path.join(runtimeDir, 'start-background.cmd')
            atomicWrite(
                filePath,
                [
                    '@echo off',
                    'for %%i in ("%~dp0..\\..") do set "MSRB_ROOT=%%~fi"',
                    'cd /d "%MSRB_ROOT%"',
                    'for %%i in ("%~dp0.") do set "MSRB_LAUNCHER_DIR=%%~fi"',
                    winNodeSetup,
                    `"%MSRB_NODE%" "%MSRB_ROOT%\\scripts\\start.js" --background >> "%MSRB_ROOT%\\data\\logs\\background-agent.log" 2>&1`,
                    ''
                ].join('\r\n')
            )
            return filePath
        }

        const filePath = path.join(runtimeDir, 'start-background.sh')
        atomicWrite(
            filePath,
            `#!/usr/bin/env sh\ncd ${shellQuote(root)} || exit 1\nexport MSRB_LAUNCHER_DIR=${shellQuote(runtimeDir)}\n${shNodeSetup}exec "$NODE_BIN" ${shellQuote(startScript)} --background\n`,
            0o700
        )
        return filePath
    }

    // The update notifier is a lightweight, always-invisible polling loop — it does
    // NOT go through start.js (no update/smart-build dance, no window). Runs directly
    // as its own tiny Node script so it stays cheap enough to sit in login items
    // indefinitely without anyone noticing.
    function ensureNotifierLauncher() {
        fs.mkdirSync(runtimeDir, { recursive: true })
        const daemonScript = path.join(root, 'scripts', 'notifier', 'notifier-daemon.js')
        if (platform === 'win32') {
            const filePath = path.join(runtimeDir, 'start-notifier.cmd')
            atomicWrite(
                filePath,
                [
                    '@echo off',
                    'for %%i in ("%~dp0..\\..") do set "MSRB_ROOT=%%~fi"',
                    'cd /d "%MSRB_ROOT%"',
                    winNodeSetup,
                    `"%MSRB_NODE%" "${daemonScript}" >> "%MSRB_ROOT%\\data\\logs\\update-notifier.log" 2>&1`,
                    ''
                ].join('\r\n')
            )
            return filePath
        }

        const filePath = path.join(runtimeDir, 'start-notifier.sh')
        atomicWrite(
            filePath,
            `#!/usr/bin/env sh\ncd ${shellQuote(root)} || exit 1\n${shNodeSetup}exec "$NODE_BIN" ${shellQuote(daemonScript)}\n`,
            0o700
        )
        return filePath
    }

    return { ensureAgentLauncher, ensureDeskLauncher, ensureNotifierLauncher, runtimeDir }
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
}

module.exports = { createRuntimeLaunchers }
