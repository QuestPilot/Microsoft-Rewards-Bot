'use strict'

// Rewards Desk — browser launcher (extracted from app-window.js). Opens the Desk UI
// in a dedicated bundled-Chromium "app" window (falling back to the default browser),
// managing a unique per-process profile dir to avoid stale SingletonLock issues.
// childProcess/fs/os/path are used directly; the window size and the Desk's pushLog
// are injected. Behavior is identical to the original inline implementation. (Not
// exercised by tests — the harness sets MSRB_APP_NO_OPEN=1 — so moved verbatim.)

const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

function createBrowserLauncher({ windowWidth, windowHeight, pushLog }) {
    // Remove leftover per-process desk profiles from previous/crashed sessions so
    // tmp does not accumulate them. CRITICAL: only delete profiles that are clearly
    // STALE (not touched in the last hour). A profile in use by a concurrent or
    // still-open desk has a fresh mtime and is left untouched — otherwise a second
    // launch (which users do habitually) would yank the first window's profile out
    // from under it and no window would ever appear.
    function cleanupStaleAppProfiles(currentDir) {
        try {
            const base = path.dirname(currentDir)
            const current = path.basename(currentDir)
            const staleBefore = Date.now() - 60 * 60 * 1000 // 1 hour
            for (const name of fs.readdirSync(base)) {
                if (name === current || !name.startsWith('microsoft-rewards-bot-app')) continue
                const full = path.join(base, name)
                try {
                    if (fs.statSync(full).mtimeMs > staleBefore) continue // active/recent — leave alone
                    fs.rmSync(full, { recursive: true, force: true })
                } catch {
                    // dir in use or already gone — skip
                }
            }
        } catch {
            // ignore
        }
    }

    function prepareBrowserProfile(profileDir) {
        try {
            fs.mkdirSync(profileDir, { recursive: true })
        } catch {
            // ignore
        }
        try {
            for (const entry of fs.readdirSync(profileDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    fs.rmSync(path.join(profileDir, entry.name), { force: true })
                }
            }
        } catch {
            // Best-effort — never block the launch on a cleanup error.
        }
    }

    function openAppWindow(url, options = {}) {
        // A separate Desk-style window (e.g. the developer portal at bot.lgtw.tf) must
        // use a DISTINCT profile dir, otherwise it shares the Desk's per-pid dir and a
        // Chrome SingletonLock prevents the second window from ever opening.
        const suffix = options && options.profileSuffix
            ? '-' + String(options.profileSuffix).replace(/[^a-z0-9-]/gi, '').slice(0, 24)
            : ''
        const browser = resolveAppBrowser()
        if (!browser) {
            // No Chromium-based browser available at all — last-resort only.
            pushLog('warn', 'Desk window: bundled Chromium unavailable, opening in the default browser.')
            openDefaultBrowser(url)
            return
        }

        // Diagnostic so the desk console shows exactly which browser is used —
        // confirms it's our bundled Chromium and not a system Edge/Chrome.
        pushLog('info', `Desk window: launching ${path.basename(browser.command)} (${browser.command})`)

        // Use a profile dir that is UNIQUE to this desk process. A shared fixed dir
        // could still carry a stale Chrome "SingletonLock" from a previous/crashed
        // session, and Chrome would then exit WITHOUT opening a window — forcing the
        // user to launch the shortcut twice. A per-process dir can never have a stale
        // lock, so the very FIRST launch always opens. We clean up leftover sibling
        // profiles best-effort so tmp does not grow unbounded.
        const profileDir = path.join(os.tmpdir(), `microsoft-rewards-bot-app-${process.pid}${suffix}`)
        cleanupStaleAppProfiles(profileDir)

        // Then launch ONCE — on Windows the launcher process returns immediately while
        // the real browser runs detached, so we must NOT treat a fast exit as a
        // failure (doing so previously caused duplicate windows + the default browser
        // opening too).
        prepareBrowserProfile(profileDir)
        childProcess
            .spawn(
                browser.command,
                [
                    ...browser.args,
                    `--app=${url}`,
                    // Disable the Chromium sandbox, exactly like the bot's own
                    // BrowserManager does. The bundled Chromium lives under
                    // %LOCALAPPDATA%\ms-playwright; with the sandbox ON, the helper
                    // process fails with "Sandbox cannot access executable …
                    // Access is denied (0x5)", the network/renderer service crashes,
                    // and the app window never paints — so the Desk shows the CMD
                    // window but no page (and a relaunch only sometimes worked).
                    // Patchright/Playwright launch with the sandbox off by default;
                    // this manual spawn must pass the flag itself.
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    `--window-size=${windowWidth},${windowHeight}`,
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-extensions',
                    '--disable-sync',
                    '--disable-default-apps',
                    '--disable-background-networking',
                    '--metrics-recording-only',
                    // Suppress the "Chrome for Testing — only for automated testing"
                    // infobar. The reliable flag is --disable-infobars: Chrome for
                    // Testing builds re-purpose it specifically to hide THIS banner
                    // (it is NOT the no-op it became on stable Chrome ≥109). This is
                    // exactly what Patchright/Playwright passes by default to kill the
                    // banner — but the desk window is spawned manually, so it does not
                    // inherit those defaults and must pass the flag itself. We keep
                    // --test-type as a belt-and-suspenders fallback.
                    '--disable-infobars',
                    '--test-type=webdriver',
                    `--user-data-dir=${profileDir}`,
                    process.platform === 'linux' ? '--class=RewardsBot' : ''
                ].filter(Boolean),
                {
                    detached: true,
                    stdio: 'ignore',
                    // Do NOT set windowsHide: true here. windowsHide maps to SW_HIDE
                    // in the STARTUPINFO passed to CreateProcess, which tells the child
                    // to hide its first window. For a GUI app like Chromium this can
                    // cause the app window to be created but never made visible. The
                    // flag is appropriate for console helper processes (Node, etc.) but
                    // must NOT be used when we want an actual window on screen.
                    windowsHide: false
                }
            )
            .unref()
    }

    function resolveAppBrowser() {
        // Escape hatch for power users / debugging only.
        if (process.env.MSRB_APP_BROWSER) return { command: process.env.MSRB_APP_BROWSER, args: [] }

        // ALWAYS use the Chromium we install via npm (Patchright). One identical
        // browser for every user and every OS → consistent behaviour, fewer
        // environment-specific bugs, and we never touch the user's system browsers
        // (no Edge, no Firefox, no Chrome). start.js guarantees it is installed via
        // ensurePatchrightChromium() before the desk window is opened.
        return resolveBundledChromium()
    }

    function resolveBundledChromium() {
        try {
            const { chromium } = require('patchright')
            const executablePath = chromium.executablePath()
            if (executablePath && fs.existsSync(executablePath)) return { command: executablePath, args: [] }
        } catch {
            return null
        }
        return null
    }

    // eslint-disable-next-line no-unused-vars
    function commandExists(command) {
        const checker = process.platform === 'win32' ? 'where' : 'which'
        return childProcess.spawnSync(checker, [command], { stdio: 'ignore' }).status === 0
    }

    function openDefaultBrowser(url) {
        const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
        childProcess.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }

    return { openAppWindow }
}

module.exports = { createBrowserLauncher }
