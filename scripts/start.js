const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { UpdateManager } = require('./updater/UpdateManager')
const { bootstrapUserFiles, migrateUserFiles } = require('./updater/ConfigMigrator')
const { ensurePatchrightChromium } = require('./build/ensure-patchright-browser')
const { createStartupManager } = require('./launchers/startup-manager')

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

function isHarvesterLaunch(argv = process.argv) {
    return argv[2] === 'harvester'
}

function isTerminalForced(argv = process.argv, env = process.env) {
    return isHarvesterLaunch(argv) || argv.includes('--terminal') || env.MSRB_TERMINAL_MODE === '1'
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

// Headless Desk service: run the Desk server with NO window (servers/Docker), so the bot
// stays reachable + controllable from Nexus without a GUI. Opt-in via config desk.headless.
function headlessDeskService(config = readConfig()) {
    return config?.desk?.headless === true
}

// Update Notifier: tiny invisible background process, desktop OSes only (never a
// headless Linux server or Docker — see hasGuiEnvironment below). Installed on the
// first normal launch and kept in sync with config.updateNotifier.enabled on every
// launch after that: disabling it in config.json removes its OS autostart
// registration AND kills it if it's currently running (it doesn't fully uninstall —
// deleting the bot folder is what actually removes it, matching every other
// in-place launcher here).
function killRunningNotifier(root = ROOT) {
    const statePath = path.join(root, 'data', 'notifier', 'notifier.json')
    try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        if (state?.pid) process.kill(state.pid, 'SIGTERM')
    } catch {
        // Not running, or already gone — nothing to do.
    }
    fs.rmSync(statePath, { force: true })
}

function syncUpdateNotifier(config = readConfig(), root = ROOT, env = process.env) {
    if (!hasGuiEnvironment(env)) return // nowhere for a native notification to appear
    const enabled = config?.updateNotifier?.enabled !== false
    const manager = createStartupManager({ root })
    try {
        const installed = manager.status().notifier.installed
        if (enabled && !installed) {
            manager.setNotifierEnabled(true)
        } else if (!enabled) {
            if (installed) manager.setNotifierEnabled(false)
            killRunningNotifier(root)
        }
    } catch (error) {
        console.warn(`[START] Update notifier sync skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function hasGuiEnvironment(env = process.env) {
    if (env.MSRB_FORCE_APP_WINDOW === '1') return true
    if (env.MSRB_NO_APP_WINDOW === '1' || env.CI === 'true' || env.CI === '1' || env.FORCE_HEADLESS === '1')
        return false
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
    if (isHarvesterLaunch(argv)) return false
    if (env.MSRB_POST_UPDATE_RESTART === '1') return false
    if (!isBackgroundLaunch(argv)) return true
    return env.MSRB_BACKGROUND_UPDATE === '1'
}

function hasBuiltRuntime(root = ROOT) {
    return fs.existsSync(path.join(root, 'dist', 'index.js')) && fs.existsSync(path.join(root, 'dist', 'package.json'))
}

// ── Smart build: only rebuild when the local source actually changed ──────────
// We fingerprint every file under src/ (plus package.json + tsconfig.json) by
// size + mtime and compare it to the marker written after the last successful
// build. Any uncertainty (missing/invalid marker, unreadable tree) resolves to
// "build" on purpose — false positives that rebuild are cheap, a stale runtime
// is not. An update (post-update restart) and a missing dist always force it.
const BUILD_MARKER_REL = path.join('data', '.build-state.json')

// User data under src/ that the bot/desk rewrite at runtime (re-encrypted accounts,
// config edits). These must NOT feed the build fingerprint, or it would change on
// every run and defeat the smart-build skip. The desk syncs config.json into dist
// itself, and accounts are read from src/ — so excluding them is safe.
const RUNTIME_DATA_FILES = new Set(['config.json', 'accounts.json', 'accounts.enc.json'])

function computeSourceFingerprint(root = ROOT) {
    const crypto = require('crypto')
    const inputs = []
    const walk = dir => {
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.isFile()) {
                if (RUNTIME_DATA_FILES.has(entry.name) || entry.name.endsWith('.bak')) continue
                try {
                    const st = fs.statSync(full)
                    inputs.push(`${full}:${st.size}:${Math.round(st.mtimeMs)}`)
                } catch {
                    /* ignore unreadable file */
                }
            }
        }
    }
    walk(path.join(root, 'src'))
    for (const rel of ['package.json', 'tsconfig.json']) {
        try {
            const st = fs.statSync(path.join(root, rel))
            inputs.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`)
        } catch {
            /* file may not exist */
        }
    }
    return crypto.createHash('sha1').update(inputs.join('\n')).digest('hex')
}

