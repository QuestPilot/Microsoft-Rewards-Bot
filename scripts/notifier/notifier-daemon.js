'use strict'

// Update Notifier — tiny always-invisible background process, desktop OSes only.
// Installed at first launch (see scripts/start.js), runs at OS login, stays in the
// install directory (removed if the folder is deleted — never copies itself
// elsewhere), and periodically checks for bot updates + reminds idle users the bot
// is installed. Never runs on headless Linux or Docker (see start.js's GUI check) —
// there is nowhere for a native notification to appear there.
//
// Disabled via config.updateNotifier.enabled: false (checked every tick, self-exits;
// also uninstalled + killed by scripts/start.js on the next launch).

const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const notifier = require('node-notifier')

const ROOT = path.resolve(__dirname, '..', '..')
const { createRuntimeLaunchers } = require('../launchers/runtime-launchers')

const launchers = createRuntimeLaunchers({ root: ROOT })

// Read-only mirror of scripts/desk/config.js's readConfigRaw (dist preferred, else
// src) — the daemon only ever needs to READ the enabled flag, never write, so it
// doesn't need that module's write-path (which lives inline in app-window.js).
function readConfigRaw() {
    const distPath = path.join(ROOT, 'dist', 'config.json')
    const srcPath = path.join(ROOT, 'src', 'config.json')
    const file = fs.existsSync(distPath) ? distPath : srcPath
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return {}
    }
}

const STATE_DIR = path.join(ROOT, 'data', 'notifier')
const STATE_FILE = path.join(STATE_DIR, 'notifier.json')
const CHECK_INTERVAL_MS = 15 * 60 * 1000
// Two-tier idle reminder: a soft, low-key nudge first, then the real "come back"
// push if they still haven't returned by the main threshold.
const SOFT_REMINDER_IDLE_DAYS = 5
const REMINDER_IDLE_DAYS = 10
// Requested display duration for the notification. Only actually controllable on
// Linux (notify-send's -t/expire-time, in seconds — node-notifier converts this to
// milliseconds). Windows Toast and macOS Notification Center durations are governed
// by the OS itself (no per-app "show for exactly N seconds" API); this option is
// harmlessly ignored there rather than pretending to control something we can't.
const NOTIFICATION_TIMEOUT_SECONDS = 10

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    } catch {
        return {}
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true })
        const tmp = `${STATE_FILE}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        fs.renameSync(tmp, STATE_FILE)
    } catch {
        // Best-effort — a lost tick is harmless, it just re-checks next time.
    }
}

function isProcessAlive(pid) {
    if (!pid) return false
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// Refuse to start a second instance (e.g. a stale autostart entry plus a manual
// relaunch). Whichever one is already running keeps going; this one exits quietly.
function claimSingleInstance() {
    const existing = readState()
    if (existing.pid && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        return false
    }
    writeState({ ...existing, pid: process.pid, startedAt: new Date().toISOString() })
    return true
}

function notifierEnabled() {
    const cfg = readConfigRaw()
    return !cfg.updateNotifier || cfg.updateNotifier.enabled !== false
}

function openDesk() {
    try {
        const launcherPath = launchers.ensureDeskLauncher()
        const command = os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh'
        const args = os.platform() === 'win32' ? ['/c', launcherPath] : [launcherPath]
        childProcess.spawn(command, args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch {
        // If this fails the user still has their normal shortcut — never crash the daemon over it.
    }
}

function notify(title, message) {
    try {
        notifier.notify({ title, message, sound: false, wait: false, timeout: NOTIFICATION_TIMEOUT_SECONDS })
    } catch {
        // A platform without a working notification backend must never crash the loop.
    }
}

// Fires on ANY notification this process raised — both kinds (update available,
// come-back reminder) do the same thing on click: open the Desk. Not every OS/desktop
// environment reports clicks (e.g. some Linux notification daemons ignore actions);
// this is simply a no-op there, not an error.
notifier.on('click', () => openDesk())

async function checkForUpdate(state) {
    let UpdateManager
    try {
        ;({ UpdateManager } = require('../updater/UpdateManager'))
    } catch {
        return
    }

    let result
    try {
        result = await new UpdateManager({ root: ROOT }).run({ dryRun: true })
    } catch {
        return
    }

    if (result?.status !== 'update-available' || result.docker) return
    const version = result.remote?.version
    if (!version || version === state.lastNotifiedVersion) return

    notify('Microsoft Rewards Bot update available', `Version ${version} is ready. Click to open Rewards Desk and update.`)
    state.lastNotifiedVersion = version
    writeState(state)
}

// Two-tier reminder: a soft, low-key nudge first, then the real "come back" push
// later if they still haven't returned. Both are tracked per idle STRETCH (reset
// the moment a fresh run is detected) rather than a rolling cooldown, so neither
// can double-fire while the user stays idle, and both are free to fire again next
// time they go quiet.
function checkIdleReminder(state) {
    let lastRunAt = null
    try {
        const globalStats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stats', 'global.json'), 'utf8'))
        lastRunAt = globalStats?.lastRunAt ? Date.parse(globalStats.lastRunAt) : null
    } catch {
        return // No run history yet — nothing to remind about.
    }
    if (!lastRunAt || Number.isNaN(lastRunAt)) return

    // A fresh run since the last tick means they're back — clear both flags so the
    // next idle stretch starts clean.
    const lastRunAtIso = new Date(lastRunAt).toISOString()
    if (state.lastRunAtSeen !== lastRunAtIso) {
        state.lastRunAtSeen = lastRunAtIso
        state.softReminderSentForRun = false
        state.mainReminderSentForRun = false
        writeState(state)
    }

    const now = Date.now()
    const idleDays = (now - lastRunAt) / (24 * 60 * 60 * 1000)

    if (idleDays >= SOFT_REMINDER_IDLE_DAYS && !state.softReminderSentForRun) {
        notify('Microsoft Rewards Bot', "Haven't run in a few days — no rush, just a heads-up your points are waiting.")
        state.softReminderSentForRun = true
        writeState(state)
    }

    if (idleDays >= REMINDER_IDLE_DAYS && !state.mainReminderSentForRun) {
        notify('Microsoft Rewards Bot', "It's been a while — click to open Rewards Desk and collect today's points.")
        state.mainReminderSentForRun = true
        writeState(state)
    }
}

async function tick() {
    if (!notifierEnabled()) {
        shutdown(0)
        return
    }
    const state = readState()
    await checkForUpdate(state)
    checkIdleReminder(state)
}

let intervalHandle = null

function shutdown(code) {
    if (intervalHandle) clearInterval(intervalHandle)
    try {
        const state = readState()
        if (state.pid === process.pid) fs.rmSync(STATE_FILE, { force: true })
    } catch {
        // best-effort
    }
    process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function main() {
    if (!notifierEnabled()) return
    if (!claimSingleInstance()) return

    // The notifier is the one launcher that survives a scripts/runtime wipe (its own
    // start-notifier.* is what keeps this process coming back at login). So it is also
    // the only entry point that can repair a broken install where the Desk launcher
    // was removed — regenerate start-desk.* here so the dead desktop shortcut works
    // again at the next login, without waiting for the user to click a notification.
    try {
        launchers.ensureDeskLauncher()
    } catch {
        // Best-effort: openDesk() also re-ensures it on click as a fallback.
    }

    await tick()
    intervalHandle = setInterval(() => {
        tick().catch(() => undefined)
    }, CHECK_INTERVAL_MS)
}

main().catch(() => shutdown(1))