function sourceChangedSinceBuild(root = ROOT) {
    try {
        const marker = JSON.parse(fs.readFileSync(path.join(root, BUILD_MARKER_REL), 'utf8'))
        if (!marker || !marker.fingerprint) return true
        return marker.fingerprint !== computeSourceFingerprint(root)
    } catch {
        return true
    }
}

function writeBuildMarker(root = ROOT) {
    try {
        fs.mkdirSync(path.join(root, 'data'), { recursive: true })
        fs.writeFileSync(
            path.join(root, BUILD_MARKER_REL),
            `${JSON.stringify({ fingerprint: computeSourceFingerprint(root), builtAt: new Date().toISOString() }, null, 2)}\n`
        )
    } catch {
        /* best-effort: a missing marker just means we rebuild next time */
    }
}

function shouldBuildRuntime(argv = process.argv, root = ROOT, env = process.env) {
    if (env.MSRB_POST_UPDATE_RESTART === '1') return true
    if (!hasBuiltRuntime(root)) return true
    if (isBackgroundLaunch(argv)) return false
    // Foreground (desk / terminal): rebuild only when local source changed.
    return sourceChangedSinceBuild(root)
}

// ── First-run experience: terminal first, app window afterwards ───────────────
// The very first desk launch runs in the terminal so installs/migrations are
// fully visible and verifiable. From the second launch on we open the polished
// app window instead. The count lives in data/ (where the desk records state).
const LAUNCH_MARKER_REL = path.join('data', '.launch-state.json')

function readLaunchState(root = ROOT) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, LAUNCH_MARKER_REL), 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : { deskLaunches: 1 }
    } catch (error) {
        // Missing marker → genuine first launch. Unreadable/corrupt → assume not
        // first, so a bad file never traps the user in the terminal forever.
        if (error && error.code === 'ENOENT') return { deskLaunches: 0 }
        return { deskLaunches: 1 }
    }
}

function isFirstDeskLaunch(root = ROOT) {
    return (readLaunchState(root).deskLaunches || 0) === 0
}

function recordDeskLaunch(root = ROOT) {
    try {
        const state = readLaunchState(root)
        const nowIso = new Date().toISOString()
        const next = {
            ...state,
            deskLaunches: (state.deskLaunches || 0) + 1,
            firstLaunchAt: state.firstLaunchAt || nowIso,
            lastLaunchAt: nowIso
        }
        fs.mkdirSync(path.join(root, 'data'), { recursive: true })
        fs.writeFileSync(path.join(root, LAUNCH_MARKER_REL), `${JSON.stringify(next, null, 2)}\n`)
    } catch {
        /* best-effort */
    }
}

function runNpm(args) {
    const npm = resolveNpmInvocation()
    run(npm.command, [...npm.argsPrefix, ...args], `${npm.label} ${args.join(' ')}`)
}

function launchAppWindow() {
    const child = childProcess.spawn(process.execPath, ['./scripts/desk/app-window.js'], {
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
    const { createDesktopInstallManager } = require('./launchers/desktop-install-manager')
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
            Object.entries(result).forEach(([k, v]) =>
                console.log(`  ${v ? '✓' : '✗'} ${k}: ${v ? 'installed' : 'not installed'}`)
            )
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

// One-time migration of the generated launchers out of the legacy .core directory.
// Re-points any installed desktop shortcuts and OS auto-start entries to the new
// scripts/runtime launchers, then removes .core once we're actually running from
// the new launcher (signalled by MSRB_LAUNCHER_DIR). Best-effort and idempotent;
// never allowed to block startup.
function migrateLaunchers(root = ROOT, env = process.env) {
    try {
        const { createRuntimeLaunchers } = require('./launchers/runtime-launchers')
        const currentDir = createRuntimeLaunchers({ root }).runtimeDir
        const legacy = path.join(root, '.core')
        const legacyExists = fs.existsSync(legacy)
        const markerPath = path.join(root, 'data', '.launcher-state.json')
        let marker = {}
        try {
            marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
        } catch {
            marker = {}
        }
        const migrated = marker.launcherDir && path.resolve(marker.launcherDir) === path.resolve(currentDir)
        if (!migrated) {
            // Only pre-existing installs (which still carry a legacy .core launcher dir)
            // need their shortcuts / OS auto-start re-pointed. Fresh installs already
            // target scripts/runtime, so for them we just record the marker.
            if (legacyExists) {
                try {
                    const { createDesktopInstallManager } = require('./launchers/desktop-install-manager')
                    const mgr = createDesktopInstallManager({ root })
                    const st = mgr.status()
                    if (st && (st.desktop || st.menu)) mgr.install()
                } catch {
                    /* shortcuts absent or not writable — skip */
                }
                try {
                    const { createStartupManager } = require('./launchers/startup-manager')
                    const sm = createStartupManager({ root })
                    const sst = sm.status()
                    if (sst && sst.desk && sst.desk.installed) sm.setDeskEnabled(true)
                    if (sst && sst.agent && sst.agent.installed) sm.setAgentEnabled(true)
                } catch {
                    /* auto-start not enabled — skip */
                }
            }
            try {
                fs.mkdirSync(path.join(root, 'data'), { recursive: true })
                fs.writeFileSync(
                    markerPath,
                    `${JSON.stringify({ launcherDir: currentDir, migratedAt: new Date().toISOString() }, null, 2)}\n`
                )
            } catch {
                /* best-effort */
            }
        }
        // Retire the legacy .core directory once we are actually running from the new
        // launcher (signalled by MSRB_LAUNCHER_DIR). Safe: nothing references it now.
        if (
            legacyExists &&
            env.MSRB_LAUNCHER_DIR &&
            path.resolve(env.MSRB_LAUNCHER_DIR) === path.resolve(currentDir)
        ) {
            try {
                fs.rmSync(legacy, { recursive: true, force: true })
            } catch {
                /* may still be in use — retried on the next launch */
            }
        }
    } catch {
        /* migration is never allowed to block startup */
    }
}

async function main() {
    if (process.argv[2] === 'desk') {
        await deskCommand(process.argv[3])
        return
    }

    const harvesterLaunch = isHarvesterLaunch()
    if (harvesterLaunch) {
        // Isolate the command from persistent/background integrations. The Core
        // harvester remains allowed to rebuild its explicit Page/ artifact folder.
        process.env.MSRB_EPHEMERAL_RUN = '1'
        process.env.MSRB_DISABLE_PLUGINS = '1'
        process.env.MSRB_TERMINAL_MODE = '1'
    }

    // Migrate generated launchers out of legacy .core (interactive launches only).
    if (!isBackgroundLaunch() && !harvesterLaunch) {
        migrateLaunchers(ROOT, process.env)
    }

    // Self-heal the generated launchers (scripts/runtime/*) that the OS shortcuts
    // and auto-start entries point at. They are gitignored and were only written
    // at install time, so anything that removed them — a manual folder copy, or an
    // older updater build that pruned scripts/runtime — left the shortcut pointing
    // at a missing file (clicking it did nothing). Re-ensuring them here on every
    // real launch keeps them present and in sync with the current template. Never
    // allowed to block startup.
    if (!harvesterLaunch) {
        try {
            createStartupManager({ root: ROOT }).ensureInstalledLaunchers()
        } catch {
            /* best-effort: a launch that got this far already has a working launcher */
        }
    }

    if (shouldRunUpdater()) {
        const updater = new UpdateManager()
        const updateResult = await updater.run()
        if (updateResult.status === 'updated') {
            console.log('[START] Update applied. Restarting with the new version...')
            launchPostUpdateRestart()
            return
        }
    } else if (harvesterLaunch) {
        console.log('[HARVESTER] Update check disabled for this isolated maintenance run.')
    } else {
        console.log(
            process.env.MSRB_POST_UPDATE_RESTART === '1'
                ? '[START] Post-update restart: using the newly installed version.'
                : '[START] Background launch: skipping update check. Set MSRB_BACKGROUND_UPDATE=1 to enable it.'
        )
    }

    if (!harvesterLaunch) {
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

        // Only for normal desktop launches — never a background/agent run (headless
        // farming, no GUI expectation) or an --attach (reattaching to an already-
        // running agent, not a fresh startup event).
        if (!isBackgroundLaunch() && !isAttachLaunch()) {
            syncUpdateNotifier(readConfig(ROOT), ROOT, process.env)
        }
    }

    if (shouldBuildRuntime(process.argv, ROOT, process.env)) {
        runNpm(['run', 'build'])
        writeBuildMarker(ROOT)
    } else {
        console.log('[START] No source changes since the last build — reusing the existing dist.')
    }
    if (!isAttachLaunch()) {
        ensurePatchrightChromium({ root: ROOT })
    }
    // Headless Desk service (opt-in) — run the Desk server with no window for servers/Docker.
    // Takes precedence over the bot fallback, but never hijacks the agent/terminal/child paths.
    if (
        headlessDeskService(readConfig(ROOT)) &&
        !isBackgroundLaunch() && !isTerminalForced() && !isUiChild() && !isAttachLaunch()
    ) {
        console.log('[START] Starting Rewards Desk as a headless service (no window).')
        process.env.MSRB_APP_NO_OPEN = '1'
        process.env.MSRB_TERMINAL_MODE = '0'
        run(process.execPath, ['./scripts/desk/app-window.js'], 'desk')
        return
    }
    if (shouldLaunchInterface()) {
        // Clicking the Rewards Desk shortcut ALWAYS opens the Desk (the control
        // panel) — it never auto-runs the bot. The visible prep above (update check
        // + smart build) is the first-launch terminal step; the Desk's own loading
        // screen then takes over. Smart build keeps later launches fast.
        const before = readLaunchState(ROOT)
        const firstDesk = (before.deskLaunches || 0) === 0
        recordDeskLaunch(ROOT)
        // Once (right after the first visible launch), switch the shortcut to a
        // minimized window so subsequent launches show the Desk's own loading screen
        // instead of a black console. Gated by a marker flag so it runs a single time.
        if (!before.launcherMinimized) {
            try {
                require('./launchers/desktop-install-manager')
                    .createDesktopInstallManager({ root: ROOT })
                    .setLauncherMinimized(true)
                const st = readLaunchState(ROOT)
                fs.writeFileSync(
                    path.join(ROOT, LAUNCH_MARKER_REL),
                    `${JSON.stringify({ ...st, launcherMinimized: true }, null, 2)}\n`
                )
            } catch {
                /* shortcuts not installed — fine */
            }
        }
        console.log(firstDesk ? '[START] Setup complete — opening Rewards Desk.' : '[START] Opening Rewards Desk…')
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
    computeSourceFingerprint,
    sourceChangedSinceBuild,
    writeBuildMarker,
    isFirstDeskLaunch,
    recordDeskLaunch,
    readLaunchState,
    hasBuiltRuntime,
    hasGuiEnvironment,
    isHarvesterLaunch,
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
    terminalModeEnabled,
    headlessDeskService
}
