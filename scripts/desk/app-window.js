const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { createAccountStorage } = require('../account-storage')
const { createDesktopInstallManager } = require('../launchers/desktop-install-manager')
const { createStartupManager } = require('../launchers/startup-manager')

const ROOT = path.resolve(__dirname, '..', '..')
// Desk server coordinates, finalized at listen() time (see startDeskServer below).
let deskBoundPort = null
let deskLanEnabled = false
let deskLanIp = null
let deskLanUrl = null
// Origins allowed to embed/probe this local Desk from an HTTPS page (the remote
// Nexus dashboard). Browsers gate public→loopback/LAN requests behind CORS +
// Private Network Access; we opt in for the pinned Nexus origin only.
const DESK_EMBED_ORIGINS = new Set(
    ['https://bot.lgtw.tf'].concat(process.env.MSRB_DESK_EMBED_ORIGIN ? [process.env.MSRB_DESK_EMBED_ORIGIN] : [])
)
// Where the Desk announces its presence so the remote dashboard can discover it on the
// same network (same default as the bot's DashboardClient).
const DASHBOARD_URL = (process.env.MSRB_DASHBOARD_URL || 'https://bot.lgtw.tf').replace(/\/+$/, '')
let deskPresenceAnnounced = false
const APP_TITLE = 'Rewards Desk'
const APP_ICON_PATH = path.join(ROOT, 'assets', 'logo.ico')
const APP_BANNER_PATH = path.join(ROOT, 'assets', 'banner-core.png')
const APP_WINDOW_WIDTH = 1780
const APP_WINDOW_HEIGHT = 1020
const API_TOKEN = crypto.randomBytes(32).toString('base64url')
const MAX_API_BODY_BYTES = 64 * 1024
// Emitted by the bot's scheduler loop when it applies an update while running
// under Desk supervision instead of self-detaching (see checkForUpdateAndRestart
// in src/index.ts). Keep this value in sync with SUPERVISED_UPDATE_EXIT_CODE there.
const UPDATE_RESTART_EXIT_CODE = 75
const accountStorage = createAccountStorage({ root: ROOT })
const desktopInstallManager = createDesktopInstallManager({ root: ROOT })
const startupManager = createStartupManager({ root: ROOT })
let agentApi = null
try {
    agentApi = require('../../dist/core/AgentRuntime')
} catch {}
let schedulerLib = null
try {
    schedulerLib = require('../../dist/core/Scheduler')
} catch {}

function computeSchedulerNextRunAt(scheduler) {
    if (!schedulerLib || !scheduler || !scheduler.enabled || !scheduler.startTime) return null
    try {
        return schedulerLib.getNextScheduledRun(scheduler).target.toISOString()
    } catch {
        return null
    }
}

function readVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
    } catch {
        return '4.0.x'
    }
}

// The address other devices on the home network use to reach the Desk when LAN
// access is on. Naively taking the first non-internal IPv4 is wrong: it can land on
// an APIPA link-local (169.254.x.x — not routable) or a virtual adapter (VMware/WSL/
// Hyper-V). Prefer a real RFC1918 private LAN address and de-prioritise virtual NICs.
function getLanIPv4() {
    try {
        const ifaces = os.networkInterfaces()
        const candidates = []
        for (const name of Object.keys(ifaces)) {
            for (const ni of ifaces[name] || []) {
                if (!ni || ni.family !== 'IPv4' || ni.internal || !ni.address) continue
                if (ni.address.startsWith('169.254.')) continue // APIPA — no DHCP lease, not on the LAN
                candidates.push({ name, address: ni.address })
            }
        }
        if (!candidates.length) return null
        const isPrivate = a => a.startsWith('192.168.') || a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
        const isVirtual = n => /(vmware|virtualbox|vethernet|hyper-v|wsl|docker|default switch|loopback)/i.test(n)
        candidates.sort((x, y) => {
            const score = c => (isPrivate(c.address) ? 2 : 0) - (isVirtual(c.name) ? 1 : 0)
            return score(y) - score(x)
        })
        return candidates[0].address
    } catch {}
    return null
}

// Announce this Desk (loopback port + optional LAN URL) to the remote dashboard so it
// can be discovered + embedded when you visit Nexus from the same home network. The
// server keys it by the public IP, so it's only ever offered to the same household.
// Discovery/embed is a Core feature → only premium Desks announce (open-source never
// phones home here).
function reportDeskPresence() {
    // Announce when discoverable: either Core (for the Nexus same-machine embed) or LAN
    // access opted in (free phone access on the same Wi-Fi via the routing page). The
    // server keys it by public IP, so it's only ever offered to the same household.
    if ((state.deskLicense.tier !== 'premium' && !deskLanEnabled) || !deskBoundPort) return
    try {
        const u = new URL(DASHBOARD_URL + '/api/desk/presence')
        const transport = u.protocol === 'http:' ? require('http') : require('https')
        const payload = JSON.stringify({ port: deskBoundPort, lanUrl: deskLanUrl })
        const req = transport.request(
            {
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                timeout: 8000
            },
            resp => {
                resp.on('data', () => {})
                resp.on('end', () => {})
            }
        )
        req.on('error', () => {})
        req.on('timeout', () => req.destroy())
        req.end(payload)
        if (!deskPresenceAnnounced) {
            deskPresenceAnnounced = true
            pushLog('info', 'Desk announced to Nexus for same-network discovery.')
        }
    } catch {}
}

// Remote access (off-network control from Nexus). The Desk keeps a background "agent"
// (a bot process that connects to Nexus via the Core plugin and sits idle awaiting
// run/stop) alive while it's open; closing the Desk stops it (owner's model: Desk
// open = remote on). Premium only. Reuses the existing agent IPC: startBot() already
// routes a Run through an active agent (requestAgentRun), so no double process.
async function startAgentProcess() {
    if (state.deskLicense.tier !== 'premium' || !agentApi) return
    try {
        const status = await agentApi.getAgentStatus().catch(() => ({ active: false }))
        if (status.active) return // already connected
    } catch {}
    try {
        // Spawn the agent the SAME way the Desk spawns a Run — dist/index.js directly with
        // windowsHide — NOT via start.js (whose run() re-spawns the bot WITHOUT windowsHide,
        // which is what popped a visible CMD). detached:false on Windows = no new console;
        // POSIX detached = a proper background session. Either way it's stopped explicitly.
        childProcess
            .spawn(process.execPath, [path.join('dist', 'index.js'), '--background'], {
                cwd: ROOT,
                detached: process.platform !== 'win32',
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, MSRB_TERMINAL_MODE: '0' }
            })
            .unref()
        pushLog('info', 'Remote access: connecting to Nexus in the background…')
    } catch (error) {
        pushLog('warn', `Could not start remote access: ${error && error.message ? error.message : error}`)
    }
}

// Cross-platform process-tree kill (Windows taskkill /T, POSIX process group then pid).
function killPidTree(pid) {
    if (!pid) return
    try {
        if (process.platform === 'win32') {
            childProcess.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
            try {
                process.kill(-pid, 'SIGKILL')
            } catch {
                try {
                    process.kill(pid, 'SIGKILL')
                } catch {}
            }
        }
    } catch {}
}

// Graceful agent stop (IPC shutdown) with a force-kill fallback — the graceful path
// alone proved unreliable (the agent kept running), so we make sure it actually dies.
async function stopAgentProcess() {
    if (!agentApi) return
    let pid = null
    try {
        const status = await agentApi.getAgentStatus().catch(() => ({ active: false }))
        if (!status.active) return
        pid = status.pid || null
    } catch {}
    try {
        await agentApi.stopExistingAgent()
    } catch {}
    try {
        const after = await agentApi.getAgentStatus().catch(() => ({ active: false }))
        if (after.active) killPidTree(after.pid || pid)
    } catch {
        if (pid) killPidTree(pid)
    }
}

// Fast, synchronous force-kill for shutdown (the Desk is exiting — no time for the IPC
// dance). Reads the agent rendezvous file for the pid and kills the tree.
function quickKillAgent() {
    if (!agentApi) return
    try {
        const statePath = agentApi.agentStatePath()
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        if (parsed && parsed.pid) killPidTree(parsed.pid)
        fs.rmSync(statePath, { force: true })
    } catch {}
}

function remoteAccessEnabled() {
    try {
        const cfg = readConfigRaw()
        return !!(cfg && cfg.core && cfg.core.dashboardSync === true)
    } catch {
        return false
    }
}
const APP_VERSION = readVersion()

// Reads the bot's locally-recorded stats (written by StatsRecorder to data/stats/)
// so the Desk can show REAL collected numbers instead of estimates. All best-effort:
// missing files just yield zeros + hasData:false.
function readBotStats() {
    const statsDir = path.join(ROOT, 'data', 'stats')
    const out = {
        hasData: false,
        totalPoints: 0,
        totalRuns: 0,
        totalAccountRuns: 0,
        successfulAccountRuns: 0,
        successRate: null,
        claimedPoints: 0,
        couponsApplied: 0,
        couponPointsSaved: 0,
        last7Points: 0,
        last30Points: 0,
        firstRunAt: null,
        lastRunAt: null,
        accountsTracked: 0
    }
    try {
        const g = JSON.parse(fs.readFileSync(path.join(statsDir, 'global.json'), 'utf8'))
        out.hasData = true
        out.totalPoints = g.totalPointsCollected || 0
        out.totalRuns = g.totalRuns || 0
        out.totalAccountRuns = g.totalAccountRuns || 0
        out.successfulAccountRuns = g.totalSuccessfulAccountRuns || 0
        out.successRate =
            out.totalAccountRuns > 0 ? Math.round((out.successfulAccountRuns / out.totalAccountRuns) * 100) : null
        out.claimedPoints = g.totalClaimedPoints || 0
        out.couponsApplied = g.totalCouponsApplied || 0
        out.couponPointsSaved = g.totalCouponPointsSaved || 0
        out.firstRunAt = g.firstRunAt || null
        out.lastRunAt = g.lastRunAt || null
    } catch {
        /* no global stats yet */
    }
    try {
        const dailyDir = path.join(statsDir, 'daily')
        const now = Date.now()
        for (const f of fs.readdirSync(dailyDir)) {
            if (!f.endsWith('.json')) continue
            const t = Date.parse(f.slice(0, -5))
            if (Number.isNaN(t)) continue
            const ageDays = (now - t) / 86400000
            let pts = 0
            try {
                pts = JSON.parse(fs.readFileSync(path.join(dailyDir, f), 'utf8')).totalPointsCollected || 0
            } catch {}
            if (ageDays <= 7) out.last7Points += pts
            if (ageDays <= 30) out.last30Points += pts
        }
    } catch {
        /* no daily stats yet */
    }
    try {
        out.accountsTracked = fs.readdirSync(path.join(statsDir, 'accounts')).filter(f => f.endsWith('.json')).length
    } catch {
        /* no per-account stats yet */
    }
    return out
}

// Insights: read data/stats into chart series + per-account summaries + LOCAL-rule
// recommendations (nothing leaves the machine). Charts are free; the page gates the
// recommendations behind Core (see the client). Masked emails only — never real ones.
function buildInsights() {
    const statsDir = path.join(ROOT, 'data', 'stats')
    const base = readBotStats()
    const out = {
        hasData: base.hasData,
        totals: {
            points: base.totalPoints,
            runs: base.totalRuns,
            accountRuns: base.totalAccountRuns,
            successRate: base.successRate,
            claimedPoints: base.claimedPoints,
            couponsApplied: base.couponsApplied,
            accountsTracked: base.accountsTracked,
            last7Points: base.last7Points,
            last30Points: base.last30Points,
            lastRunAt: base.lastRunAt
        },
        daily: [],
        accounts: [],
        recommendations: []
    }
    try {
        const dailyDir = path.join(statsDir, 'daily')
        const rows = []
        for (const f of fs.readdirSync(dailyDir)) {
            if (!f.endsWith('.json')) continue
            const date = f.slice(0, -5)
            if (Number.isNaN(Date.parse(date))) continue
            let d = {}
            try {
                d = JSON.parse(fs.readFileSync(path.join(dailyDir, f), 'utf8'))
            } catch {}
            const ar = d.accountRuns || 0
            rows.push({
                date,
                points: d.totalPointsCollected || 0,
                runs: d.runs || 0,
                successRate: ar > 0 ? Math.round(((d.successfulAccountRuns || 0) / ar) * 100) : null
            })
        }
        rows.sort((a, b) => (a.date < b.date ? -1 : 1))
        out.daily = rows.slice(-30)
    } catch {
        /* no daily stats */
    }
    try {
        const accDir = path.join(statsDir, 'accounts')
        for (const f of fs.readdirSync(accDir)) {
            if (!f.endsWith('.json')) continue
            let a = {}
            try {
                a = JSON.parse(fs.readFileSync(path.join(accDir, f), 'utf8'))
            } catch {}
            const totalRuns = a.totalRuns || 0
            const hist = Array.isArray(a.history) ? a.history : []
            const recent = hist.slice(-3)
            const lastErr = [...hist].reverse().find(h => h && h.error)
            let status = 'ok'
            if (recent.length >= 2 && recent.every(h => h && h.success === false)) status = 'failing'
            else if (totalRuns > 0 && (a.lastKnownPoints || 0) === 0 && (a.totalPointsCollected || 0) === 0)
                status = 'idle'
            out.accounts.push({
                name: a.maskedEmail || a.emailKey || 'account',
                points: a.totalPointsCollected || 0,
                lastKnownPoints: a.lastKnownPoints || 0,
                runs: totalRuns,
                successRate: totalRuns > 0 ? Math.round(((a.totalSuccessfulRuns || 0) / totalRuns) * 100) : null,
                lastSeenAt: a.lastSeenAt || null,
                status,
                signedOut: !!(lastErr && /sign|enrol|onboard|authenticat|session/i.test(String(lastErr.error)))
            })
        }
    } catch {
        /* no per-account stats */
    }
    out.accounts.sort((a, b) => b.points - a.points || b.lastKnownPoints - a.lastKnownPoints)
    out.recommendations = computeRecommendations(out)
    return out
}

function computeRecommendations(ins) {
    const recs = []
    const accts = ins.accounts || []
    const signedOut = accts.filter(a => a.signedOut)
    const signedOutNames = new Set(signedOut.map(a => a.name))
    if (signedOut.length) {
        recs.push({
            severity: 'high',
            title: signedOut.length + ' account' + (signedOut.length > 1 ? 's look' : ' looks') + ' signed out',
            detail:
                'They earn nothing until you re-login or finish Microsoft Rewards enrollment: ' +
                signedOut
                    .slice(0, 6)
                    .map(a => a.name)
                    .join(', ') +
                (signedOut.length > 6 ? '…' : '') +
                '.'
        })
    }
    const failing = accts.filter(a => a.status === 'failing' && !signedOutNames.has(a.name))
    if (failing.length) {
        recs.push({
            severity: 'high',
            title: failing.length + ' account' + (failing.length > 1 ? 's keep' : ' keeps') + ' failing',
            detail:
                'Check the login or proxy for: ' +
                failing
                    .slice(0, 6)
                    .map(a => a.name)
                    .join(', ') +
                '.'
        })
    }
    const zero = accts.filter(a => a.runs > 0 && a.points === 0 && a.status === 'ok' && !signedOutNames.has(a.name))
    if (zero.length) {
        recs.push({
            severity: 'medium',
            title: zero.length + ' account' + (zero.length > 1 ? 's' : '') + ' collected 0 points',
            detail: 'They run but earn nothing — make sure searches and the daily set are enabled, and the accounts are enrolled.'
        })
    }
    if (ins.totals.successRate != null && ins.totals.successRate < 70 && ins.totals.accountRuns >= 3) {
        recs.push({
            severity: 'medium',
            title: 'Success rate is ' + ins.totals.successRate + '%',
            detail: 'Several account runs fail. Fixing the accounts above should raise it.'
        })
    }
    if (ins.totals.lastRunAt) {
        const days = Math.floor((Date.now() - Date.parse(ins.totals.lastRunAt)) / 86400000)
        if (days >= 2)
            recs.push({
                severity: 'low',
                title: 'No run in ' + days + ' days',
                detail: 'Turn on the scheduler (Settings) and start a run once — it then repeats automatically every day as long as the bot keeps running.'
            })
    }
    if (!recs.length) {
        const top = accts.find(a => a.points > 0)
        recs.push(
            top
                ? {
                      severity: 'low',
                      title: 'Everything looks healthy',
                      detail:
                          'Top account ' +
                          top.name +
                          ' collected ' +
                          top.points.toLocaleString() +
                          ' points. Keep it running daily to maximise earnings.'
                  }
                : {
                      severity: 'low',
                      title: 'Not enough data yet',
                      detail: 'Run the bot a few more times to unlock deeper recommendations.'
                  }
        )
    }
    return recs
}

// Returns a map of maskedEmail → totalPointsCollected for the Home account list badges.
function readAllAccountStats() {
    const dir = path.join(ROOT, 'data', 'stats', 'accounts')
    const out = {}
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            try {
                const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
                if (d.maskedEmail) out[d.maskedEmail] = d.totalPointsCollected || 0
            } catch {}
        }
    } catch {}
    return out
}
let _accPtsCache = null
let _accPtsCacheAt = 0
function cachedAccountPointsMap() {
    const now = Date.now()
    if (!_accPtsCache || now - _accPtsCacheAt > 30000) {
        _accPtsCache = readAllAccountStats()
        _accPtsCacheAt = now
    }
    return _accPtsCache
}

// Returns the masked account list enriched with an `avatarId` (the 16-char hash
// of the real email) so the Home page can load the right avatar file without
// ever seeing the real address. Aligned by index with accountCache — both come
// from the same worker result, so masked[i] always matches the raw account[i].
function accountsWithAvatarId() {
    const masked = Array.isArray(state.accounts) ? state.accounts : []
    const raw = Array.isArray(accountCache) ? accountCache : []
    if (!raw.length) return masked
    const crypto = require('crypto')
    return masked.map((m, i) => {
        const r = raw[i]
        if (!r || !r.email) return m
        const avatarId = crypto
            .createHash('sha256')
            .update(String(r.email).toLowerCase().trim())
            .digest('hex')
            .slice(0, 16)
        return { ...m, avatarId }
    })
}

// ─── Desk UI State (replaces multiple .desk-*.json files) ──────────────
const DATA_STORE = path.join(ROOT, 'data', 'desk-state.json')
const STAR_GITHUB = 'https://github.com/QuestPilot/Microsoft-Rewards-Bot'
const STAR_MAX_SHOWS = 2

function readStarState() {
    try {
        return JSON.parse(fs.readFileSync(DATA_STORE, 'utf8')).star || {}
    } catch {
        return {}
    }
}
function saveStarState(obj) {
    try {
        const dataDir = path.dirname(DATA_STORE)
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
        let data = {}
        try {
            data = JSON.parse(fs.readFileSync(DATA_STORE, 'utf8'))
        } catch {}
        data.star = obj
        fs.writeFileSync(DATA_STORE, JSON.stringify(data, null, 2), 'utf8')
    } catch {}
}
// ─────────────────────────────────────────────────────────────────────────────

const state = {
    status: 'Preparing',
    detail: 'Rewards Desk is loading local services',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    isRunning: false,
    agentConnected: false,
    accounts: [],
    activeAccount: null,
    logs: [],
    consoleLogs: [],
    hasLicenseCache: false,
    deskLicense: {
        tier: 'free',
        planType: '',
        expiresAt: null,
        clientReady: false,
        loading: true
    },
    boot: {
        accountsReady: false,
        licenseReady: false
    },
    licensePrompt: {
        visible: false,
        status: 'idle',
        message: 'Core is optional. Enter a license key or continue without it.'
    },
    metrics: {
        core: 'Checking',
        points: null,
        coupons: null,
        progress: 0
    }
}

let botProcess = null
let shutdownTimer = null
let stopRequested = false
let shuttingDown = false
let closeAgentLogSubscription = null
let accountWorker = null
let accountWorkerReady = null
let accountWorkerSequence = 0
const accountWorkerPending = new Map()
let accountCache = null

function runCoreLicenseWorker(payload) {
    return runJsonWorker('core-license-worker.js', payload)
}

function startAccountStorageWorker() {
    if (accountWorkerReady) return accountWorkerReady
    accountWorkerReady = new Promise((resolve, reject) => {
        accountWorker = childProcess.spawn(
            process.execPath,
            [path.join(__dirname, '..', 'account-storage-worker.js')],
            {
                cwd: ROOT,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            }
        )
        let stdout = ''
        let stderr = ''
        const timeout = setTimeout(() => reject(new Error('Account storage initialization timed out')), 45_000)

        accountWorker.stdout.setEncoding('utf8')
        accountWorker.stderr.setEncoding('utf8')
        accountWorker.stderr.on('data', chunk => {
            if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length)
        })
        accountWorker.stdout.on('data', chunk => {
            stdout += chunk
            let newline
            while ((newline = stdout.indexOf('\n')) !== -1) {
                const line = stdout.slice(0, newline)
                stdout = stdout.slice(newline + 1)
                if (!line.trim()) continue
                try {
                    const message = JSON.parse(line)
                    if (message.type === 'ready') {
                        clearTimeout(timeout)
                        if (message.success) resolve(message)
                        else reject(new Error(message.message || 'Account storage initialization failed'))
                        continue
                    }
                    const pending = accountWorkerPending.get(message.id)
                    if (!pending) continue
                    accountWorkerPending.delete(message.id)
                    clearTimeout(pending.timeout)
                    if (message.success) pending.resolve(message.result)
                    else pending.reject(new Error(message.message || 'Account storage operation failed'))
                } catch (error) {
                    pushLog('warn', `Invalid account storage response: ${error.message}`)
                }
            }
        })
        accountWorker.on('error', error => {
            clearTimeout(timeout)
            reject(error)
        })
        accountWorker.on('close', code => {
            clearTimeout(timeout)
            accountWorker = null
            accountWorkerReady = null
            const error = new Error(stderr || `Account storage worker exited with code ${code}`)
            for (const pending of accountWorkerPending.values()) {
                clearTimeout(pending.timeout)
                pending.reject(error)
            }
            accountWorkerPending.clear()
        })
    }).catch(error => {
        accountWorkerReady = null
        if (accountWorker) accountWorker.kill()
        throw error
    })
    return accountWorkerReady
}

async function accountStorageRequest(action, payload = {}) {
    await startAccountStorageWorker()
    if (!accountWorker?.stdin?.writable) throw new Error('Account storage service is unavailable')
    const id = ++accountWorkerSequence
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            accountWorkerPending.delete(id)
            reject(new Error(`Account storage ${action} timed out`))
        }, 45_000)
        accountWorkerPending.set(id, { resolve, reject, timeout })
        accountWorker.stdin.write(`${JSON.stringify({ id, action, payload })}\n`)
    })
}

function runJsonWorker(scriptName, payload) {
    return new Promise((resolve, reject) => {
        const worker = childProcess.spawn(process.execPath, [path.join(__dirname, '..', scriptName)], {
            cwd: ROOT,
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (callback, value) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            callback(value)
        }
        const timeout = setTimeout(() => {
            worker.kill()
            finish(reject, new Error(`${scriptName} timed out after 45 seconds`))
        }, 45_000)
        worker.stdout.setEncoding('utf8')
        worker.stderr.setEncoding('utf8')
        worker.stdout.on('data', chunk => {
            if (stdout.length < MAX_API_BODY_BYTES) {
                stdout += chunk.slice(0, MAX_API_BODY_BYTES - stdout.length)
            }
        })
        worker.stderr.on('data', chunk => {
            if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length)
        })
        worker.on('error', error => finish(reject, error))
        worker.on('close', code => {
            try {
                const result = JSON.parse(stdout || '{}')
                if (code && !result.message) throw new Error(stderr || `Core licensing worker exited with code ${code}`)
                finish(resolve, result)
            } catch (error) {
                finish(reject, error)
            }
        })
        worker.stdin.end(JSON.stringify(payload || {}))
    })
}

function maskEmail(email) {
    const [name, domain] = String(email).split('@')
    if (!domain) return email
    const visible = name.length <= 2 ? name : `${name.slice(0, 2)}${'*'.repeat(Math.min(5, name.length - 2))}`
    return `${visible}@${domain}`
}

// Strips a leading CLI-spinner frame so consecutive frames of the same animated
// line can be detected and collapsed. Restricted to unambiguous spinner glyphs —
// braille dots (ora's default), circle quadrants and block bars — so it never
// eats a real "- bullet" / "| pipe" / "/ path" line.
function stripSpinnerFrame(s) {
    return String(s).replace(/^[⠀-⣿▁-█◐-◓◴-◷]+[ \t]+/, '')
}

function pushLog(level, message) {
    const clean = String(message || '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .trim()
    if (!clean) return

    updateStateFromLine(clean)

    const now = new Date().toISOString()
    const stripped = stripSpinnerFrame(clean)
    const isSpinnerFrame = stripped !== clean && stripped.length > 0

    // Collapse a run of spinner frames ("⠧ Verifying…", "⠇ Verifying…", …) into a
    // single entry that updates in place instead of flooding the console with
    // dozens of near-identical lines.
    const prevConsole = state.consoleLogs[state.consoleLogs.length - 1]
    if (isSpinnerFrame && prevConsole && prevConsole.spinner && stripSpinnerFrame(prevConsole.message) === stripped) {
        prevConsole.message = stripped
        prevConsole.at = now
    } else {
        state.consoleLogs.push({ at: now, level, message: isSpinnerFrame ? stripped : clean, spinner: isSpinnerFrame })
    }

    // The friendly log feed dedupes spinner frames the same way.
    const prevFriendly = state.logs[state.logs.length - 1]
    if (
        isSpinnerFrame &&
        prevFriendly &&
        stripSpinnerFrame(prevFriendly.message) === stripSpinnerFrame(toFriendlyLog(clean))
    ) {
        prevFriendly.message = toFriendlyLog(clean)
        prevFriendly.at = now
    } else {
        state.logs.push({ at: now, level, message: toFriendlyLog(clean) })
    }

    if (state.logs.length > 160) state.logs.splice(0, state.logs.length - 160)
    if (state.consoleLogs.length > 400) state.consoleLogs.splice(0, state.consoleLogs.length - 400)
}

function toFriendlyLog(line) {
    if (/Premium license active|Core features unlocked/i.test(line)) return 'Core license verified.'
    if (/Registered official plugin/i.test(line)) return 'Core plugin loaded.'
    if (/Starting session for/i.test(line)) return line.replace(/^.*Starting session for/i, 'Starting account')
    if (/Completed all accounts/i.test(line)) return 'Run complete.'
    if (/Applied .*coupon/i.test(line)) return line.replace(/^.*COUPONS\s*/i, '')
    if (/Claimed .*points/i.test(line)) return line.replace(/^.*CLAIM-POINTS\s*/i, '')
    if (/Search counters unavailable/i.test(line))
        return 'Microsoft dashboard counters are unavailable; using safe fallback.'
    if (/requires Core/i.test(line)) return 'A premium action needs Core.'
    return line
}

function updateStateFromLine(line) {
    if (/Registered official plugin|Premium license active|Core features unlocked/i.test(line)) {
        state.metrics.core = 'Active'
        state.detail = 'Core is active'
        state.licensePrompt.visible = false
        state.licensePrompt.status = 'valid'
        state.licensePrompt.message = 'Core license verified.'
        state.metrics.progress = Math.max(state.metrics.progress, 20)
    } else if (/Core inactive|requires Core|Background agent requires Core/i.test(line)) {
        state.metrics.core = 'Inactive'
    }

    if (/Core Plugin.*License Required|License key:/i.test(line)) {
        state.licensePrompt.visible = true
        state.licensePrompt.status = 'waiting'
        state.licensePrompt.message = 'Enter your Core license key, or continue without Core.'
    } else if (
        /Invalid license key|License server not configured|Unable to reach the license server|Try again/i.test(line)
    ) {
        state.licensePrompt.visible = true
        state.licensePrompt.status = 'invalid'
        state.licensePrompt.message = toFriendlyLog(line)
    } else if (/No license key provided|Running open-source mode|Core disabled/i.test(line)) {
        state.licensePrompt.visible = false
        state.licensePrompt.status = 'skipped'
        state.licensePrompt.message = 'Running without Core.'
    }

    const sessionMatch = line.match(/Starting session for\s+([^\s|]+)/i)
    if (sessionMatch?.[1]) {
        state.activeAccount = maskEmail(sessionMatch[1])
        state.status = 'Running'
        state.detail = 'Processing account'
        state.metrics.progress = Math.max(state.metrics.progress, 35)
    }

    const accountMatch = line.match(/Accounts processed:\s*(\d+)/i)
    if (accountMatch) {
        state.detail = `${accountMatch[1]} account(s) processed`
    }

    const pointsMatch =
        line.match(/Total points collected:\s*\+?(-?\d+)/i) || line.match(/Points collected:\s*\+?(-?\d+)/i)
    if (pointsMatch) state.metrics.points = Number(pointsMatch[1])

    const couponMatch = line.match(/(\d+)\/(\d+)\s+coupon/i)
    if (couponMatch) state.metrics.coupons = `${couponMatch[1]}/${couponMatch[2]}`

    if (/Checking dashboard coupons/i.test(line)) {
        state.detail = 'Checking coupons'
        state.metrics.progress = Math.max(state.metrics.progress, 45)
    } else if (/Checking for claimable points/i.test(line)) {
        state.detail = 'Checking claimable points'
        state.metrics.progress = Math.max(state.metrics.progress, 50)
    } else if (/SEARCH/i.test(line)) {
        state.detail = 'Running searches'
        state.metrics.progress = Math.max(state.metrics.progress, 65)
    } else if (/Run complete|Completed all accounts/i.test(line)) {
        state.status = 'Complete'
        state.detail = 'Run finished'
        state.metrics.progress = 100
    } else if (/error|failed/i.test(line)) {
        state.status = state.status === 'Complete' ? state.status : 'Attention'
        state.detail = 'A recoverable issue needs attention'
    }
}

async function startBot() {
    if (botProcess) return false
    if (agentApi) {
        const agentStatus = await agentApi.getAgentStatus().catch(() => ({ active: false }))
        if (agentStatus.active) {
            const requested = await agentApi.requestAgentRun().catch(error => ({
                accepted: false,
                reason: error.message
            }))
            if (!requested.accepted) {
                state.status = 'Attention'
                state.detail = requested.reason || 'The Core agent rejected the run'
                return false
            }
            await connectToAgentLogs()
            state.agentConnected = true
            state.isRunning = true
            state.status = 'Starting'
            state.detail = 'Run requested through the Core background agent'
            pushLog('info', 'Rewards Desk connected to the existing Core background agent.')
            return true
        }
    }
    stopRequested = false
    state.status = 'Starting'
    state.detail = 'Preparing the run'
    state.startedAt = new Date().toISOString()
    state.finishedAt = null
    state.exitCode = null
    state.isRunning = true
    state.licensePrompt.visible = false
    state.licensePrompt.status = state.hasLicenseCache ? 'checking' : 'skipped'
    state.licensePrompt.message = state.hasLicenseCache
        ? 'Checking Core license...'
        : 'Starting without a Core license.'
    state.metrics.progress = 6
    pushLog('info', 'Starting Rewards Bot run.')

    spawnBotProcess(['./dist/index.js', '--ui-child'])
    return true
}

// Spawns the given command as the tracked `botProcess`, wiring stdout/stderr into
// the Desk console and handling exit/error. Used both for the normal run (direct
// dist/index.js — fast, no update check) and for the post-update relaunch below
// (through the full launcher, so dist/ gets rebuilt from the freshly pulled source).
function spawnBotProcess(args) {
    botProcess = childProcess.spawn(process.execPath, args, {
        cwd: ROOT,
        env: {
            ...process.env,
            MSRB_UI_CHILD: '1',
            MSRB_TERMINAL_MODE: '0'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    })

    botProcess.stdout.on('data', chunk => {
        for (const line of String(chunk).split(/\r?\n/)) pushLog('info', line)
    })
    botProcess.stderr.on('data', chunk => {
        for (const line of String(chunk).split(/\r?\n/)) pushLog('warn', line)
    })
    botProcess.on('error', error => {
        botProcess = null
        state.isRunning = false
        state.activeAccount = null
        state.status = 'Attention'
        state.detail = `Could not start the bot: ${error.message}`
        pushLog('warn', state.detail)
    })
    botProcess.on('exit', code => {
        botProcess = null

        // The bot applied an update mid-schedule and handed control back to us
        // instead of self-detaching into an invisible, unmanaged process (see
        // checkForUpdateAndRestart in src/index.ts). Relaunch through the full
        // launcher (not dist/index.js directly) so dist/ gets rebuilt from the new
        // source; it then re-execs the bot, still tracked as this same botProcess.
        // Skipped if the user hit Stop in the meantime.
        if (code === UPDATE_RESTART_EXIT_CODE && !stopRequested) {
            pushLog('info', 'Update applied. Rebuilding and restarting the bot...')
            state.status = 'Starting'
            state.detail = 'Applying update...'
            spawnBotProcess([path.join('scripts', 'start.js'), '--ui-child'])
            return
        }

        state.isRunning = false
        state.activeAccount = null
        state.exitCode = code
        state.finishedAt = new Date().toISOString()
        state.status = stopRequested ? 'Stopped' : code === 0 ? 'Complete' : 'Attention'
        state.detail = stopRequested
            ? 'Stopped by user'
            : code === 0
              ? 'Run finished'
              : 'The bot stopped before completing'
        state.metrics.progress = code === 0 ? 100 : state.metrics.progress
    })
}

async function connectToAgentLogs() {
    if (!agentApi || closeAgentLogSubscription) return
    try {
        closeAgentLogSubscription = await agentApi.subscribeToAgentLogs(
            log => pushLog(log.level || 'info', log.message || ''),
            () => {
                closeAgentLogSubscription = null
                state.agentConnected = false
            }
        )
    } catch {}
}

async function refreshAgentState() {
    if (!agentApi || botProcess) return
    const agentStatus = await agentApi.getAgentStatus().catch(() => ({ active: false, runState: 'idle' }))
    state.agentConnected = Boolean(agentStatus.active)
    if (!agentStatus.active) return
    await connectToAgentLogs()
    if (agentStatus.runState === 'running') {
        state.isRunning = true
        state.status = 'Running'
        if (!state.detail || /ready|requested/i.test(state.detail)) {
            state.detail = 'Controlled by the Core background agent'
        }
    } else if (state.isRunning && !botProcess) {
        state.isRunning = false
        state.exitCode = agentStatus.lastExitCode ?? 0
        state.finishedAt = new Date().toISOString()
        state.status = state.exitCode === 0 ? 'Complete' : 'Attention'
        state.detail = state.exitCode === 0 ? 'Agent run finished' : 'Agent run stopped with an error'
        state.metrics.progress = state.exitCode === 0 ? 100 : state.metrics.progress
    }
}

async function stopBot() {
    if (!botProcess && state.agentConnected && agentApi) {
        const accepted = await agentApi.requestAgentStop().catch(() => false)
        if (accepted) {
            state.status = 'Stopping'
            state.detail = 'The Core agent will stop after the current account'
        }
        return accepted
    }
    if (!botProcess) return false
    state.status = 'Stopping'
    state.detail = 'Stopping after user request'
    stopRequested = true
    pushLog('warn', 'Stop requested from the app window.')
    botProcess.kill('SIGTERM')
    return true
}

function sendInput(value) {
    if (!botProcess?.stdin?.writable) return false
    botProcess.stdin.write(`${value || ''}\n`)
    return true
}

// Config read/patch helpers extracted to ./desk/config.js (behavior identical).
const { createConfig } = require('./config')
const { readConfigRaw, writeConfigPatch } = createConfig({ root: ROOT, atomicWriteText })

// Desk-side anonymous telemetry (same relay, same instance id, same opt-out as the
// bot's AnalyticsService). Emits `feature_toggled` on settings changes and
// `desk_session_ended` on shutdown.
const { createDeskAnalytics } = require('./analytics')
const deskAnalytics = createDeskAnalytics({ root: ROOT, readConfigRaw, version: readVersion() })

// ── Auto-detected dashboard variant (cosmetic badge hint) ────────────────────
// The bot writes sessions/<email>/dashboard-variant.json after detecting which
// Microsoft dashboard (legacy ASP vs new Next.js) each account was served. We read
// it here purely to badge 'auto' accounts in the editor. It is a transient hint,
// never persisted back into the account store (see /api/accounts-save).
function readDetectedVariant(email) {
    try {
        if (!email) return null
        var cfg = readConfigRaw()
        var sessionPath = cfg && cfg.sessionPath ? cfg.sessionPath : 'sessions'
        var file = path.join(ROOT, sessionPath, email, 'dashboard-variant.json')
        if (!fs.existsSync(file)) return null
        var data = JSON.parse(fs.readFileSync(file, 'utf8'))
        // Prefer desktop (its served dashboard rarely differs from mobile); fall back.
        var v = (data && (data.desktop || data.mobile)) || null
        return v === 'next' || v === 'legacy' ? v : null
    } catch (e) {
        return null
    }
}

function enrichAccountsWithVariant(accounts) {
    if (!Array.isArray(accounts)) return accounts
    return accounts.map(function (a) {
        if (!a || !a.email) return a
        var v = readDetectedVariant(a.email)
        return v ? Object.assign({}, a, { lastDetectedVariant: v }) : a
    })
}

// ── Plugins (plugins/plugins.jsonc) ─────────────────────────────────────────
// Extracted to ./desk/plugins-config.js (behavior identical).
const { createPluginsConfig } = require('./plugins-config')
// Shared plugin capability backend — same module the bot uses, so the Desk shows the
// exact settings schema + last panel snapshot the running plugin produced.
let pluginDataStore = null
try { pluginDataStore = require('../plugins/plugin-data-store') } catch {}
const {
    isPluginEnabled,
    readPluginsConfig,
    readPluginsList,
    listInstalledFolders,
    setPluginEnabled,
    setPluginTrust,
    addMarketplacePlugin,
    removePlugin,
    setPluginVersion,
    setPluginAutoUpdate
} = createPluginsConfig({ root: ROOT, atomicWriteText })

function atomicWriteText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${Date.now()}.tmp`)
    let fd
    try {
        fd = fs.openSync(tempPath, 'wx', 0o600)
        fs.writeFileSync(fd, content, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(tempPath, filePath)
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(tempPath, { force: true })
    }
}

// ── Terminal mode ───────────────────────────────────────────────────────────
function launchTerminalMode() {
    const startScript = path.join(ROOT, 'scripts', 'start.js')
    if (process.platform === 'win32') {
        // Open a visible PowerShell window that runs the bot in terminal mode.
        // Write the launch commands to a temp .ps1 to avoid fragile nested quoting
        // through cmd → start → powershell.
        const psBody =
            `Set-Location -LiteralPath '${ROOT.replace(/'/g, "''")}'\r\n` +
            `$host.UI.RawUI.WindowTitle = 'Microsoft Rewards Bot'\r\n` +
            `& '${process.execPath.replace(/'/g, "''")}' '${startScript.replace(/'/g, "''")}' --terminal\r\n`
        const psFile = path.join(os.tmpdir(), 'msrb-terminal-launch.ps1')
        fs.writeFileSync(psFile, psBody, 'utf8')
        childProcess
            .spawn(
                'cmd.exe',
                [
                    '/c',
                    'start',
                    'Microsoft Rewards Bot',
                    'powershell',
                    '-NoExit',
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    psFile
                ],
                {
                    cwd: ROOT,
                    env: { ...process.env, MSRB_TERMINAL_MODE: '1', MSRB_UI_CHILD: '0' },
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false
                }
            )
            .unref()
        return
    }
    // macOS / Linux: best-effort terminal launch, fall back to detached node
    const env = { ...process.env, MSRB_TERMINAL_MODE: '1', MSRB_UI_CHILD: '0' }
    if (process.platform === 'darwin') {
        const script = `cd "${ROOT}" && "${process.execPath}" "${startScript}" --terminal`
        childProcess
            .spawn('osascript', ['-e', `tell application "Terminal" to do script "${script.replace(/"/g, '\\"')}"`], {
                detached: true,
                stdio: 'ignore'
            })
            .unref()
        return
    }
    const terminals = [
        ['x-terminal-emulator', ['-e', process.execPath, startScript, '--terminal']],
        ['gnome-terminal', ['--', process.execPath, startScript, '--terminal']],
        ['konsole', ['-e', process.execPath, startScript, '--terminal']],
        ['xterm', ['-e', process.execPath, startScript, '--terminal']]
    ]
    for (const [cmd, args] of terminals) {
        if (commandExists(cmd)) {
            childProcess.spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: 'ignore' }).unref()
            return
        }
    }
    // No terminal emulator — run detached with inherited stdio is impossible here; just spawn
    childProcess
        .spawn(process.execPath, [startScript, '--terminal'], { cwd: ROOT, env, detached: true, stdio: 'ignore' })
        .unref()
}

// ── Docs (docs/*.md) ────────────────────────────────────────────────────────
// Extracted to ./desk/docs.js — behavior identical; covered by tests/desk-behavior.test.js.
const { createDocs } = require('./docs')
const { listDocs, readDocFile } = createDocs({ root: ROOT, appVersion: APP_VERSION })

async function loadDeskLicenseState() {
    try {
        const result = await runCoreLicenseWorker({ action: 'status' })
        state.deskLicense.clientReady = result.clientReady === true
        if (result.tier === 'premium') {
            state.deskLicense.tier = 'premium'
            state.deskLicense.planType = result.planType || ''
            state.deskLicense.expiresAt = result.expiresAt || null
            state.hasLicenseCache = true
        } else {
            state.deskLicense.tier = 'free'
            state.hasLicenseCache = false
        }
    } catch (error) {
        pushLog('warn', `Core license status could not be loaded: ${error.message}`)
    } finally {
        state.deskLicense.loading = false
        state.boot.licenseReady = true
        finishDeskBoot()
        // Announce + connect remote as soon as premium is confirmed.
        if (state.deskLicense.tier === 'premium') {
            reportDeskPresence()
            if (remoteAccessEnabled()) void startAgentProcess()
        }
    }
}

function prepareInitialRun() {
    state.status = 'Ready'
    state.detail = 'Click "Run daily set now" to start'
}

function finishDeskBoot() {
    if (!state.boot.accountsReady || !state.boot.licenseReady) return
    prepareInitialRun()
}

// First GUI launch only: turn on "Open Rewards Desk at sign-in" by default. A one-shot
// marker makes it stick if the user later turns it off, and we skip headless/CI launches
// so a Docker/server start never writes a desktop autostart entry.
function maybeAutoEnableDeskStartup() {
    if (process.env.MSRB_APP_NO_OPEN === '1') return
    const marker = path.join(ROOT, 'data', '.desk-startup-init')
    try {
        if (fs.existsSync(marker)) return
        fs.mkdirSync(path.dirname(marker), { recursive: true })
        fs.writeFileSync(marker, new Date().toISOString())
    } catch {
        return // can't persist the marker → don't risk re-enabling on every launch
    }
    try {
        const st = startupManager.status()
        if (!st || !st.desk || !st.desk.installed) {
            startupManager.setDeskEnabled(true)
            pushLog('info', 'Enabled "Open Rewards Desk at sign-in" (turn it off in Settings → Startup).')
        }
    } catch (error) {
        pushLog('warn', `Could not enable Desk autostart: ${error && error.message ? error.message : error}`)
    }
}

// First GUI launch only: create the Desktop + Start Menu shortcuts by default — same
// one-shot pattern as maybeAutoEnableDeskStartup above, just for desktopInstallManager
// instead of startupManager. Without this, a fresh install (git clone + npm start,
// bypassing the separate native installer) never gets a clickable shortcut unless the
// user finds Settings and clicks "Install shortcuts" themselves.
function maybeAutoInstallDeskShortcuts() {
    if (process.env.MSRB_APP_NO_OPEN === '1') return
    const marker = path.join(ROOT, 'data', '.desk-shortcut-init')
    try {
        if (fs.existsSync(marker)) return
        fs.mkdirSync(path.dirname(marker), { recursive: true })
        fs.writeFileSync(marker, new Date().toISOString())
    } catch {
        return // can't persist the marker → don't risk reinstalling on every launch
    }
    try {
        const st = desktopInstallManager.status()
        if (st && st.supported && !st.complete) {
            desktopInstallManager.install()
            pushLog('info', 'Created Rewards Desk shortcuts (Desktop + Start Menu). Remove them anytime from Settings.')
        }
    } catch (error) {
        pushLog('warn', `Could not create Desk shortcuts: ${error && error.message ? error.message : error}`)
    }
}

function initializeDeskInBackground() {
    void loadDeskLicenseState()
    setTimeout(() => {
        void startAccountStorageWorker()
            .then(result => {
                if (result.storage?.warning) pushLog('warn', result.storage.warning)
                state.accounts = Array.isArray(result.accounts) ? result.accounts : []
                // Decrypted accounts are no longer pushed in the startup `ready` message
                // (security). They are fetched on demand via the `read` action the first
                // time /api/accounts-raw is hit (see accountCache === null branch there).
                accountCache = null
            })
            .catch(error => {
                pushLog('warn', `Account encryption could not be enabled: ${error.message}`)
            })
            .finally(() => {
                state.boot.accountsReady = true
                finishDeskBoot()
            })
    }, 150)
}

function openAccountsFile() {
    const storageState = accountStorage.status()
    if (storageState.encrypted) return false
    const accountsFile = accountStorage.accountsPath
    if (!fs.existsSync(accountsFile)) return false

    if (process.platform === 'win32') {
        childProcess
            .spawn('notepad.exe', [accountsFile], { detached: true, stdio: 'ignore', windowsHide: false })
            .unref()
        return true
    }

    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    childProcess.spawn(opener, [accountsFile], { detached: true, stdio: 'ignore' }).unref()
    return true
}

function openDefaultBrowser(url) {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    childProcess.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

function openDiscord() {
    openDefaultBrowser('https://discord.gg/JWhCkhSYtg')
}

function serveStaticImage(res, filePath) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
    }
    const ext = path.extname(filePath).toLowerCase()
    const mime = ext === '.ico' ? 'image/x-icon' : 'image/png'
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' })
    fs.createReadStream(filePath).pipe(res)
}

function serveStaticGif(res, filePath) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
    }
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'public, max-age=3600' })
    fs.createReadStream(filePath).pipe(res)
}

function serveAppIcon(res) {
    serveStaticImage(res, APP_ICON_PATH)
}

function html() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_TITLE}</title>
<link rel="icon" type="image/x-icon" href="/app-icon.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="manifest" href="/manifest.json">
<style>
    :root{
      --bg:#03080f;--surface:#07111f;--surface2:#0c1a2e;
      --border:rgba(30,155,255,.13);--border-hi:rgba(46,232,255,.28);
      --text:#e8f4ff;--muted:#6e92b8;
      --blue:#1e9bff;--cyan:#2ee8ff;--green:#2fd27d;--gold:#f7c85c;--rose:#ff6b8a;
      --r:13px;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow:hidden}
    body{
      font-family:"Segoe UI",system-ui,sans-serif;
      background:var(--bg);color:var(--text);
      display:flex;
      animation:appIn .4s ease-out;
      user-select:none;-webkit-user-select:none;
    }
    input,textarea,select,.console-box{user-select:text;-webkit-user-select:text}
    @keyframes appIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.75)}}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(30,155,255,0)}50%{box-shadow:0 0 24px 4px rgba(30,155,255,.18)}}
    @keyframes viewIn{from{opacity:0;transform:translateY(8px) scale(.995)}to{opacity:1;transform:none}}
    @keyframes coreAura{0%,100%{filter:drop-shadow(0 0 0 rgba(247,200,92,0))}50%{filter:drop-shadow(0 0 12px rgba(247,200,92,.25))}}
    .app-boot{
      position:fixed;inset:0;z-index:500;display:grid;place-items:center;
      background:radial-gradient(circle at 50% 42%,rgba(30,155,255,.12),transparent 34%),var(--bg);
      transition:opacity .28s ease,visibility .28s ease;
    }
    .app-boot.ready{opacity:0;visibility:hidden;pointer-events:none}
    .app-boot-card{display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center}
    .app-boot-logo{width:58px;height:58px;border-radius:16px;box-shadow:0 0 30px rgba(30,155,255,.28)}
    .app-boot-spinner,.inline-spinner{
      width:20px;height:20px;border:2px solid rgba(46,232,255,.18);
      border-top-color:var(--cyan);border-radius:50%;animation:spin .75s linear infinite;
    }
    .app-boot-title{font-size:16px;font-weight:750}
    .app-boot-detail{font-size:12px;color:var(--muted)}
    .loading-block{display:flex;align-items:center;justify-content:center;gap:10px;min-height:105px;color:var(--muted);font-size:12px}
    .action-busy{position:relative;pointer-events:none;opacity:.72}
    .action-busy:after{
      content:"";width:12px;height:12px;margin-left:8px;display:inline-block;vertical-align:-2px;
      border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
    }
    .startup-card.is-busy{opacity:.72;pointer-events:none}
    .toast{
      position:fixed;right:22px;bottom:22px;z-index:450;max-width:360px;
      padding:12px 16px;border-radius:14px;border:1px solid rgba(47,210,125,.28);
      background:rgba(8,22,38,.82);backdrop-filter:blur(22px);color:#caffdf;font-size:13px;
      box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);
      opacity:0;transform:translateY(12px);pointer-events:none;
      transition:opacity .22s ease,transform .22s ease;
      display:flex;align-items:center;gap:10px;
    }
    .toast.show{opacity:1;transform:none}
    .toast.error{border-color:rgba(255,107,138,.35);color:#ffd2dc}
    button,input{font:inherit}
    ::-webkit-scrollbar{width:4px;height:4px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(30,155,255,.22);border-radius:99px}


    /* ── Sidebar ── */
    .sidebar{
      width:clamp(180px,16vw,220px);flex-shrink:0;display:flex;flex-direction:column;
      padding:clamp(14px,1.6vh,22px) clamp(10px,1vw,14px);
      border-right:1px solid var(--border);
      background:linear-gradient(180deg,rgba(7,17,31,.97) 0%,rgba(3,8,15,.98) 100%);
    }
    .brand{display:flex;align-items:center;gap:11px;padding-bottom:clamp(12px,1.5vh,20px);border-bottom:1px solid var(--border);margin-bottom:clamp(10px,1.4vh,16px)}
    .brand img{width:clamp(32px,2.8vw,40px);height:clamp(32px,2.8vw,40px);border-radius:12px;box-shadow:0 0 18px rgba(30,155,255,.32)}
    .brand-name{font-size:clamp(12px,1vw,14px);font-weight:700;line-height:1.2}
    .brand-sub{font-size:clamp(10px,.85vw,11px);color:var(--muted);margin-top:1px}
    nav{display:flex;flex-direction:column;gap:3px;flex:1}
    .nav-group{font-size:9px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);opacity:.55;padding:11px 11px 4px;user-select:none}
    .nav-group:first-child{padding-top:2px}
    .nav-item{
      display:flex;align-items:center;gap:10px;padding:clamp(7px,.9vh,10px) 11px;
      border-radius:10px;color:var(--muted);cursor:pointer;
      transition:all .16s ease;font-size:clamp(12px,.95vw,13.5px);font-weight:500;
      user-select:none;border:1px solid transparent;
    }
    .nav-item:hover{color:var(--text);background:rgba(30,155,255,.09)}
    .nav-item.active{
      color:var(--text);
      background:linear-gradient(90deg,rgba(30,155,255,.22),rgba(30,155,255,.07));
      border-color:rgba(46,232,255,.22);
    }
    .nav-item svg{width:17px;height:17px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .nav-item-core svg{fill:var(--gold);stroke:var(--gold);stroke-width:0}
    .nav-item-core{color:var(--gold) !important}
    .nav-item-core:hover{background:rgba(247,200,92,.1) !important}
    .nav-item-core.active{background:linear-gradient(90deg,rgba(247,200,92,.2),rgba(247,200,92,.06)) !important;border-color:rgba(247,200,92,.22) !important}
    .core-nav-badge{margin-left:auto;font-size:9px;font-weight:800;letter-spacing:.07em;padding:1px 5px;border-radius:4px;background:rgba(247,200,92,.2);color:var(--gold);border:1px solid rgba(247,200,92,.3)}
    .beta-nav-badge{margin-left:auto;font-size:9px;font-weight:800;letter-spacing:.07em;padding:1px 5px;border-radius:4px;background:rgba(167,139,250,.18);color:#c4b5fd;border:1px solid rgba(167,139,250,.32)}
    .sidebar-bottom{margin-top:auto;padding-top:clamp(10px,1.4vh,16px);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
    .discord-btn{
      display:flex;align-items:center;justify-content:center;gap:8px;
      padding:clamp(6px,.8vh,9px) 12px;border-radius:10px;border:1px solid rgba(88,101,242,.3);
      background:rgba(88,101,242,.14);color:#bcc3ff;font-size:clamp(11px,.9vw,12.5px);
      font-weight:600;cursor:pointer;transition:all .16s ease;
    }
    .discord-btn:hover{background:rgba(88,101,242,.28);color:#fff;border-color:rgba(88,101,242,.5)}
    .discord-btn svg{width:15px;height:15px;flex-shrink:0}
    .install-btn{
      display:flex;align-items:center;justify-content:center;gap:8px;
      padding:clamp(6px,.8vh,9px) 12px;border-radius:10px;border:1px solid rgba(47,210,125,.28);
      background:rgba(47,210,125,.1);color:#8ce9b7;font-size:clamp(11px,.9vw,12.5px);
      font-weight:650;cursor:pointer;transition:all .16s ease;
    }
    .install-btn:hover{background:rgba(47,210,125,.2);color:#d8ffea;border-color:rgba(47,210,125,.5)}
    .install-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2}
    .ver{font-size:11px;color:var(--muted);text-align:center;opacity:.7}

    /* ── Main ── */
    .main{
      flex:1;min-width:0;display:grid;
      grid-template-rows:auto 1fr 34px;
      padding:clamp(12px,1.4vh,18px) clamp(14px,1.6vw,22px) 12px;gap:clamp(8px,1vh,14px);overflow:hidden;
    }

    /* ── Hero ── */
    .hero{
      position:relative;border-radius:var(--r);overflow:hidden;
      min-height:158px;display:flex;align-items:center;padding:24px 34px;
      border:1px solid var(--border);
    }
    .hero::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;background:radial-gradient(120% 90% at 92% 8%,rgba(46,232,255,.14),transparent 55%)}
    .hero-bg{
      position:absolute;inset:0;
      background-image:url('/banner-core.png');
      background-size:cover;background-position:center top;z-index:0;
    }
    .hero-overlay{
      position:absolute;inset:0;z-index:1;
      background:linear-gradient(100deg,rgba(3,8,15,.92) 0%,rgba(3,8,15,.78) 45%,rgba(3,8,15,.35) 100%);
    }
    .hero-content{position:relative;z-index:2;max-width:480px}
    .hero-content h1{
      font-size:clamp(24px,2.6vw,38px);font-weight:900;line-height:1.08;
      letter-spacing:-.4px;text-shadow:0 2px 20px rgba(0,0,0,.5);
    }
    .hero-content h1 span{background:linear-gradient(90deg,var(--cyan),#8af1ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:var(--cyan)}
    .hero-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--cyan);margin-bottom:12px;text-shadow:0 1px 8px rgba(0,0,0,.5)}
    .hero-eyebrow-dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 10px var(--cyan);flex-shrink:0}
    .hero-eyebrow-dot.run{animation:pulse 1.3s infinite}
    .hero-content p{
      margin-top:9px;font-size:13.5px;color:#aac4e0;line-height:1.6;
      max-width:360px;text-shadow:0 1px 8px rgba(0,0,0,.4);
    }
    .hero-btns{display:flex;gap:9px;margin-top:18px}
    .btn{
      display:inline-flex;align-items:center;gap:7px;padding:10px 18px;
      border-radius:9px;font-size:13.5px;font-weight:700;cursor:pointer;
      border:none;transition:all .16s ease;
    }
    .btn svg{width:14px;height:14px;flex-shrink:0}
    .btn-primary{
      background:linear-gradient(135deg,var(--blue),#4f7cff);color:#fff;
      box-shadow:0 6px 20px rgba(30,155,255,.28);
    }
    .btn-primary:hover:not(:disabled){filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 10px 28px rgba(30,155,255,.36)}
    .btn-secondary{
      background:rgba(255,255,255,.07);border:1px solid rgba(46,232,255,.22);color:var(--text);
    }
    .btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(46,232,255,.4)}
    .btn:disabled{opacity:.38;cursor:default;transform:none !important;filter:none !important}
    .btn-sm{padding:7px 13px;font-size:12px;border-radius:8px}
    .hero-pills{position:absolute;top:18px;right:22px;z-index:2;display:flex;flex-direction:column;align-items:flex-end;gap:7px}

    /* ── Pills ── */
    .pill{
      display:inline-flex;align-items:center;gap:6px;padding:5px 11px;
      border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.02em;
      transition:all .25s ease;white-space:nowrap;
    }
    .pill-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
    .pill-ready{background:rgba(110,146,184,.1);border:1px solid rgba(110,146,184,.25);color:var(--muted)}
    .pill-ready .pill-dot{background:var(--muted)}
    .pill-run{background:rgba(30,155,255,.14);border:1px solid rgba(30,155,255,.35);color:#80c8ff}
    .pill-run .pill-dot{background:var(--blue);animation:pulse 1.3s infinite}
    .pill-ok{background:rgba(47,210,125,.12);border:1px solid rgba(47,210,125,.3);color:#7ef5bc}
    .pill-ok .pill-dot{background:var(--green)}
    .pill-warn{background:rgba(247,200,92,.1);border:1px solid rgba(247,200,92,.28);color:var(--gold)}
    .pill-warn .pill-dot{background:var(--gold);animation:pulse .9s infinite}
    .pill-err{background:rgba(255,107,138,.1);border:1px solid rgba(255,107,138,.24);color:var(--rose)}
    .pill-err .pill-dot{background:var(--rose)}
    .pill-muted{background:rgba(110,146,184,.07);border:1px solid rgba(110,146,184,.15);color:var(--muted)}
    .pill-muted .pill-dot{background:var(--muted)}

    /* ── Cards grid ── */
    .cards{
      display:grid;grid-template-columns:1fr 1fr;gap:clamp(12px,1.4vw,20px);
      flex-shrink:0; min-height:clamp(160px,22vh,220px);
    }
    .card{
      background:rgba(10,14,25,0.6);backdrop-filter:blur(20px);
      border:1px solid rgba(255,255,255,0.05);border-radius:20px;
      padding:clamp(16px,2vw,28px);display:flex;flex-direction:column;overflow:hidden;
      transition:transform 0.4s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.4s, border-color 0.4s;
      box-shadow:0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05);
      animation:slideUp .3s ease-out both; min-height:0;
    }
    .card:nth-child(2){animation-delay:.05s}
    .card:nth-child(3){animation-delay:.1s}
    .card:hover{transform:translateY(-3px);box-shadow:0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08);border-color:rgba(30,155,255,.22)}

    .star-banner {
      position: relative; overflow: hidden; border-radius: 18px;
      cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; border: 1px solid rgba(247,200,92,0.2);
    }
    .star-banner:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(247,200,92,0.1); }
    .star-banner-bg { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(247,200,92,0.15) 0%, rgba(2,7,16,0.8) 100%); }
    .star-banner-content { position: relative; z-index: 1; padding: clamp(12px,1.4vh,20px) clamp(14px,1.6vw,24px); display: flex; align-items: center; gap: 14px; }
    .star-banner-content svg { width: 26px; height: 26px; color: var(--gold); filter: drop-shadow(0 0 10px rgba(247,200,92,0.5)); flex-shrink:0; }
    .star-banner-text { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width:0; }
    .star-banner-title { font-size: clamp(13px,1vw,16px); font-weight: 700; color: #fff; }
    .star-banner-sub { font-size: clamp(11.5px,.88vw,13.5px); color: rgba(255,255,255,0.6); white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .star-banner-btn { flex-shrink:0; padding: 8px clamp(12px,1.2vw,20px); border-radius: 100px; background: rgba(247,200,92,0.15); color: var(--gold); font-size: clamp(11.5px,.88vw,13.5px); font-weight: 600; border: 1px solid rgba(247,200,92,0.3); transition: background 0.2s; pointer-events: none; }
    .star-banner:hover .star-banner-btn { background: rgba(247,200,92,0.25); }
    .info-banner{
      display:flex;align-items:center;gap:10px;padding:clamp(8px,1vh,11px) clamp(14px,1.5vw,18px);
      border-radius:12px;border:1px solid rgba(46,232,255,.16);
      background:rgba(10,30,50,.52);backdrop-filter:blur(18px);
      cursor:pointer;transition:border-color .2s,background .2s;
    }
    .info-banner:hover{background:rgba(14,38,62,.62);border-color:rgba(46,232,255,.3)}
    .info-banner-icon{width:28px;height:28px;border-radius:8px;background:rgba(46,232,255,.1);display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .info-banner-icon svg{width:14px;height:14px;stroke:var(--cyan);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .info-banner-text{flex:1;min-width:0;font-size:clamp(11px,.88vw,12.5px);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .info-banner-text strong{color:var(--text);font-weight:700}
    .info-banner-arrow{color:var(--muted);font-size:13px;flex-shrink:0}
    .ctx-menu{
      position:fixed;z-index:9000;min-width:190px;padding:5px;
      background:rgba(10,20,36,.92);backdrop-filter:blur(22px);
      border:1px solid rgba(255,255,255,.1);border-radius:12px;
      box-shadow:0 16px 48px rgba(0,0,0,.55);display:none;
    }
    .ctx-menu.open{display:block}
    .ctx-item{
      display:flex;align-items:center;gap:10px;padding:8px 12px;
      border-radius:8px;cursor:pointer;color:var(--text);font-size:13px;
      transition:background .14s;
    }
    .ctx-item:hover{background:rgba(30,155,255,.15)}
    .ctx-item svg{width:15px;height:15px;flex-shrink:0;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:clamp(8px,1.2vh,14px)}
    .card-label{font-size:clamp(10px,.85vw,11.5px);font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}

    /* Status card */
    .st-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(5px,.8vh,9px);text-align:center}
    .ring-wrap{position:relative;width:clamp(62px,7vh,92px);height:clamp(62px,7vh,92px)}
    .ring-svg{width:100%;height:100%;transform:rotate(-90deg)}
    .ring-track{fill:none;stroke:rgba(30,155,255,.1);stroke-width:7}
    .ring-fill{
      fill:none;stroke:url(#rg);stroke-width:7;stroke-linecap:round;
      stroke-dasharray:251.3;stroke-dashoffset:251.3;
      transition:stroke-dashoffset .75s cubic-bezier(.4,0,.2,1);
    }
    .ring-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    .ring-icon svg{width:clamp(16px,1.8vh,24px);height:clamp(16px,1.8vh,24px);fill:none;stroke:var(--blue);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .ring-wrap.run{border-radius:50%;animation:glowPulse 2.2s ease-in-out infinite}
    .ring-wrap.run .ring-icon svg{animation:beat 1.4s ease-in-out infinite}
    @keyframes beat{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
    .st-text{font-size:clamp(13px,1.3vh,17px);font-weight:800}
    .st-detail{font-size:clamp(10px,.95vh,12px);color:var(--muted);line-height:1.5;max-width:160px}
    .st-next{margin-top:4px;font-size:11px;font-weight:600;color:var(--cyan);display:none;align-items:center;gap:5px;justify-content:center}
    .st-next:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--cyan);box-shadow:0 0 8px var(--cyan)}

    /* Points card */
    .pts-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3px}
    .pts-val{font-size:34px;font-weight:900;color:var(--gold);line-height:1;letter-spacing:-1px}
    .pts-label{font-size:11px;color:var(--muted);margin-top:3px}
    .mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
    .mini{
      background:rgba(255,255,255,.03);border:1px solid var(--border);
      border-radius:8px;padding:5px 6px;text-align:center;
    }
    .mini-val{font-size:11px;font-weight:800;transition:color .3s}
    .mini-lbl{font-size:9px;color:var(--muted);margin-top:2px}
    .mini-sm .mini-val{font-size:10px;font-weight:700;color:var(--muted)}
    .mini-sm .mini-lbl{font-size:8.5px}

    /* Accounts card */
    .acc-list{display:flex;flex-direction:column;gap:7px;overflow-y:auto;flex:1}
    .acc-row{
      display:flex;align-items:center;gap:11px;padding:9px 11px;
      border-radius:10px;background:rgba(255,255,255,.025);
      border:1px solid transparent;transition:all .15s;
    }
    .acc-row.is-active{background:rgba(30,155,255,.1);border-color:rgba(30,155,255,.22)}
    .acc-row.is-disabled{opacity:.4}
    .acc-avatar{
      width:36px;height:36px;border-radius:11px;flex-shrink:0;
      background:linear-gradient(145deg,#1d4ed8,#2ee8ff);
      display:flex;align-items:center;justify-content:center;
      font-size:12px;font-weight:800;overflow:hidden;
    }
    .acc-info{flex:1;min-width:0}
    .acc-email{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .acc-st{font-size:11px;color:var(--muted);margin-top:1px}
    .acc-pts-badge{font-size:11px;font-weight:700;color:var(--green);background:rgba(47,210,125,.1);border:1px solid rgba(47,210,125,.2);border-radius:6px;padding:1px 6px;flex-shrink:0;white-space:nowrap;display:inline-flex;align-items:center;gap:2px}
    .acc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .dot-ready{background:var(--muted)}
    .dot-run{background:var(--blue);animation:pulse 1.3s infinite}
    .dot-ok{background:var(--green)}
    .dot-off{background:rgba(110,146,184,.3)}
    .acc-empty{
      flex:1;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:10px;text-align:center;padding:16px 0;
    }
    .acc-empty svg{width:36px;height:36px;opacity:.25;stroke:var(--text);fill:none;stroke-width:1.4}
    .acc-empty p{font-size:13px;color:var(--muted)}

    /* Full accounts view */
    .view-full{display:none;flex-direction:column;gap:0;min-height:0;overflow:hidden}
    .view-full.vis{display:flex}

    /* Accounts page layout */
    .acc-page-header{
      display:flex;align-items:center;justify-content:space-between;
      padding:clamp(14px,1.6vh,22px) clamp(14px,1.6vw,22px);
      border-bottom:1px solid var(--border);
      background:rgba(10,14,25,0.5);backdrop-filter:blur(12px);
      flex-shrink:0;
    }
    .acc-page-title-wrap{display:flex;flex-direction:column;gap:2px}
    .acc-page-title{font-size:clamp(17px,1.5vw,22px);font-weight:800;color:var(--text);letter-spacing:-.02em}
    .acc-page-sub{font-size:clamp(11px,.9vw,13px);color:var(--muted)}
    .acc-page-stats{display:flex;align-items:center;gap:clamp(10px,1.4vw,20px)}
    .acc-stat{
      display:flex;flex-direction:column;align-items:center;gap:2px;
      padding:8px clamp(12px,1.2vw,18px);border-radius:14px;
      background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);
    }
    .acc-stat-val{font-size:clamp(18px,1.6vw,24px);font-weight:800;color:var(--text);line-height:1}
    .acc-stat-lbl{font-size:clamp(9px,.75vw,11px);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
    .acc-page-actions{display:flex;gap:8px;align-items:center}
    .acc-page-body{flex:1;overflow-y:auto;padding:clamp(14px,1.6vw,20px);display:flex;flex-direction:column;gap:8px}

    /* Account rows - premium */
    .acc-editor-row{
      display:grid;grid-template-columns:auto 1fr auto;
      align-items:center;gap:14px;padding:clamp(10px,1.2vh,14px) clamp(12px,1.2vw,16px);
      border-radius:16px;background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.05);
      transition:all .2s ease;cursor:default;
    }
    .acc-editor-row:hover{background:rgba(30,155,255,.06);border-color:rgba(30,155,255,.2);transform:translateX(2px)}
    .acc-editor-row.is-active{border-color:rgba(46,232,255,.25);background:rgba(46,232,255,.04)}
    .acc-editor-row.is-active:hover{border-color:rgba(46,232,255,.4);background:rgba(46,232,255,.07)}
    .acc-editor-row.is-disabled{opacity:.5}
    .acc-avatar{
      width:clamp(34px,3.5vw,42px);height:clamp(34px,3.5vw,42px);border-radius:50%;
      background:linear-gradient(135deg,rgba(30,155,255,.25),rgba(46,232,255,.1));
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
      font-size:clamp(13px,1.2vw,16px);font-weight:700;color:var(--cyan);
      border:1px solid rgba(46,232,255,.2);overflow:hidden;
    }
    .acc-avatar.running{background:linear-gradient(135deg,rgba(47,210,125,.25),rgba(46,232,255,.1));color:var(--green);border-color:rgba(47,210,125,.3);animation:glowPulse 2s ease-in-out infinite}
    .acc-info{display:flex;flex-direction:column;gap:3px;min-width:0}
    .acc-email{font-size:clamp(12px,.95vw,14px);font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .acc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .acc-actions-cell{display:flex;gap:6px;flex-shrink:0}

    /* Console view */
    .console-wrap{display:none;flex-direction:column;gap:10px;min-height:0;overflow:hidden}
    .console-wrap.vis{display:flex}
    .console-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
    .console-head-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .console-head-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .console-line-count{font-size:10.5px;color:var(--muted);font-weight:600;padding:0 8px;height:28px;display:flex;align-items:center;border-radius:7px;background:rgba(255,255,255,.05);white-space:nowrap}
    /* Segmented filter control — one pill group, same height as the buttons */
    .console-filters{display:inline-flex;align-items:center;gap:2px;height:28px;padding:2px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}
    .console-filter{background:none;border:none;color:var(--muted);border-radius:6px;padding:0 11px;height:100%;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;display:flex;align-items:center;font-family:inherit}
    .console-filter:hover{color:var(--text)}
    .console-filter.active{color:var(--cyan);background:rgba(46,232,255,.12)}
    .console-filter.active[data-level="error"]{color:#ff8098;background:rgba(255,128,152,.12)}
    .console-filter.active[data-level="warn"]{color:var(--gold);background:rgba(247,200,92,.12)}
    .console-filter.active[data-level="success"]{color:var(--green);background:rgba(47,210,125,.12)}
    .console-search{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:var(--text);border-radius:8px;padding:0 10px;height:28px;font-size:11.5px;width:120px;outline:none;transition:width .15s,border-color .15s,background .15s;font-family:inherit}
    .console-search:focus{border-color:rgba(46,232,255,.4);background:rgba(46,232,255,.04);width:160px}
    .console-search::placeholder{color:var(--muted)}
    /* Console toolbar buttons — uniform height with the filter group & search */
    .console-head-actions .btn{height:28px;padding:0 12px;font-size:11.5px;border-radius:8px;display:inline-flex;align-items:center}
    .console-box{
      flex:1;background:#020610;border:1px solid var(--border);
      border-radius:var(--r);padding:14px 16px;overflow-y:auto;overflow-anchor:none;
      font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:12px;
      line-height:1.7;color:#cfe3f2;word-break:break-word;cursor:text;
    }
    .console-box::-webkit-scrollbar{width:9px}
    .console-box::-webkit-scrollbar-thumb{background:rgba(110,146,184,.28);border-radius:6px;border:2px solid #020610}
    .console-box::-webkit-scrollbar-thumb:hover{background:rgba(110,146,184,.48)}
    .console-empty{color:var(--muted);font-style:italic;opacity:.6;padding:4px 0}
    /* Individual log line */
    .clog{display:flex;gap:10px;padding:1.5px 6px;margin:0 -6px;line-height:1.65;border-radius:5px;transition:background .12s}
    .clog:hover{background:rgba(255,255,255,.03)}
    .clog-ts{color:rgba(110,146,184,.42);font-size:10.5px;flex-shrink:0;padding-top:1px;font-variant-numeric:tabular-nums;min-width:58px;user-select:none}
    .clog-msg{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
    .clog-error .clog-msg{color:#ff8098}
    .clog-warn .clog-msg{color:var(--gold)}
    .clog-success .clog-msg{color:var(--green)}
    .clog-info .clog-msg{color:#cfe3f2}
    /* Coloured accent bar on non-info lines */
    .clog-error,.clog-warn,.clog-success{position:relative}
    .clog-error::before,.clog-warn::before,.clog-success::before{content:'';position:absolute;left:0;top:3px;bottom:3px;width:2px;border-radius:2px}
    .clog-error::before{background:#ff8098}
    .clog-warn::before{background:var(--gold)}
    .clog-success::before{background:var(--green)}
    @keyframes clogIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
    .clog-new{animation:clogIn .18s ease-out both}
    /* Animated spinner glyph — spins only on the active (last) line */
    .clog-spin{display:inline-flex;width:11px;height:11px;flex-shrink:0;align-self:flex-start;margin-top:3px;border:1.6px solid rgba(46,232,255,.25);border-top-color:var(--cyan);border-radius:50%}
    .clog:last-child .clog-spin{animation:spin .7s linear infinite}
    .clog-spinline .clog-msg{color:var(--cyan)}
    @keyframes spin{to{transform:rotate(360deg)}}
    .console-jump{
      position:absolute;right:18px;bottom:16px;display:none;align-items:center;justify-content:center;gap:6px;
      height:34px;padding:0 14px;border-radius:100px;border:1px solid rgba(46,232,255,.28);
      background:rgba(9,20,36,.92);backdrop-filter:blur(10px);color:var(--cyan);font-size:11.5px;font-weight:600;
      cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.45);transition:transform .15s,background .15s,opacity .2s;z-index:5;opacity:0;
    }
    .console-jump:hover{background:rgba(46,232,255,.16);transform:translateY(-1px)}
    .console-jump.show{display:inline-flex;animation:jumpIn .2s ease-out both}
    @keyframes jumpIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .console-jump svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}

    /* Footer */
    .footer{
      display:flex;align-items:center;justify-content:space-between;
      font-size:12px;color:var(--muted);border-top:1px solid var(--border);padding-top:10px;
      min-height:0;
    }
    .footer-left{display:flex;align-items:center;gap:14px}
    .footer-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);display:inline-block;margin-right:5px;transition:background .3s}

    /* Modal */
    .modal-bg{
      position:fixed;inset:0;display:none;place-items:center;
      background:rgba(1,5,12,.75);backdrop-filter:blur(16px);z-index:99;padding:24px;
    }
    .modal-bg.open{display:grid}
    .modal{
      width:min(490px,100%);position:relative;
      background:linear-gradient(180deg,rgba(6,14,30,.99),rgba(2,7,18,.99));
      border:1px solid rgba(46,232,255,.16);border-radius:22px;padding:32px;
      overflow:hidden;box-shadow:0 60px 130px rgba(0,0,0,.75);
      animation:licCardIn .34s cubic-bezier(.22,.68,0,1.08);
    }
    @keyframes licCardIn{
      from{opacity:0;transform:translateY(34px) scale(.96)}
      to{opacity:1;transform:none}
    }
    .modal-icon{
      width:52px;height:52px;border-radius:16px;margin-bottom:20px;
      background:linear-gradient(145deg,rgba(0,120,255,.2),rgba(0,255,255,.2));
      border:1px solid rgba(0,255,255,.3);
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 10px 28px rgba(30,155,255,.3);
      backdrop-filter:blur(10px);
    }
    .modal-icon svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

    .modal h2{font-size:24px;font-weight:800;margin-bottom:8px;background:linear-gradient(to right,#fff,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .modal p{color:var(--muted);font-size:14px;line-height:1.6;margin-bottom:24px}
    .modal-input{
      width:100%;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);
      border-radius:10px;padding:12px 14px;color:var(--text);font:inherit;
      font-size:14px;outline:none;transition:all .2s;
    }
    .modal-input:focus{border-color:var(--blue);background:rgba(255,255,255,.04);box-shadow:0 0 0 2px rgba(30,155,255,.15);}
    .modal-input::placeholder{color:rgba(255,255,255,.25);}
    /* <select> needs a solid background: a faint overlay (fine for text inputs sitting
       on the modal backdrop) leaves Chromium's native control chrome showing through as
       a plain white box, and the open option list is unstyled system white-on-black
       text by default. Same fix already applied to .settings-input elsewhere. */
    select.modal-input{background:rgba(2,7,16,.85);}
    select.modal-input option{background:#07111f;color:var(--text);}
    .modal-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:24px}
    
    .btn{
      padding:11px 16px;border-radius:10px;font-weight:600;font-size:14px;
      cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;
      border:none;outline:none;transition:all .15s cubic-bezier(.22,.68,0,1.08);
    }
    .btn:hover:not(:disabled) { transform: scale(1.02); }
    .btn:active:not(:disabled) { transform: scale(.98); }
    .btn:disabled{opacity:.4;cursor:not-allowed}
    .btn-primary{
      background:var(--blue);color:#fff;
      box-shadow:0 4px 12px rgba(30,155,255,.2);
      border:1px solid rgba(255,255,255,.1);
    }
    .btn-primary:hover:not(:disabled){background:#2483d4;box-shadow:0 6px 16px rgba(30,155,255,.3);}
    .btn-secondary{
      background:rgba(255,255,255,.05);color:var(--text);
      border:1px solid rgba(255,255,255,.08);
    }
    .btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.15);}

    /* ── GitHub Star modal ── */
    .star-modal-gif{
      width:100%;max-width:280px;height:auto;object-fit:cover;
      border-radius:12px;margin:0 auto 20px;display:block;
      box-shadow:0 8px 24px rgba(0,0,0,.4);
      border:1px solid rgba(255,255,255,.05);
    }
    .star-modal-content h2{
      font-size:24px;font-weight:800;margin-bottom:12px;
      background:linear-gradient(to right,#fff,#ffd700);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
    }
    .star-modal-content p{
      color:rgba(180,200,230,.8);font-size:14.5px;line-height:1.6;margin-bottom:28px;
    }
    .btn-star{
      background:linear-gradient(135deg,#e6ac00,#f5c518 60%,#e6ac00);
      color:#0a0800;font-weight:800;border:none;
      box-shadow:0 6px 20px rgba(230,172,0,.3);
    }
    .btn-star:hover:not(:disabled){
      background:linear-gradient(135deg,#f5c518,#ffdb4d 60%,#f5c518);
      box-shadow:0 8px 24px rgba(230,172,0,.4);
    }
    .btn-star svg{width:18px;height:18px;fill:#0a0800;flex-shrink:0;}
    /* ── end GitHub Star modal ── */

    /* Toast Notification */
    .toast {
      position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%) translateY(100px);
      background: rgba(10,14,25,0.85); backdrop-filter: blur(24px);
      border: 1px solid rgba(46,232,255,.3); border-radius: 100px;
      padding: 14px 28px; color: #fff; font-size: 14px; font-weight: 600;
      box-shadow: 0 20px 40px rgba(0,0,0,.5), 0 0 20px rgba(46,232,255,.15);
      opacity: 0; pointer-events: none; transition: all .4s cubic-bezier(.22,.68,0,1.08);
      z-index: 10000; display: flex; align-items: center; gap: 12px;
    }
    .toast.error { border-color: rgba(255,107,138,.4); box-shadow: 0 20px 40px rgba(0,0,0,.5), 0 0 20px rgba(255,107,138,.15); }
    .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
    
    .modal-msg{min-height:17px;font-size:12px;color:var(--cyan);margin-top:9px}
    /* Accounts editor */
    .btn-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--muted);cursor:pointer;transition:all .15s;flex-shrink:0}
    .btn-icon:hover{color:var(--text);background:rgba(255,255,255,.12);border-color:rgba(30,155,255,.3)}
    .btn-icon.danger:hover{color:var(--rose);border-color:rgba(255,107,138,.3);background:rgba(255,107,138,.07)}
    .btn-icon.btn-icon-on{color:var(--green);border-color:rgba(47,210,125,.3);background:rgba(47,210,125,.08)}
    .btn-icon.btn-icon-on:hover{color:var(--green);border-color:rgba(47,210,125,.5);background:rgba(47,210,125,.14)}
    .btn-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .acc-editor-row{display:flex;align-items:center;gap:11px;padding:11px 13px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid transparent;transition:all .15s;margin-bottom:7px}
    .acc-editor-row:hover{border-color:var(--border);background:rgba(255,255,255,.045)}
    .acc-actions-cell{display:flex;gap:6px;flex-shrink:0}
    /* Proxy Badges & Grouping Styles */
    .acc-proxy-badge{
      font-size:10.5px;
      color:var(--cyan);
      background:rgba(0, 240, 255, 0.05);
      border:1px solid rgba(0, 240, 255, 0.12);
      padding:2px 7px;
      border-radius:6px;
      display:inline-flex;
      align-items:center;
      cursor:pointer;
      transition:all .15s;
      max-width:fit-content;
      margin-top:2px;
      user-select:none;
    }
    .acc-proxy-badge:hover{
      background:rgba(0, 240, 255, 0.1);
      border-color:rgba(0, 240, 255, 0.25);
      box-shadow:0 0 6px rgba(0, 240, 255, 0.15);
    }
    .acc-proxy-badge.testing{
      color:var(--muted);
      background:rgba(255, 255, 255, 0.03);
      border-color:rgba(255, 255, 255, 0.08);
      cursor:default;
      box-shadow:none;
    }
    .acc-proxy-badge.success{
      color:#10b981;
      background:rgba(16, 185, 129, 0.06);
      border-color:rgba(16, 185, 129, 0.18);
    }
    .acc-proxy-badge.success:hover{
      background:rgba(16, 185, 129, 0.12);
      border-color:rgba(16, 185, 129, 0.3);
      box-shadow:0 0 6px rgba(16, 185, 129, 0.15);
    }
    .acc-proxy-badge.error{
      color:#ff4b6e;
      background:rgba(255, 75, 110, 0.06);
      border-color:rgba(255, 75, 110, 0.18);
    }
    .acc-proxy-badge.error:hover{
      background:rgba(255, 75, 110, 0.12);
      border-color:rgba(255, 75, 110, 0.3);
      box-shadow:0 0 6px rgba(255, 75, 110, 0.15);
    }
    .acc-group-header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:8px 12px;
      background:rgba(255, 255, 255, 0.02);
      border-radius:8px;
      margin-top:14px;
      margin-bottom:8px;
      cursor:pointer;
      user-select:none;
      transition:background .2s, border-color .2s;
      border:1px solid rgba(255, 255, 255, 0.02);
    }
    .acc-group-header:hover{
      background:rgba(255, 255, 255, 0.04);
      border-color:rgba(255, 255, 255, 0.05);
    }
    .acc-group-arrow{
      font-size:9px;
      transition:transform .2s ease;
      display:inline-block;
      color:var(--muted);
    }
    .acc-group-arrow.collapsed{
      transform:rotate(-90deg);
    }
    .acc-group-title{
      font-weight:600;
      font-size:12px;
      color:var(--muted);
      letter-spacing:0.5px;
      text-transform:uppercase;
    }
    .acc-group-badge{
      font-size:10px;
      background:rgba(110, 146, 184, 0.1);
      color:var(--muted);
      padding:1px 6px;
      border-radius:8px;
    }
    .acc-group-content{
      display:flex;
      flex-direction:column;
      gap:1px;
      transition:all .2s ease;
    }
    .acc-group-content.collapsed{
      display:none;
    }
    .acc-editor-row.is-active{
      border-color:rgba(0, 240, 255, 0.15);
      background:rgba(0, 240, 255, 0.02);
    }
    .acc-editor-row.is-active:hover{
      border-color:rgba(0, 240, 255, 0.3);
      background:rgba(0, 240, 255, 0.04);
    }
    .acc-st.running{
      color:var(--cyan);
      font-weight:600;
    }
    /* Toggle switch */
    .toggle{position:relative;display:inline-flex;width:40px;height:22px;flex-shrink:0}
    .toggle input{opacity:0;width:0;height:0;position:absolute}
    .toggle-slider{position:absolute;inset:0;background:rgba(110,146,184,.2);border-radius:999px;cursor:pointer;transition:background .18s}
    .toggle-slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .18s;box-shadow:0 1px 4px rgba(0,0,0,.25)}
    .toggle input:checked + .toggle-slider{background:var(--blue)}
    .toggle input:checked + .toggle-slider:before{transform:translateX(18px)}
    .toggle-wrap{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid var(--border);transition:border-color .15s}
    .toggle-wrap:hover{border-color:rgba(30,155,255,.25)}
    .toggle-wrap-left{flex:1;min-width:0}
    .toggle-label{font-size:13px;font-weight:600}
    .toggle-sub{font-size:11.5px;color:var(--muted);margin-top:2px}
    /* Settings two-column layout */
    .settings-wrap{display:none;flex-direction:row;min-height:0;flex:1;overflow:hidden}
    .settings-wrap.vis{display:flex}
    .sett-sidebar{width:188px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;padding:10px 8px;gap:1px;background:rgba(2,7,16,.25)}
    .sett-nav-section{font-size:9px;font-weight:800;color:rgba(110,146,184,.35);letter-spacing:.12em;text-transform:uppercase;padding:10px 10px 3px;margin-top:2px;user-select:none}
    .sett-nav-section:first-child{padding-top:3px;margin-top:0}
    .sett-nav-item{display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border-radius:8px;border:none;background:none;color:rgba(110,146,184,.7);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;text-align:left;transition:all .14s;position:relative}
    .sett-nav-item:hover{background:rgba(255,255,255,.04);color:var(--text)}
    .sett-nav-item.active{background:rgba(46,232,255,.1);color:var(--cyan)}
    .sett-nav-item.active::before{content:'';position:absolute;left:0;top:25%;bottom:25%;width:2.5px;border-radius:2px;background:var(--cyan)}
    .sett-nav-item svg{width:15px;height:15px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
    .sett-nav-item.active svg{opacity:1}
    .sett-nav-badge{margin-left:auto;font-size:8.5px;font-weight:800;letter-spacing:.04em;padding:2px 5px;border-radius:4px}
    .sett-nav-badge-gold{background:rgba(247,200,92,.14);color:var(--gold);border:1px solid rgba(247,200,92,.2)}
    .sett-nav-badge-green{background:rgba(47,210,125,.12);color:var(--green);border:1px solid rgba(47,210,125,.22)}
    .sett-body{flex:1;min-width:0;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column}
    .sett-panel{display:none;flex-direction:column;gap:14px;animation:viewIn .18s ease-out}
    .sett-panel.active{display:flex}
    .sett-panel-header{margin-bottom:4px}
    .sett-panel-title{font-size:17px;font-weight:800;color:var(--text);letter-spacing:-.02em;margin-bottom:3px}
    .sett-panel-sub{font-size:12.5px;color:var(--muted);line-height:1.5}
    .settings-section{background:rgba(8,18,35,.55);border:1px solid var(--border);border-radius:12px;padding:16px;transition:border-color .15s}
    .settings-section:hover{border-color:rgba(46,232,255,.16)}
    .settings-section h3{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.09em;margin-bottom:12px;display:flex;align-items:center;gap:6px}
    .settings-section-core{border-color:rgba(247,200,92,.18);background:rgba(20,14,2,.5)}
    .settings-section-core h3{color:rgba(247,200,92,.7)}
    .core-section-badge{font-size:8.5px;font-weight:800;letter-spacing:.05em;padding:2px 6px;border-radius:4px;background:rgba(247,200,92,.14);color:var(--gold);border:1px solid rgba(247,200,92,.28);margin-left:auto}
    .settings-section-note{font-size:12px;color:var(--muted);background:rgba(46,232,255,.04);border:1px solid rgba(46,232,255,.1);border-radius:8px;padding:9px 12px;margin-bottom:12px;line-height:1.5}
    /* Hint system */
    .hint-bar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%) translateY(10px);display:inline-flex;align-items:center;gap:8px;background:rgba(4,12,28,.97);border:1px solid rgba(46,232,255,.28);border-radius:10px;padding:8px 10px 8px 12px;font-size:12px;font-weight:500;color:var(--text);opacity:0;pointer-events:none;transition:opacity .22s,transform .22s;z-index:50;box-shadow:0 8px 28px rgba(0,0,0,.5);backdrop-filter:blur(14px);white-space:nowrap}
    .hint-bar.show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0)}
    .hint-bar-icon{flex-shrink:0;color:var(--cyan);display:flex}
    .hint-bar-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .hint-bar-close{background:none;border:none;color:rgba(110,146,184,.45);cursor:pointer;padding:0 0 0 10px;font-size:17px;line-height:1;transition:color .14s;flex-shrink:0}
    .hint-bar-close:hover{color:var(--text)}
    /* Inline settings panel hints */
    .sett-hint{display:none;align-items:flex-start;gap:9px;background:rgba(46,232,255,.04);border:1px solid rgba(46,232,255,.11);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--muted);line-height:1.6}
    .sett-hint.show{display:flex}
    .sett-hint svg{flex-shrink:0;color:var(--cyan);width:14px;height:14px;margin-top:1px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .sett-hint-close{background:none;border:none;color:rgba(110,146,184,.4);cursor:pointer;padding:0 0 0 8px;font-size:16px;line-height:1;flex-shrink:0;margin-left:auto;transition:color .14s}
    .sett-hint-close:hover{color:var(--text)}
    /* Notification dedicated pages */
    .notif-page-head{display:flex;align-items:center;gap:16px;padding:18px 24px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;flex-shrink:0}
    .notif-page-identity{display:flex;align-items:center;gap:14px;flex:1;min-width:0}
    .notif-page-icon{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);flex-shrink:0}
    .notif-page-icon svg{width:20px;height:20px}
    .notif-page-title{font-size:17px;font-weight:800;letter-spacing:-.02em}
    .notif-page-sub{font-size:12px;color:var(--muted);margin-top:2px}
    .notif-page-toggle{display:flex;align-items:center;gap:9px;flex-shrink:0;font-size:13px;font-weight:600;color:var(--muted)}
    .notif-page-body{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
    /* Notification channel nav buttons (in settings panel) */
    .notif-nav-btn{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;border-radius:11px;border:1px solid var(--border);background:rgba(255,255,255,.02);cursor:pointer;transition:all .15s;color:var(--text);font:inherit;text-align:left}
    .notif-nav-btn:hover{border-color:rgba(46,232,255,.28);background:rgba(46,232,255,.05)}
    .notif-nav-btn-icon{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.08);flex-shrink:0}
    .notif-nav-btn-icon svg{width:18px;height:18px}
    .notif-nav-btn-info{flex:1;min-width:0}
    .notif-nav-btn-name{font-size:13px;font-weight:600}
    .notif-nav-btn-sub{font-size:11.5px;color:var(--muted);margin-top:1px}
    .notif-nav-btn-arrow{color:var(--muted);font-size:18px;margin-left:auto;flex-shrink:0;line-height:1}
    /* Context menu additions */
    .ctx-sep{height:1px;background:rgba(255,255,255,.07);margin:4px 5px}
    .ctx-item-danger,.ctx-item-danger svg{color:#ff4b6e}
    .ctx-item-danger:hover{background:rgba(255,75,110,.1);color:#ff4b6e}
    /* Reset config inline warning */
    .reset-warning{background:rgba(255,170,0,.07);border:1px solid rgba(255,170,0,.24);border-radius:10px;padding:12px 14px;font-size:12.5px;color:#f5c542;line-height:1.55;margin-top:12px}
    .reset-warning p{margin:0 0 10px}
    .reset-warning-actions{display:flex;gap:8px;flex-wrap:wrap}
    .btn-danger-sm{padding:6px 14px;border-radius:8px;background:#f5c542;color:#0d0a00;border:none;font:inherit;font-size:12px;font-weight:800;cursor:pointer;transition:filter .15s}
    .btn-danger-sm:hover{filter:brightness(1.1)}
    .btn-danger-sm:disabled{opacity:.5;cursor:default}
    .core-view{display:none;flex-direction:column;gap:28px;padding:28px;overflow-y:auto;flex:1}
    .core-view.vis{display:flex}
    /* ── Insights page ── */
    .ins-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .ins-title{font-size:clamp(18px,1.8vw,24px);font-weight:800;letter-spacing:-.01em}
    .ins-sub{font-size:12px;color:var(--muted);margin-top:3px}
    .ins-empty{color:var(--muted);font-size:13px;padding:34px 0;text-align:center}
    #ins-body{display:flex;flex-direction:column;gap:16px}
    .ins-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    .ins-kpi{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:14px;padding:13px 15px}
    .ins-kpi-val{font-size:clamp(17px,1.6vw,23px);font-weight:800}
    .ins-kpi-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:3px;font-weight:700}
    .ins-card{background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:16px;padding:16px 18px}
    .ins-card-title{font-size:13px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .ins-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .ins-chart{display:flex;align-items:flex-end;gap:3px;height:132px}
    .ins-bar{flex:1;min-width:3px;background:linear-gradient(180deg,var(--cyan,#2ee8ff),rgba(46,232,255,.22));border-radius:3px 3px 0 0;transition:opacity .15s}
    .ins-bar:hover{opacity:.7}
    .ins-bar-empty{background:rgba(255,255,255,.05)}
    .ins-acc{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.5px}
    .ins-acc:last-child{border-bottom:none}
    .ins-acc-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
    .ins-acc-meta{font-size:10.5px;color:var(--muted)}
    .ins-acc-pts{font-weight:700;color:var(--cyan,#2ee8ff)}
    .ins-acc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    .ins-dot-ok{background:var(--green,#2fd27d)}
    .ins-dot-failing{background:var(--red,#ff5a6a)}
    .ins-dot-idle{background:var(--gold,#f7c85c)}
    .ins-reco-card{position:relative}
    .ins-reco{display:flex;flex-direction:column;gap:10px}
    .ins-reco-item{border:1px solid var(--border);border-left-width:3px;border-radius:10px;padding:10px 12px}
    .ins-reco-high{border-left-color:var(--red,#ff5a6a)}
    .ins-reco-medium{border-left-color:var(--gold,#f7c85c)}
    .ins-reco-low{border-left-color:var(--green,#2fd27d)}
    .ins-reco-t{font-weight:700;font-size:12.5px}
    .ins-reco-d{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.45}
    .ins-lock{position:absolute;inset:0;background:rgba(8,14,24,.74);backdrop-filter:blur(3px);border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;padding:20px}
    .ins-lock-t{font-weight:800;color:var(--gold,#f7c85c);font-size:14px}
    .ins-lock-d{font-size:12px;color:var(--muted);max-width:270px;line-height:1.5}
    @media (max-width:720px){.ins-kpis{grid-template-columns:1fr 1fr}.ins-grid{grid-template-columns:1fr}}
    .core-hero{background:linear-gradient(135deg,rgba(10,22,40,.98) 0%,rgba(5,12,24,1) 100%);border:1px solid rgba(247,200,92,.2);border-radius:16px;padding:36px 32px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px}
    .core-hero-badge{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:3px 10px;border-radius:100px;background:rgba(247,200,92,.15);color:var(--gold);border:1px solid rgba(247,200,92,.3)}
    .core-hero-title{font-size:2.2rem;font-weight:800;letter-spacing:-.03em;color:var(--text);line-height:1.1}
    .core-hero-title span{color:var(--gold)}
    .core-hero-sub{font-size:14px;color:var(--muted);max-width:560px;line-height:1.6}
    .core-hero-actions{display:flex;align-items:center;gap:12px;margin-top:6px;flex-wrap:wrap;justify-content:center}
    .btn-core-cta{padding:11px 24px;border-radius:10px;background:var(--gold);color:#0d0a00;font-size:13.5px;font-weight:700;border:none;cursor:pointer;transition:all .16s ease}
    .btn-core-cta:hover{background:#ffe082;box-shadow:0 0 20px rgba(247,200,92,.35);transform:translateY(-1px)}
    .btn-core-discord{display:flex;align-items:center;gap:8px;padding:10px 18px;border-radius:10px;border:1px solid rgba(88,101,242,.3);background:rgba(88,101,242,.14);color:#bcc3ff;font-size:13px;font-weight:600;cursor:pointer;transition:all .16s ease}
    .btn-core-discord:hover{background:rgba(88,101,242,.28);color:#fff}
    .core-features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
    .core-feature{background:rgba(10,22,40,.9);border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:9px;transition:border-color .16s ease}
    .core-feature:hover{border-color:rgba(247,200,92,.25)}
    .core-feature-icon{width:36px;height:36px;border-radius:10px;background:rgba(247,200,92,.1);border:1px solid rgba(247,200,92,.2);display:flex;align-items:center;justify-content:center;color:var(--gold)}
    .core-feature-icon svg{width:18px;height:18px;stroke:var(--gold)}
    .core-feature-title{font-size:13px;font-weight:700;color:var(--text)}
    .core-feature-desc{font-size:12px;color:var(--muted);line-height:1.55}
    .core-remote-band{display:flex;align-items:center;gap:16px;background:linear-gradient(135deg,rgba(30,155,255,.1),rgba(46,232,255,.05));border:1px solid rgba(46,232,255,.22);border-radius:14px;padding:18px 22px;flex-wrap:wrap}
    .core-remote-ico{width:42px;height:42px;border-radius:11px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--cyan);background:rgba(46,232,255,.1);border:1px solid rgba(46,232,255,.2)}
    .core-remote-ico svg{width:22px;height:22px}
    .core-remote-txt{flex:1;min-width:200px}
    .core-remote-title{font-size:14px;font-weight:700;color:var(--text)}
    .core-remote-sub{font-size:12.5px;color:var(--muted);margin-top:3px}
    .core-remote-link{flex-shrink:0;padding:10px 18px;border-radius:10px;border:1px solid rgba(46,232,255,.4);background:rgba(46,232,255,.12);color:var(--cyan);font:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:all .16s ease}
    .core-remote-link:hover{background:rgba(46,232,255,.22);box-shadow:0 0 18px rgba(46,232,255,.25)}
    .core-footer-cta{background:rgba(247,200,92,.06);border:1px solid rgba(247,200,92,.18);border-radius:14px;padding:24px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
    .core-footer-cta p{font-size:13px;color:var(--muted);margin:0}
    /* ── Core sales page (shown when no license) ──────────────────── */
    .csell-section{display:flex;flex-direction:column}
    .csell-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin-bottom:8px}
    .csell-h2{font-size:clamp(20px,2vw,28px);font-weight:800;letter-spacing:-.02em;line-height:1.15;margin:0 0 10px}
    .csell-lead{font-size:14px;color:var(--muted);line-height:1.65;max-width:680px;margin:0}
    /* Hero */
    .csell-hero{position:relative;overflow:hidden;border-radius:20px;border:1px solid rgba(247,200,92,.28);background:radial-gradient(120% 130% at 82% -10%,rgba(247,200,92,.16),transparent 55%),linear-gradient(135deg,rgba(20,15,4,.96),rgba(6,9,16,.99));padding:clamp(28px,4vw,52px) clamp(24px,4vw,52px)}
    .csell-hero-inner{position:relative;z-index:1;max-width:660px;display:flex;flex-direction:column;align-items:flex-start}
    .csell-badge{display:inline-flex;align-items:center;gap:7px;font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:5px 12px;border-radius:100px;background:rgba(247,200,92,.14);color:var(--gold);border:1px solid rgba(247,200,92,.32);margin-bottom:18px}
    .csell-badge svg{width:13px;height:13px;fill:currentColor}
    .csell-title{font-size:clamp(30px,4.4vw,50px);font-weight:900;letter-spacing:-.03em;line-height:1.05;margin:0}
    .csell-title span{background:linear-gradient(90deg,var(--gold),#ffe9a8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
    .csell-sub{font-size:clamp(14px,1.3vw,16px);color:#c7d2e2;line-height:1.6;margin:16px 0 0;max-width:560px}
    .csell-value{display:flex;align-items:center;gap:15px;margin:26px 0 2px;padding:16px 22px;border-radius:16px;background:rgba(247,200,92,.07);border:1px solid rgba(247,200,92,.22)}
    .csell-value-num{font-size:clamp(28px,3.4vw,40px);font-weight:900;color:var(--gold);line-height:1;letter-spacing:-1px;white-space:nowrap}
    .csell-value-lbl{font-size:12px;color:rgba(247,212,142,.85);font-weight:600;line-height:1.45}
    .csell-hero-cta{display:flex;flex-wrap:wrap;gap:11px;margin-top:26px}
    .btn-csell-primary{display:inline-flex;align-items:center;gap:8px;padding:13px 26px;border-radius:12px;border:none;cursor:pointer;font-size:14.5px;font-weight:800;background:linear-gradient(135deg,#e6ac00,#f5c518 55%,#ffd75e);color:#1a1300;box-shadow:0 10px 30px rgba(230,172,0,.3);transition:transform .15s,box-shadow .15s,filter .15s}
    .btn-csell-primary:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(230,172,0,.42);filter:brightness(1.05)}
    .btn-csell-primary svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
    .btn-csell-ghost{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;border-radius:12px;cursor:pointer;font-size:14px;font-weight:700;background:rgba(88,101,242,.14);border:1px solid rgba(88,101,242,.34);color:#c4cbff;transition:background .15s,border-color .15s,color .15s}
    .btn-csell-ghost:hover{background:rgba(88,101,242,.26);color:#fff;border-color:rgba(88,101,242,.5)}
    .btn-csell-ghost svg{width:16px;height:16px;fill:currentColor}
    .csell-trust{margin-top:18px;font-size:12px;color:var(--muted);opacity:.85}
    /* Value strip */
    .csell-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .csell-strip-item{text-align:center;padding:18px 12px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--border)}
    .csell-strip-num{font-size:clamp(22px,2.4vw,30px);font-weight:900;color:var(--gold);line-height:1;letter-spacing:-.5px}
    .csell-strip-lbl{font-size:11.5px;color:var(--muted);margin-top:6px;font-weight:600;line-height:1.35}
    @media (max-width:680px){.csell-strip{grid-template-columns:repeat(2,1fr)}}
    /* Comparison table */
    .ccompare{border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-top:4px}
    .ccompare-row{display:grid;grid-template-columns:1fr 88px 88px;align-items:center}
    .ccompare-row+.ccompare-row{border-top:1px solid rgba(255,255,255,.05)}
    .ccompare-feat{padding:13px 18px;font-size:13.5px;font-weight:600;color:var(--text)}
    .ccompare-free,.ccompare-core{padding:13px 10px;text-align:center}
    .ccompare-core{background:rgba(247,200,92,.05)}
    .ccompare-head .ccompare-feat,.ccompare-head .ccompare-free,.ccompare-head .ccompare-core{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
    .ccompare-head .ccompare-core{color:var(--gold)}
    .ccompare-head{background:rgba(255,255,255,.02)}
    .cmark{width:18px;height:18px;display:inline-block;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle}
    .cmark-yes{stroke:var(--green)}
    .cmark-no{stroke:rgba(110,146,184,.35)}
    /* Steps */
    .csteps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:4px}
    .cstep{padding:22px 20px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid var(--border)}
    .cstep-n{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#1a1300;background:linear-gradient(135deg,#e6ac00,#f5c518);margin-bottom:13px}
    .cstep-t{font-size:14.5px;font-weight:700;margin-bottom:5px}
    .cstep-d{font-size:12.5px;color:var(--muted);line-height:1.55}
    @media (max-width:680px){.csteps{grid-template-columns:1fr}}
    /* FAQ */
    .cfaq{display:flex;flex-direction:column;gap:8px;margin-top:4px}
    .cfaq-item{border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02);overflow:hidden;transition:border-color .15s}
    .cfaq-item[open]{border-color:rgba(247,200,92,.22)}
    .cfaq-item>summary{list-style:none;cursor:pointer;padding:14px 16px;font-size:13.5px;font-weight:700;color:var(--text);display:flex;align-items:center;justify-content:space-between;gap:10px;user-select:none}
    .cfaq-item>summary::-webkit-details-marker{display:none}
    .cfaq-item>summary:after{content:'+';font-size:19px;color:var(--gold);font-weight:400;transition:transform .2s;flex-shrink:0;line-height:1}
    .cfaq-item[open]>summary:after{transform:rotate(45deg)}
    .cfaq-item p{margin:0;padding:0 16px 15px;font-size:13px;color:var(--muted);line-height:1.6}
    /* Final CTA */
    .csell-final{text-align:center;border-radius:20px;padding:clamp(28px,4vw,46px);border:1px solid rgba(247,200,92,.28);background:radial-gradient(100% 140% at 50% 0%,rgba(247,200,92,.14),transparent 60%),rgba(10,8,2,.6);display:flex;flex-direction:column;align-items:center;gap:14px}
    .csell-final h2{font-size:clamp(22px,2.4vw,32px);font-weight:900;letter-spacing:-.02em;margin:0}
    .csell-final p{font-size:14px;color:var(--muted);margin:0;max-width:480px;line-height:1.6}
    .toggle-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .toggle-grid-1{display:flex;flex-direction:column;gap:8px}
    .startup-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .startup-card{
      position:relative;display:flex;align-items:center;gap:13px;padding:14px;
      border-radius:12px;border:1px solid var(--border);
      background:linear-gradient(135deg,rgba(30,155,255,.06),rgba(255,255,255,.018));
      transition:all .2s ease;overflow:hidden;
    }
    .startup-card:hover{border-color:rgba(46,232,255,.28);transform:translateY(-1px)}
    .startup-card.core-only{border-color:rgba(247,200,92,.2);background:linear-gradient(135deg,rgba(247,200,92,.075),rgba(255,255,255,.018))}
    .startup-card.core-only:hover{border-color:rgba(247,200,92,.38)}
    .startup-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(46,232,255,.08);color:var(--cyan);border:1px solid rgba(46,232,255,.16)}
    .startup-card.core-only .startup-icon{background:rgba(247,200,92,.1);color:var(--gold);border-color:rgba(247,200,92,.2)}
    .startup-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .startup-copy{flex:1;min-width:0}
    .startup-badge{display:inline-flex;margin-left:6px;font-size:8px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--gold)}
    .startup-method{font-size:10px;color:rgba(110,146,184,.7);margin-top:4px}
    .view-animate{animation:viewIn .24s cubic-bezier(.2,.8,.2,1)}
    body.core-enhanced .hero,body.core-enhanced .cmember-hero{animation:coreAura 4s ease-in-out infinite}
    body.core-enhanced .nav-item-core{background:linear-gradient(90deg,rgba(247,200,92,.1),transparent)}
    /* Configurable row (toggle + Configure button) */
    .cfg-wrap{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid var(--border);transition:border-color .15s}
    .cfg-wrap:hover{border-color:rgba(30,155,255,.25)}
    .cfg-wrap .toggle-wrap-left{flex:1;min-width:0}
    .btn-cfg{flex-shrink:0;display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--muted);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s}
    .btn-cfg:hover{color:var(--text);border-color:rgba(46,232,255,.35);background:rgba(46,232,255,.08)}
    .btn-cfg:before{content:'';width:12px;height:12px;background-size:contain;background-repeat:no-repeat;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236e92b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Cpath d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/%3E%3C/svg%3E")}
    /* Config modal */
    .cfg-field{margin-bottom:12px}
    .cfg-field label{display:block;font-size:11px;color:var(--muted);margin-bottom:5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
    .cfg-field .cfg-hint{font-size:11px;color:rgba(110,146,184,.7);font-weight:400;text-transform:none;letter-spacing:0;margin-top:4px}
    .cfg-input{width:100%;background:rgba(2,7,16,.7);border:1px solid var(--border);border-radius:9px;padding:10px 12px;color:var(--text);font:inherit;font-size:13.5px;outline:none;transition:border-color .15s}
    .cfg-input:focus{border-color:var(--cyan)}
    .cfg-input::placeholder{color:rgba(110,146,184,.4)}
    select.cfg-input option{background:#07111f;color:var(--text)}
    .cfg-check{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:9px;background:rgba(255,255,255,.025);border:1px solid var(--border)}
    .cfg-check span{font-size:13px;font-weight:600}
    .cfg-adv{margin-top:6px;border-top:1px solid var(--border);padding-top:12px}
    .cfg-adv>summary{cursor:pointer;font-size:11.5px;font-weight:700;color:var(--cyan);text-transform:uppercase;letter-spacing:.05em;list-style:none;display:flex;align-items:center;gap:6px;margin-bottom:12px;user-select:none}
    .cfg-adv>summary::-webkit-details-marker{display:none}
    .cfg-adv>summary:before{content:'▸';transition:transform .15s;display:inline-block}
    .cfg-adv[open]>summary:before{transform:rotate(90deg)}
    /* Account edit modal */
    .modal-field{margin-bottom:0}
    .modal-field label{display:block;font-size:12px;color:rgba(255,255,255,.65);margin-bottom:6px;font-weight:600;letter-spacing:.01em}
    .modal-pw{position:relative;display:flex;align-items:center}
    .modal-pw .modal-input{padding-right:42px;width:100%}
    .modal-pw-toggle{position:absolute;right:12px;background:none;border:none;color:var(--muted);cursor:pointer;padding:2px;display:flex;transition:color .15s}
    .modal-pw-toggle:hover{color:var(--text)}
    .modal-pw-toggle svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .acc-modal{width:min(560px,96vw);max-height:92vh;overflow-y:auto;background:none;border:none;padding:0;border-radius:24px}
    .acc-modal-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
    .acc-modal-avatar{width:46px;height:46px;border-radius:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#04101e;background:linear-gradient(145deg,var(--blue),var(--cyan));box-shadow:0 8px 22px rgba(30,155,255,.28);overflow:hidden}
    .acc-modal-head h2{font-size:20px;font-weight:800;margin:0}
    .acc-modal-sub{font-size:12.5px;color:var(--muted);margin:2px 0 0}
    .lbl-opt{opacity:.55;font-weight:400;text-transform:none;letter-spacing:0}
    .acc-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .acc-sub-head{font-size:10.5px;font-weight:700;color:var(--cyan);text-transform:uppercase;letter-spacing:.08em;margin:14px 0 8px}
    .acc-form-section-head{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--cyan);text-transform:uppercase;letter-spacing:.08em;padding-bottom:10px;border-bottom:1px solid rgba(46,232,255,.12);margin-bottom:2px}
    .acc-form-section-head svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
    .acc-adv{margin-top:4px}
    .acc-adv .cfg-check{height:42px}
    /* Sidebar action buttons */
    .sidebar-actions{padding:12px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:7px}
    .btn-action-run{
      display:flex;align-items:center;gap:9px;width:100%;padding:11px 14px;
      border-radius:10px;border:none;
      background:linear-gradient(135deg,var(--blue),#4f7cff);color:#fff;
      font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;
      transition:all .16s ease;box-shadow:0 6px 18px rgba(30,155,255,.22);
    }
    .btn-action-run:hover:not(:disabled){filter:brightness(1.12);box-shadow:0 8px 24px rgba(30,155,255,.36);transform:translateY(-1px)}
    .btn-action-run:disabled{opacity:.38;cursor:default;transform:none;filter:none}
    .btn-action-run svg{width:15px;height:15px;flex-shrink:0;fill:currentColor}
    .btn-action-stop{
      display:flex;align-items:center;gap:9px;width:100%;padding:9px 14px;
      border-radius:10px;border:1px solid rgba(255,107,138,.25);
      background:rgba(255,107,138,.07);color:var(--rose);
      font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:all .16s ease;
    }
    .btn-action-stop:hover:not(:disabled){background:rgba(255,107,138,.15);border-color:rgba(255,107,138,.42)}
    .btn-action-stop:disabled{opacity:.38;cursor:default}
    .btn-action-stop svg{width:14px;height:14px;flex-shrink:0;fill:currentColor}
    /* Settings inputs */
    .settings-field{display:flex;flex-direction:column;gap:5px}
    .settings-label{font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
    .settings-input{
      background:rgba(2,7,16,.7);border:1px solid var(--border);border-radius:8px;
      padding:8px 11px;color:var(--text);font:inherit;font-size:13px;
      outline:none;width:100%;transition:border-color .15s;
    }
    .settings-input:focus{border-color:var(--cyan)}
    .settings-input option{background:#07111f}
    .settings-input-row{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    .scheduler-fields{display:flex;flex-direction:column;gap:9px;padding:12px 14px;background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:10px;margin-top:2px}
    .scheduler-fields.hidden{display:none}

    /* ── Core activation overlay ───────────────────────────────────── */
    .lic-overlay{
      display:none;position:fixed;inset:0;z-index:200;
      background:rgba(0,3,8,.9);backdrop-filter:blur(22px);
      place-items:center;padding:20px;
    }
    .lic-overlay.open{display:grid;animation:licFadeIn .3s ease-out}
    @keyframes licFadeIn{from{opacity:0}to{opacity:1}}
    .lic-card{
      width:min(490px,100%);position:relative;
      background:linear-gradient(180deg,rgba(6,14,30,.99),rgba(2,7,18,.99));
      border:1px solid rgba(46,232,255,.16);border-radius:22px;
      overflow:hidden;box-shadow:0 60px 130px rgba(0,0,0,.75);
      animation:licCardIn .34s cubic-bezier(.22,.68,0,1.08);
    }
    @keyframes licCardIn{
      from{opacity:0;transform:translateY(34px) scale(.96)}
      to{opacity:1;transform:none}
    }
    .lic-banner-wrap{
      position:relative;height:155px;overflow:hidden;
      background:linear-gradient(135deg,#020810,#041020);
    }
    .lic-banner-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 30%;opacity:.5}
    .lic-banner-tint{
      position:absolute;inset:0;
      background:linear-gradient(180deg,rgba(2,7,18,0) 30%,rgba(2,7,18,.97) 100%);
    }
    .lic-banner-badges{position:absolute;bottom:14px;left:20px;display:flex;align-items:center;gap:12px}
    .lic-banner-logo{width:42px;height:42px;border-radius:11px;box-shadow:0 6px 20px rgba(0,0,0,.55)}
    .lic-banner-title{font-size:17px;font-weight:800;color:#fff;line-height:1.2}
    .lic-banner-ver{font-size:11.5px;color:rgba(110,146,184,.75);margin-top:2px}
    .lic-body{padding:22px 26px 28px}
    .lic-body h2{font-size:21px;font-weight:800;margin-bottom:8px;line-height:1.25}
    .lic-body>div>p{font-size:13.5px;color:var(--muted);line-height:1.6;margin-bottom:18px}
    .lic-feats{
      display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:22px;
    }
    .lic-feat{
      display:flex;align-items:center;gap:8px;
      font-size:12px;font-weight:600;color:rgba(190,215,255,.8);
      background:rgba(255,255,255,.04);border:1px solid var(--border);
      border-radius:9px;padding:9px 11px;
    }
    .lic-feat svg{width:13px;height:13px;stroke:var(--cyan);flex-shrink:0;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .lic-actions{display:flex;flex-direction:column;gap:9px}
    .btn-lic-primary{
      width:100%;padding:13px;border-radius:12px;border:none;
      background:linear-gradient(135deg,var(--blue),#4f7cff);
      color:#fff;font:inherit;font-size:14px;font-weight:700;
      cursor:pointer;transition:all .16s ease;
      box-shadow:0 6px 20px rgba(30,155,255,.28);
    }
    .btn-lic-primary:hover:not(:disabled){filter:brightness(1.12);box-shadow:0 8px 28px rgba(30,155,255,.4);transform:translateY(-1px)}
    .btn-lic-primary:disabled{opacity:.45;cursor:default;transform:none;filter:none}
    .btn-lic-secondary{
      width:100%;padding:10px;border-radius:10px;
      border:1px solid var(--border);background:transparent;
      color:var(--muted);font:inherit;font-size:13px;cursor:pointer;
      transition:all .15s;
    }
    .btn-lic-secondary:hover{color:var(--text);border-color:rgba(110,146,184,.4);background:rgba(255,255,255,.04)}
    .btn-lic-danger{border-color:rgba(255,107,138,.3);color:#ff9eb2;background:rgba(255,107,138,.06)}
    .btn-lic-danger:hover{border-color:rgba(255,107,138,.55);color:#ffd4dd;background:rgba(255,107,138,.12)}
    .install-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0 18px}
    .install-status-item{padding:12px 8px;border:1px solid var(--border);border-radius:10px;text-align:center;background:rgba(255,255,255,.025)}
    .install-status-item b{display:block;font-size:12px;margin-bottom:4px}
    .install-status-item span{font-size:10.5px;color:var(--muted)}
    .install-status-item.ok{border-color:rgba(47,210,125,.28);background:rgba(47,210,125,.06)}
    .lic-key-input{
      width:100%;background:rgba(2,7,16,.7);
      border:1.5px solid var(--border);border-radius:11px;
      padding:13px 14px;color:var(--text);font:inherit;font-size:15px;
      letter-spacing:.07em;outline:none;transition:border-color .15s;
      text-align:center;text-transform:uppercase;margin-bottom:8px;
    }
    .lic-key-input:focus{border-color:var(--cyan)}
    .lic-key-input::placeholder{color:rgba(110,146,184,.32);letter-spacing:0;text-transform:none}
    .lic-key-input.shake{animation:licShake .32s ease}
    @keyframes licShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-9px)}40%,80%{transform:translateX(9px)}}
    .lic-error{min-height:18px;font-size:12px;color:var(--rose);margin-bottom:14px;line-height:1.4}
    .lic-back-row{
      display:inline-flex;align-items:center;gap:5px;
      margin-bottom:16px;cursor:pointer;
      color:var(--muted);font-size:12.5px;font-weight:600;transition:color .14s;
    }
    .lic-back-row:hover{color:var(--text)}
    .lic-back-row svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .lic-hint{text-align:center;margin-top:13px}
    .lic-hint a{font-size:12px;color:var(--muted);text-decoration:none;transition:color .14s}
    .lic-hint a:hover{color:var(--cyan)}
    /* Success */
    .lic-success-wrap{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:8px 0}
    .lic-success-ring{
      width:76px;height:76px;border-radius:50%;
      background:rgba(47,210,125,.1);border:2px solid rgba(47,210,125,.3);
      display:flex;align-items:center;justify-content:center;
      animation:licSuccessGlow 2.2s ease-in-out infinite;
    }
    @keyframes licSuccessGlow{
      0%,100%{box-shadow:0 0 0 0 rgba(47,210,125,0)}
      50%{box-shadow:0 0 0 18px rgba(47,210,125,.07)}
    }
    .lic-success-ring svg{
      width:38px;height:38px;fill:none;stroke:var(--green);
      stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;
      stroke-dasharray:65;stroke-dashoffset:0;
      animation:licCheckDraw .48s .08s cubic-bezier(.22,.68,0,1.22) both;
    }
    @keyframes licCheckDraw{from{stroke-dashoffset:65}to{stroke-dashoffset:0}}
    .lic-success-wrap h2{font-size:22px;font-weight:800;margin:0}
    .lic-success-plan{
      font-size:13px;color:var(--green);font-weight:700;
      background:rgba(47,210,125,.08);border:1px solid rgba(47,210,125,.2);
      border-radius:100px;padding:3px 14px;
    }
    .lic-success-expires{font-size:12px;color:var(--muted)}
    /* Confetti */
    .lic-confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:22px}
    .lic-confetti-dot{
      position:absolute;border-radius:2px;
      animation:licConfetti var(--cd) var(--cdelay) cubic-bezier(.2,.8,.4,1) both;
      opacity:0;
    }
    @keyframes licConfetti{
      0%{opacity:1;transform:translate(0,0) rotate(0deg) scale(1)}
      100%{opacity:0;transform:translate(var(--cx),var(--cy)) rotate(var(--cr)) scale(.6)}
    }
    /* Sidebar Core button */
    .lic-sidebar-btn{
      display:flex;align-items:center;gap:9px;
      width:100%;padding:9px 12px;border-radius:10px;
      border:1px solid rgba(247,200,92,.22);
      background:rgba(247,200,92,.06);
      color:rgba(247,200,92,.8);
      font:inherit;font-size:12.5px;font-weight:600;
      cursor:pointer;transition:all .16s ease;text-align:left;
    }
    .lic-sidebar-btn:hover{background:rgba(247,200,92,.14);border-color:rgba(247,200,92,.38);color:var(--gold)}
    .lic-sidebar-btn.active{border-color:rgba(47,210,125,.28);background:rgba(47,210,125,.07);color:var(--green)}
    .lic-sidebar-btn svg{width:14px;height:14px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .lic-sidebar-dot{width:6px;height:6px;border-radius:50%;background:currentColor;margin-left:auto;flex-shrink:0;opacity:.65}

    /* ── BETA badge ─────────────────────────────────────────────── */
    .beta-badge{
      display:inline-block;margin-left:6px;font-size:8.5px;font-weight:800;
      letter-spacing:.07em;padding:1px 5px;border-radius:4px;vertical-align:middle;
      background:rgba(167,139,250,.16);color:#c4b5fd;border:1px solid rgba(167,139,250,.35);
      text-transform:uppercase;
    }
    /* "Next only" badge — feature runs on the new (Next.js) dashboard only */
    .next-badge{
      display:inline-block;margin-left:6px;font-size:8.5px;font-weight:800;
      letter-spacing:.07em;padding:1px 5px;border-radius:4px;vertical-align:middle;
      background:rgba(46,232,255,.14);color:var(--cyan);border:1px solid rgba(46,232,255,.32);
      text-transform:uppercase;
    }
    /* Section header tag (FREE / CORE) */
    .sect-tag{
      font-size:9px;font-weight:800;letter-spacing:.06em;padding:2px 7px;border-radius:5px;
      margin-left:auto;text-transform:uppercase;
    }
    .sect-tag-free{background:rgba(46,232,255,.12);color:var(--cyan);border:1px solid rgba(46,232,255,.28)}
    /* Advanced settings */
    .settings-section-advanced{
      border-color:rgba(148,163,184,.18);
      background:linear-gradient(180deg,rgba(12,22,37,.92),rgba(7,14,27,.96));
    }
    .advanced-block{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
    .advanced-block + .advanced-block{margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
    .advanced-copy{flex:1;min-width:240px}
    .advanced-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
    .storage-state{
      display:inline-flex;align-items:center;gap:7px;margin-top:7px;padding:5px 9px;border-radius:8px;
      border:1px solid rgba(148,163,184,.18);background:rgba(148,163,184,.06);
      color:var(--muted);font-size:11.5px;line-height:1.4;
    }
    .storage-state:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0}
    .storage-state.ok{color:var(--green);border-color:rgba(47,210,125,.2);background:rgba(47,210,125,.07)}
    .storage-state.ok:before{background:var(--green);box-shadow:0 0 8px rgba(47,210,125,.55)}
    .storage-state.warn{color:var(--gold);border-color:rgba(247,200,92,.22);background:rgba(247,200,92,.07)}
    .storage-state.warn:before{background:var(--gold)}
    .advanced-caption{font-size:11px;color:var(--muted);margin-top:7px}
    .storage-panel{display:flex;align-items:center;gap:14px;flex:1;min-width:280px}
    .storage-shield{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--green);background:rgba(47,210,125,.08);border:1px solid rgba(47,210,125,.18)}
    .storage-shield svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8}
    .storage-tools{margin-top:12px;border-top:1px solid var(--border);padding-top:12px}
    .storage-tools>summary{cursor:pointer;color:var(--muted);font-size:11.5px;font-weight:700;list-style:none}
    .storage-tools>summary::-webkit-details-marker{display:none}
    .storage-tools[open]>summary{color:var(--cyan)}
    .storage-tools .advanced-actions{margin-top:11px;justify-content:flex-start}
    /* Advanced settings — single collapsible wrapper */
    .adv-collapse>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
    .adv-collapse>summary::-webkit-details-marker{display:none}
    .adv-collapse>summary:hover,.adv-collapse[open]>summary{color:var(--cyan)}
    .adv-collapse[open]>summary{margin-bottom:13px}
    .adv-collapse .adv-chevron{margin-left:auto;width:13px;height:13px;flex-shrink:0;transition:transform .2s ease}
    .adv-collapse[open] .adv-chevron{transform:rotate(180deg)}
    .adv-collapse .adv-group + .adv-group{margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}
    .term-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
    .term-row .toggle-wrap-left{flex:1;min-width:200px}
    @media (prefers-reduced-motion:reduce){
      *,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
    }

    /* ── Plugins page ────────────────────────────────────────────── */
    .plugins-wrap{display:none;flex-direction:column;min-height:0;flex:1;overflow:hidden}
    .plugins-wrap.vis{display:flex}
    /* Header */
    .plugins-head{padding:clamp(14px,1.8vh,20px) clamp(16px,1.8vw,24px) 0;flex-shrink:0;border-bottom:1px solid var(--border)}
    .plugins-head-top{display:flex;align-items:center;gap:13px}
    .plugins-head-ico{width:40px;height:40px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(46,232,255,.08);border:1px solid rgba(46,232,255,.18);color:var(--cyan)}
    .plugins-head-ico svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .plugins-head-titles{flex:1;min-width:0}
    .plugins-head-title{font-size:clamp(16px,1.5vw,20px);font-weight:800;letter-spacing:-.02em}
    .plugins-head-sub{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .plugins-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .plugins-search-wrap{position:relative;display:flex;align-items:center}
    .plugins-search-ico{position:absolute;left:11px;width:14px;height:14px;color:var(--muted);pointer-events:none;fill:none;stroke:currentColor;stroke-width:2}
    .plugins-search{width:clamp(150px,16vw,210px);padding:8px 12px 8px 32px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:12.5px;outline:none;transition:border-color .15s,background .15s,width .18s}
    .plugins-search:focus{border-color:rgba(46,232,255,.35);background:rgba(46,232,255,.04)}
    .plugins-search::placeholder{color:var(--muted)}
    .pbtn-icon{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
    .pbtn-icon:hover{color:var(--text);border-color:rgba(46,232,255,.3);background:rgba(46,232,255,.06)}
    .pbtn-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .pbtn-primary{display:inline-flex;align-items:center;gap:6px;padding:0 15px;height:34px;border-radius:9px;border:none;background:linear-gradient(135deg,var(--blue),#4f7cff);color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;transition:filter .15s,box-shadow .15s,transform .15s;flex-shrink:0;white-space:nowrap;box-shadow:0 4px 14px rgba(30,155,255,.25)}
    .pbtn-primary:hover{filter:brightness(1.08);transform:translateY(-1px);box-shadow:0 7px 20px rgba(30,155,255,.34)}
    .pbtn-primary svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    /* Tabs */
    .plugins-tabsrow{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:13px}
    .plugins-tabs{display:flex;gap:2px}
    .plugins-tab{position:relative;padding:9px 14px;border:none;background:none;color:var(--muted);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:color .15s;white-space:nowrap}
    .plugins-tab:hover{color:var(--text)}
    .plugins-tab.active{color:var(--cyan)}
    .plugins-tab.active::after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--cyan)}
    .ptxt-btn{font-size:12px;font-weight:600;color:var(--muted);background:none;border:none;cursor:pointer;padding:6px 4px;border-radius:6px;transition:color .15s;white-space:nowrap}
    .ptxt-btn:hover{color:var(--cyan)}
    .plugins-body{flex:1;overflow-y:auto;padding:18px clamp(16px,1.8vw,24px) 28px;display:flex;flex-direction:column;gap:18px;min-height:0}
    /* Core card — spacious feature card */
    .pcore-card{border-radius:15px;border:1px solid rgba(247,200,92,.26);background:linear-gradient(135deg,rgba(26,19,4,.98),rgba(9,6,1,.98));padding:17px 19px;display:flex;align-items:flex-start;gap:15px;position:relative;overflow:hidden;flex-shrink:0}
    .pcore-card::after{content:'';position:absolute;top:-45%;right:-8%;width:320px;height:230px;background:radial-gradient(ellipse,rgba(247,200,92,.07),transparent 62%);pointer-events:none}
    .pcore-ico{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,rgba(247,200,92,.18),rgba(247,200,92,.04));border:1px solid rgba(247,200,92,.3);display:flex;align-items:center;justify-content:center;color:var(--gold);flex-shrink:0;box-shadow:0 3px 14px rgba(247,200,92,.09)}
    .pcore-ico svg{width:21px;height:21px;fill:currentColor}
    .pcore-main{flex:1;min-width:0;position:relative;z-index:1}
    .pcore-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}
    .pcore-name{font-size:15.5px;font-weight:800;color:#fde8a6;letter-spacing:.01em}
    .pcore-head .pcore-side{margin-left:auto}
    .pcore-desc{font-size:11.5px;color:rgba(247,212,142,.58);line-height:1.5;margin-bottom:11px;max-width:470px}
    .pcore-feats{display:flex;flex-wrap:wrap;gap:5px}
    .pcore-feat{font-size:9.5px;font-weight:700;padding:3px 9px;border-radius:20px;background:rgba(247,200,92,.07);color:rgba(247,200,92,.72);border:1px solid rgba(247,200,92,.15)}
    .pcore-side{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .pcore-locked{font-size:10.5px;font-weight:600;color:rgba(247,200,92,.72);display:flex;align-items:center;gap:4px;white-space:nowrap}
    .pcore-locked svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2}
    /* Section header */
    .psection{display:flex;flex-direction:column;gap:11px}
    .psect{display:flex;align-items:center;gap:9px}
    .psect-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
    .psect-count{font-size:10.5px;font-weight:700;color:var(--cyan);background:rgba(46,232,255,.1);border:1px solid rgba(46,232,255,.18);border-radius:20px;padding:1px 8px;line-height:1.5}
    .psect-line{flex:1;height:1px;background:rgba(255,255,255,.06)}
    /* ── Unified plugin card (installed + store share one look) ── */
    .pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:11px}
    .pcard{display:flex;flex-direction:column;gap:9px;background:rgba(8,16,30,.55);border:1px solid var(--border);border-radius:14px;padding:14px 15px;transition:border-color .18s,transform .15s,box-shadow .18s}
    .pcard:hover{border-color:rgba(46,232,255,.22);transform:translateY(-2px);box-shadow:0 12px 30px rgba(0,0,0,.28)}
    .pcard.is-off{opacity:.62}
    .pcard.is-off:hover{opacity:1}
    .pcard-top{display:flex;align-items:center;gap:11px}
    .pcard-ico{width:38px;height:38px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(46,232,255,.07);border:1px solid rgba(46,232,255,.14);color:var(--cyan)}
    .pcard-ico svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .pcard-id{flex:1;min-width:0}
    .pcard-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pcard-author{font-size:11px;color:var(--muted);margin-top:2px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pcard-chips{display:flex;flex-wrap:wrap;gap:4px}
    .pcard-desc{font-size:12px;color:var(--muted);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:1;min-height:0}
    .pcard-desc-empty{font-style:italic;opacity:.4}
    .pcard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid rgba(255,255,255,.05);min-height:34px}
    .pcard-foot-l{display:flex;align-items:center;gap:13px;flex-wrap:wrap;min-width:0}
    .pcard-foot-r{display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:auto}
    /* Management checkboxes (store plugins) */
    .pmanage-trust{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:rgba(210,145,74,.9);cursor:pointer;user-select:none;white-space:nowrap}
    .pmanage-au{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap}
    .pmanage-trust input,.pmanage-au input{appearance:none;-webkit-appearance:none;margin:0;width:15px;height:15px;border-radius:4px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);cursor:pointer;position:relative;flex-shrink:0;transition:background .15s,border-color .15s}
    .pmanage-trust input:hover,.pmanage-au input:hover{border-color:rgba(255,255,255,.3)}
    .pmanage-trust input:checked{background:#d4914a;border-color:#d4914a}
    .pmanage-au input:checked{background:var(--cyan);border-color:var(--cyan)}
    .pmanage-trust input:checked::after,.pmanage-au input:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #0a0e15;border-width:0 2px 2px 0;transform:rotate(45deg)}
    /* Chips */
    .pchip{font-size:9px;font-weight:800;letter-spacing:.03em;padding:2px 6px;border-radius:5px;text-transform:uppercase;white-space:nowrap;border:1px solid}
    .pchip-official{background:rgba(247,200,92,.09);color:rgba(247,200,92,.85);border-color:rgba(247,200,92,.2)}
    .pchip-ver{background:transparent;color:rgba(110,146,184,.7);border-color:rgba(255,255,255,.08);text-transform:none;letter-spacing:0;font-size:9.5px}
    .pchip-installed{background:rgba(47,210,125,.07);color:rgba(47,210,125,.85);border-color:rgba(47,210,125,.18)}
    .pchip-trusted{background:rgba(210,145,74,.08);color:rgba(210,145,74,.85);border-color:rgba(210,145,74,.2)}
    .pchip-update{background:rgba(46,232,255,.07);color:var(--cyan);border-color:rgba(46,232,255,.18);text-transform:none;letter-spacing:0}
    .pchip-stale{background:rgba(247,200,92,.07);color:rgba(247,200,92,.75);border-color:rgba(247,200,92,.18);text-transform:none;letter-spacing:0}
    .pchip-off{background:transparent;color:rgba(110,146,184,.45);border-color:rgba(255,255,255,.07)}
    /* Action buttons */
    .pbtn{padding:6px 14px;font-size:11.5px;font-weight:700;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,filter .15s,opacity .15s;border:1px solid transparent;flex-shrink:0}
    .pbtn:disabled{opacity:.5;cursor:not-allowed}
    .pbtn-install{border-color:rgba(46,232,255,.3);background:rgba(46,232,255,.1);color:var(--cyan)}
    .pbtn-install:hover:not(:disabled){background:rgba(46,232,255,.18);border-color:rgba(46,232,255,.5)}
    .pbtn-update{border-color:rgba(46,232,255,.3);background:rgba(46,232,255,.1);color:var(--cyan)}
    .pbtn-update:hover:not(:disabled){background:rgba(46,232,255,.18);border-color:rgba(46,232,255,.5)}
    .pbtn-cfg{border-color:var(--border);background:rgba(255,255,255,.03);color:var(--muted)}
    .pbtn-cfg:hover:not(:disabled){background:rgba(255,255,255,.07);color:var(--text)}
    .pbtn-cfg.active{border-color:rgba(46,232,255,.4);background:rgba(46,232,255,.1);color:var(--cyan)}
    /* Per-plugin settings + read-only panel (the plugin's slice of THIS page — no new pages) */
    .pcard-panel{margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)}
    .pp-form{display:flex;flex-direction:column;gap:12px}
    .pp-field{display:flex;flex-direction:column;gap:5px}
    .pp-label{font-size:12px;font-weight:600;color:var(--text);display:flex;flex-direction:column;gap:2px}
    .pp-help{font-size:11px;font-weight:400;color:var(--muted)}
    .pp-input{padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:12.5px;outline:none;transition:border-color .15s,background .15s}
    .pp-input:focus{border-color:rgba(46,232,255,.4);background:rgba(46,232,255,.04)}
    .pp-switch{position:relative;display:inline-flex;width:38px;height:22px;cursor:pointer}
    .pp-switch input{position:absolute;opacity:0;width:0;height:0}
    .pp-switch-s{position:absolute;inset:0;border-radius:22px;background:rgba(255,255,255,.12);transition:background .15s}
    .pp-switch-s::before{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
    .pp-switch input:checked + .pp-switch-s{background:var(--cyan)}
    .pp-switch input:checked + .pp-switch-s::before{transform:translateX(16px)}
    .pp-form-actions{display:flex;align-items:center;gap:10px;margin-top:2px}
    .pp-saved{font-size:12px;font-weight:600;color:var(--green,#2fd27d)}
    .pp-out{margin-top:14px;padding:12px;border-radius:10px;background:rgba(46,232,255,.05);border:1px solid rgba(46,232,255,.14)}
    .pp-out-title{font-size:12px;font-weight:800;color:var(--text);margin-bottom:8px;letter-spacing:-.01em}
    .pp-out-stats{display:flex;flex-wrap:wrap;gap:14px}
    .pp-out-stat{min-width:70px}
    .pp-out-v{font-size:18px;font-weight:800;color:var(--cyan);letter-spacing:-.02em}
    .pp-out-l{font-size:11px;color:var(--muted);margin-top:1px}
    .pp-out-h{font-size:10.5px;color:var(--muted);opacity:.8}
    .pp-out-lines{margin-top:8px;display:flex;flex-direction:column;gap:3px}
    .pp-out-line{font-size:12px;color:var(--text)}
    .pp-out-ts{font-size:10.5px;color:var(--muted);margin-top:8px}
    /* Elevated permissions (net:*) consent block */
    .pp-perms{margin-bottom:14px;padding:12px;border-radius:10px;background:rgba(255,180,84,.06);border:1px solid rgba(255,180,84,.2)}
    .pp-perms-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#ffb454;margin-bottom:5px}
    .pp-perms-head svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .pp-perms-warn{font-size:11.5px;color:var(--muted);line-height:1.45;margin-bottom:10px}
    .pp-perm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06)}
    .pp-perm-host{font-size:12.5px;font-weight:700;color:var(--text);font-family:ui-monospace,monospace}
    .pp-perm-sub{font-size:11px;color:var(--muted);margin-top:1px}
    /* Icon links (report / remove) */
    .plink{font-size:11px;font-weight:600;color:var(--muted);background:none;border:none;cursor:pointer;padding:0;display:inline-flex;align-items:center;gap:4px;transition:color .15s,background .15s,border-color .15s}
    .plink:hover{color:var(--text)}
    .plink.danger:hover{color:var(--rose)}
    .plink-ico{width:30px;height:30px;border-radius:8px;justify-content:center;border:1px solid var(--border);background:rgba(255,255,255,.03)}
    .plink-ico:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14)}
    .plink-ico.danger:hover{background:rgba(255,107,138,.1);border-color:rgba(255,107,138,.25)}
    .plink-ico svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    /* Empty state */
    .pempty{padding:34px 20px;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.6;border:1px dashed rgba(255,255,255,.08);border-radius:12px;opacity:.75}

    /* ── Docs page ──────────────────────────────────────────────── */
    .docs-wrap{display:none;flex-direction:column;min-height:0;flex:1;gap:12px;overflow:hidden}
    .docs-wrap.vis{display:flex}
    .docs-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .docs-body{display:flex;gap:14px;flex:1;min-height:0}
    .docs-sidebar{width:210px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;border-right:1px solid var(--border);padding-right:10px;min-height:0}
    .docs-search{padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:12.5px;outline:none;transition:border-color .15s;width:100%;flex-shrink:0}
    .docs-search:focus{border-color:rgba(46,232,255,.3)}
    .docs-search::placeholder{color:var(--muted)}
    .docs-nav{overflow-y:auto;display:flex;flex-direction:column;gap:3px;flex:1}
    .docs-nav-item{
      padding:8px 11px;border-radius:8px;font-size:12.5px;color:var(--muted);
      cursor:pointer;transition:all .13s;border:1px solid transparent;
    }
    .docs-nav-item:hover{background:rgba(255,255,255,.04);color:var(--text)}
    .docs-nav-item.active{background:rgba(46,232,255,.1);color:var(--cyan);border-color:rgba(46,232,255,.2)}
    .docs-content{
      flex:1;overflow-y:auto;padding:6px 22px 30px;min-width:0;
      font-size:14px;line-height:1.7;color:#c2d4e6;
    }
    .docs-content h1{font-size:25px;font-weight:800;margin:14px 0 14px;color:#fff;border-bottom:1px solid var(--border);padding-bottom:10px}
    .docs-content h2{font-size:19px;font-weight:700;margin:26px 0 11px;color:#fff}
    .docs-content h3{font-size:15.5px;font-weight:700;margin:20px 0 8px;color:var(--cyan)}
    .docs-content p{margin:0 0 13px}
    .docs-content ul,.docs-content ol{margin:0 0 13px;padding-left:22px}
    .docs-content li{margin:4px 0}
    .docs-content a{color:var(--cyan);text-decoration:none}
    .docs-content a:hover{text-decoration:underline}
    .docs-content code{background:rgba(255,255,255,.07);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-family:"Cascadia Code",Consolas,monospace;font-size:12.5px;color:#ffd9a0}
    .docs-content pre{background:#020610;border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:0 0 14px}
    .docs-content pre code{background:none;border:none;padding:0;color:#9fe0ff}
    .docs-content table{border-collapse:collapse;width:100%;margin:0 0 14px;font-size:13px}
    .docs-content th,.docs-content td{border:1px solid var(--border);padding:7px 11px;text-align:left}
    .docs-content th{background:rgba(255,255,255,.04);font-weight:700}
    .docs-content blockquote{border-left:3px solid rgba(46,232,255,.4);margin:0 0 14px;padding:4px 16px;color:var(--muted);background:rgba(46,232,255,.04)}
    .docs-content hr{border:none;border-top:1px solid var(--border);margin:22px 0}
    .docs-loading{color:var(--muted);font-size:13px;padding:30px;text-align:center}
    @keyframes fadeInDoc{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    .docs-content{animation:fadeInDoc .18s ease}
    .docs-nav-section{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:14px 11px 4px;opacity:.55;pointer-events:none;user-select:none}
    .docs-nav-core{color:rgba(247,200,92,.85)}
    .docs-nav-core:hover{background:rgba(247,200,92,.07)!important;color:var(--gold)!important}
    .docs-nav-core.active{background:rgba(247,200,92,.12)!important;color:var(--gold)!important;border-color:rgba(247,200,92,.3)!important}
    .docs-content-core{border-left:2px solid rgba(247,200,92,.2);padding-left:20px}
    .docs-core-promo{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:linear-gradient(135deg,rgba(247,200,92,.1),rgba(247,200,92,.04));border:1px solid rgba(247,200,92,.25);border-radius:12px;padding:12px 16px;margin-bottom:20px}
    .docs-core-promo-left{display:flex;align-items:center;gap:10px}
    .docs-core-promo-badge{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:2px 8px;border-radius:100px;background:rgba(247,200,92,.2);color:var(--gold);border:1px solid rgba(247,200,92,.35)}
    .docs-core-promo-text{font-size:12.5px;color:var(--gold);font-weight:600}
    .docs-core-promo-btn{padding:6px 14px;border-radius:8px;background:var(--gold);color:#0d0a00;font-size:12px;font-weight:700;border:none;cursor:pointer;transition:all .15s ease;white-space:nowrap;flex-shrink:0}
    .docs-core-promo-btn:hover{background:#ffe082;box-shadow:0 0 14px rgba(247,200,92,.4)}
    .docs-badge-new{display:inline-flex;align-items:center;margin-left:6px;font-size:8px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:1px 5px;border-radius:100px;background:rgba(47,210,125,.2);color:var(--green);border:1px solid rgba(47,210,125,.3);vertical-align:middle;flex-shrink:0;line-height:1.4}
    .docs-nav-item-whats-new{color:var(--cyan)!important}
    .docs-nav-item-whats-new:hover{background:rgba(46,232,255,.06)!important;color:var(--cyan)!important}
    .docs-nav-item-whats-new.active{background:rgba(46,232,255,.1)!important;color:var(--cyan)!important;border-color:rgba(46,232,255,.2)!important}
    .code-block-wrap{position:relative}
    .code-copy-btn{position:absolute;top:8px;right:8px;padding:3px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.07);color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;opacity:0;font-family:inherit}
    .code-block-wrap:hover .code-copy-btn{opacity:1}
    .code-copy-btn:hover{background:rgba(255,255,255,.14);color:var(--text)}
    .code-copy-btn.copied{color:var(--green);border-color:rgba(47,210,125,.3);opacity:1}
    .core-expiry-band{display:none;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:linear-gradient(135deg,rgba(247,200,92,.09),rgba(247,200,92,.03));border:1px solid rgba(247,200,92,.25);border-radius:12px;padding:14px 18px}
    .core-expiry-left{flex:1;min-width:180px}
    .core-expiry-text{font-size:13.5px;color:var(--gold);font-weight:700}
    .core-expiry-sub{font-size:12px;color:var(--muted);margin-top:3px}
    .core-expiry-btn{flex-shrink:0;padding:8px 16px;border-radius:8px;background:var(--gold);color:#0d0a00;font-size:12.5px;font-weight:700;border:none;cursor:pointer;transition:all .15s ease;font-family:inherit}
    .core-expiry-btn:hover{background:#ffe082;box-shadow:0 0 14px rgba(247,200,92,.35)}
    .changelog-wrap{display:flex;flex-direction:column;gap:0}
    .changelog-entry{padding:13px 0;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start}
    .changelog-entry:last-child{border-bottom:none}
    .changelog-hash{font-family:"Cascadia Code",Consolas,monospace;font-size:10.5px;color:var(--muted);padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--border);white-space:nowrap;flex-shrink:0;margin-top:2px}
    .changelog-msg{font-size:13px;color:var(--text);line-height:1.55}
    .changelog-empty{color:var(--muted);font-size:13px;padding:24px 0;text-align:center}

    /* ── Core member (retention) view ───────────────────────────── */
    .cmember-hero{position:relative;overflow:hidden;border-radius:18px;border:1px solid rgba(47,210,125,.25);background:radial-gradient(120% 130% at 85% -20%,rgba(47,210,125,.14),transparent 55%),linear-gradient(135deg,rgba(8,20,14,.96),rgba(6,9,16,.99));padding:clamp(24px,3vw,34px)}
    .cmember-hero-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
    .cmember-badge{display:inline-flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:5px 12px;border-radius:100px;background:rgba(47,210,125,.14);color:var(--green);border:1px solid rgba(47,210,125,.32)}
    .cmember-badge-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 9px var(--green)}
    .cmember-status{font-size:12.5px;font-weight:700;color:var(--green);background:rgba(47,210,125,.08);border:1px solid rgba(47,210,125,.2);border-radius:100px;padding:4px 13px}
    .cmember-title{font-size:clamp(22px,2.6vw,32px);font-weight:900;letter-spacing:-.02em;line-height:1.1;margin:0}
    .cmember-title span{background:linear-gradient(90deg,var(--green),#8ff0bd);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
    .cmember-sub{font-size:14px;color:var(--muted);line-height:1.55;margin:10px 0 0;max-width:520px}
    .cmember-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
    .btn-cmember{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:11px;border:1px solid rgba(46,232,255,.3);background:rgba(46,232,255,.1);color:var(--cyan);font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}
    .btn-cmember:hover{background:rgba(46,232,255,.18);box-shadow:0 0 18px rgba(46,232,255,.2)}
    .btn-cmember svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .btn-cmember-ghost{padding:11px 18px;border-radius:11px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--muted);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s}
    .btn-cmember-ghost:hover{color:var(--text);border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06)}
    .core-real-card{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px 22px}
    .core-real-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;gap:10px}
    .core-real-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text)}
    .core-real-since{font-size:11.5px;color:var(--muted)}
    .core-real-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .core-real-stat{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:13px 14px}
    .core-real-val{font-size:1.5rem;font-weight:800;color:var(--text);line-height:1.1;letter-spacing:-.5px}
    .core-real-stat:first-child .core-real-val{color:var(--gold)}
    .core-real-lbl{font-size:11px;color:var(--muted);margin-top:3px}
    .core-real-empty{color:var(--muted);font-size:13px;padding:10px 2px 2px;line-height:1.5}
    @media (max-width:560px){.core-real-grid{grid-template-columns:repeat(2,1fr)}}
    .cmember-auto{border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.02);padding:18px 20px}
    .cmember-auto-head{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:13px}
    .cmember-auto-chips{display:flex;flex-wrap:wrap;gap:8px}
    .cmember-chip{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:#d6e4f2;padding:7px 13px;border-radius:100px;background:rgba(47,210,125,.06);border:1px solid rgba(47,210,125,.18)}
    .cmember-chip svg{width:13px;height:13px;fill:none;stroke:var(--green);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}

    /* Feedback Modal */
    .fb-modal-content h2{
      font-size:24px;font-weight:800;margin-bottom:8px;
      background:linear-gradient(to right,#fff,var(--cyan));
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
    }
    .rating-stars { display: flex; gap: 10px; justify-content: center; margin: 20px 0; }
    .rating-star { 
      width:36px;height:36px;color:rgba(110,146,184,.3);
      cursor:pointer;transition:transform .15s cubic-bezier(.22,.68,0,1.08), color .2s;
    }
    .rating-star svg { width:100%;height:100%;fill:currentColor; }
    .rating-star:hover, .rating-star.active { color: var(--gold); transform: scale(1.18); }
    .fb-textarea { 
      width: 100%; height: 90px; background: rgba(2,7,16,.7); border: 1px solid rgba(255,255,255,.08); 
      border-radius: 12px; padding: 12px 14px; color: var(--text); font: inherit; font-size: 14px; 
      outline: none; resize: none; margin-bottom: 24px; transition: border-color .2s, box-shadow .2s;
      box-shadow: inset 0 2px 6px rgba(0,0,0,.2);
    }
    .fb-textarea:focus { border-color: var(--cyan); background:rgba(255,255,255,.03); box-shadow:0 0 0 3px rgba(46,232,255,.15), inset 0 2px 6px rgba(0,0,0,.2); }
    .fb-textarea::placeholder { color:rgba(110,146,184,.4); }

    /* ── Mobile (Desk opened from a phone over the LAN) ────────────────────────
       The Desk targets a desktop window: a fixed-height flex row (sidebar + main)
       with an internal-scroll grid. On a narrow screen, stack the sidebar above the
       content and let the page flow & scroll naturally. First pass — some inner views
       use inline-styled grids that can't be reflowed from here. */
    @media (max-width: 720px) {
      html, body { height: auto; overflow: auto; }
      body { flex-direction: column; min-height: 100%; }
      .sidebar {
        width: 100%; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px;
        border-right: none; border-bottom: 1px solid var(--border);
        padding: 10px 12px;
      }
      .brand { flex: 1 1 100%; margin-bottom: 4px; padding-bottom: 8px; }
      nav { flex-direction: row; flex-wrap: wrap; flex: 1 1 100%; gap: 6px; }
      .nav-item { flex: 1 1 auto; justify-content: center; }
      .sidebar-bottom { flex: 1 1 100%; margin-top: 8px; flex-direction: row; flex-wrap: wrap; border-top: none; padding-top: 0; }
      .sidebar-bottom > * { flex: 1 1 auto; }
      .main { display: flex; flex-direction: column; overflow: visible; padding: 12px; gap: 12px; }
      .hero { min-height: 0; padding: 18px 16px; }
      /* Stack the desktop multi-column grids (class-based ones) on a narrow screen. */
      .toggle-grid, .startup-grid, .acc-grid-2, .settings-input-row, .mini-grid,
      .core-features, .core-real-grid, .install-status-grid, .csell-strip,
      .modal-actions, .lic-plan-grid { grid-template-columns: 1fr !important; }
    }
  </style>
</head>
<body>
  <div class="app-boot" id="app-boot">
    <div class="app-boot-card">
      <img src="/app-icon.png" class="app-boot-logo" alt="">
      <div class="app-boot-spinner"></div>
      <div class="app-boot-title">Preparing Rewards Desk</div>
      <div class="app-boot-detail" id="app-boot-detail">Loading accounts and Core status…</div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <aside class="sidebar">
    <div class="brand">
      <img src="/app-icon.png" alt="">
      <div><div class="brand-name">Rewards Desk</div><div class="brand-sub">command center</div></div>
    </div>
    <nav>
      <div class="nav-group">Monitor</div>
      <div class="nav-item active" id="nav-dash">
        <svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9 20v-5h6v5"/></svg>
        Home
      </div>
      <div class="nav-item" id="nav-accounts">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg>
        Accounts
      </div>
      <div class="nav-item" id="nav-console">
        <svg viewBox="0 0 24 24"><path d="M4 17h16"/><path d="m6 7 4 4-4 4"/><path d="M13 15h5"/></svg>
        Console
      </div>
      <div class="nav-group">Premium</div>
      <div class="nav-item nav-item-core" id="nav-core">
        <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        Core
        <span class="core-nav-badge">PRO</span>
      </div>
      <div class="nav-item nav-item-core" id="nav-insights">
        <svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m7 13 3-3 3 2 4-5"/></svg>
        Insights
        <span class="core-nav-badge">PRO</span>
      </div>
      <div class="nav-group">More</div>
      <div class="nav-item" id="nav-plugins">
        <svg viewBox="0 0 24 24"><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5"/></svg>
        Plugins
        <span class="beta-nav-badge">BETA</span>
      </div>
      <div class="nav-item" id="nav-settings">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Settings
      </div>
      <div class="nav-item" id="nav-docs">
        <svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        Docs
      </div>
      <div class="nav-item" id="btn-general-feedback" style="color:rgba(180,200,230,.65); border:1px solid transparent; transition:all .2s;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        Feedback
      </div>
    </nav>
    <div class="sidebar-actions">
      <button class="btn-action-run" id="btn-run">
        <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
        Run now
      </button>
      <button class="btn-action-run" id="btn-show-browser" style="display:none">
        <svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        Show browser
      </button>
      <button class="btn-action-stop" id="btn-stop">
        <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Stop safely
      </button>
    </div>
    <div class="sidebar-bottom">
      <button class="lic-sidebar-btn" id="btn-lic" style="display:none">
        <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span id="lic-sidebar-label">Activate Core</span>
        <span class="lic-sidebar-dot" id="lic-sidebar-dot"></span>
      </button>
      <button class="install-btn" id="remote-btn" style="border-color:rgba(46,232,255,.28); background:rgba(46,232,255,.08); color:#9ce9f5">
        <svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><line x1="10.5" y1="18.5" x2="13.5" y2="18.5"/></svg>
        Use on phone
      </button>
      <button class="discord-btn" id="discord-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037 13.8 13.8 0 0 0-.61 1.253 18.3 18.3 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.253.077.077 0 0 0-.079-.037A19.7 19.7 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.08.08 0 0 0 .031.055 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.8 19.8 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        Join Discord
      </button>
      <button class="install-btn" id="install-btn">
        <svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
        Install Rewards Desk
      </button>
      <div class="ver" style="display:flex; justify-content:center; gap:8px; padding-bottom:10px; margin-top:20px">
        <span style="font-size:13px; color:rgba(255,255,255,0.4)">v${APP_VERSION}</span>
      </div>
    </div>
  </aside>

  <main class="main">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-bg"></div>
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <div class="hero-eyebrow">
          <span class="hero-eyebrow-dot" id="hero-dot"></span>
          <span id="hero-eyebrow-txt">Ready when you are</span>
        </div>
        <h1>Automate more.<br><span>Earn more.</span></h1>
        <p>Your local control panel for Microsoft Rewards.</p>
      </div>
      <div class="hero-pills">
        <span class="pill pill-muted" id="core-pill" style="display:none">
          <span class="pill-dot"></span><span id="core-pill-txt">Core</span>
        </span>
      </div>
    </section>

    <!-- Dashboard view -->
    <div id="view-dash" style="display:flex;flex-direction:column;gap:20px;flex:1;height:100%;overflow:hidden;padding-right:4px;">
      <div class="star-banner" onclick="window.open('https://github.com/QuestPilot/Microsoft-Rewards-Bot')">
        <div class="star-banner-bg"></div>
        <div class="star-banner-content">
          <div style="background:rgba(247,200,92,.1);padding:10px;border-radius:12px;display:flex">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </div>
          <div class="star-banner-text">
            <span class="star-banner-title">Love Rewards Desk?</span>
            <span class="star-banner-sub">Support the open-source project by leaving a Star on GitHub!</span>
          </div>
          <button class="star-banner-btn">Star Project</button>
        </div>
      </div>
      <div class="info-banner" onclick="window.open('https://bot.lgtw.tf/announcement')">
        <div class="info-banner-icon">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <span class="info-banner-text"><strong>Don't believe the rumors.</strong> False claims are circulating about this project &mdash; it's 100% clean, open-source and safe. <strong>Click to see the facts.</strong></span>
        <span class="info-banner-arrow">›</span>
      </div>
      <div class="cards">
      <!-- Status -->
      <div class="card">
        <div class="card-head"><span class="card-label">Bot Status</span></div>
        <div class="st-center">
          <div class="ring-wrap">
            <svg class="ring-svg" viewBox="0 0 92 92">
              <defs>
                <linearGradient id="rg" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#1e9bff"/>
                  <stop offset="100%" stop-color="#2ee8ff"/>
                </linearGradient>
              </defs>
              <circle class="ring-track" cx="46" cy="46" r="40"/>
              <circle class="ring-fill" id="ring-path" cx="46" cy="46" r="40"/>
            </svg>
            <div class="ring-icon">
              <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
          </div>
          <div class="st-text" id="st-text">Ready</div>
          <div class="st-detail" id="st-detail">Click "Run daily set" to start</div>
          <div class="st-next" id="st-next"></div>
        </div>
      </div>

      <!-- Points -->
      <div class="card">
        <div class="card-head"><span class="card-label">Points Overview</span></div>
        <div class="pts-center">
          <div class="pts-val" id="pts-val" style="color:var(--muted)">—</div>
          <div class="pts-label" id="pts-label">start a run to see stats</div>
        </div>
        <div class="mini-grid">
          <div class="mini">
            <div class="mini-val" id="mini-core" style="color:var(--muted)">—</div>
            <div class="mini-lbl">Points Claimed</div>
          </div>
          <div class="mini mini-sm">
            <div class="mini-val" id="mini-coupons">—</div>
            <div class="mini-lbl">Coupons</div>
          </div>
        </div>
      </div>
      </div>

      <!-- Accounts -->
      <div class="card" style="flex:1; min-height:0; display:flex; flex-direction:column">
        <div class="card-head">
          <span class="card-label">Accounts</span>
        </div>
        <div class="acc-list" id="acc-list"></div>
      </div>
    </div>

    <!-- Accounts full view (editor) -->
    <div class="core-view" id="view-insights">
      <div class="ins-head">
        <div>
          <div class="ins-title">Insights</div>
          <div class="ins-sub">Smart analysis of your accounts &mdash; computed locally, on your machine.</div>
        </div>
        <button class="btn btn-secondary" id="ins-refresh">Refresh</button>
      </div>
      <div class="ins-empty" id="ins-empty" style="display:none">Not enough data to display anything yet. Run the bot a few more times first!</div>
      <div id="ins-body">
        <div class="ins-kpis" id="ins-kpis"></div>
        <div class="ins-card">
          <div class="ins-card-title">Points &mdash; last 30 days</div>
          <div id="ins-chart" class="ins-chart"></div>
        </div>
        <div class="ins-grid">
          <div class="ins-card">
            <div class="ins-card-title">Accounts</div>
            <div id="ins-accounts" class="ins-accounts"></div>
          </div>
          <div class="ins-card ins-reco-card">
            <div class="ins-card-title">Recommendations to earn more <span class="core-nav-badge">PRO</span></div>
            <div id="ins-reco" class="ins-reco"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="view-full" id="view-accounts" style="position:relative">
      <!-- Premium header with stats -->
      <div class="acc-page-header">
        <div class="acc-page-title-wrap">
          <div class="acc-page-title">Accounts</div>
          <div class="acc-page-sub" id="acc-page-sub">Manage your Microsoft accounts</div>
        </div>
        <div class="acc-page-stats">
          <div class="acc-stat">
            <div class="acc-stat-val" id="acc-stat-total">—</div>
            <div class="acc-stat-lbl">Total</div>
          </div>
          <div class="acc-stat">
            <div class="acc-stat-val" style="color:var(--green)" id="acc-stat-enabled">—</div>
            <div class="acc-stat-lbl">Active</div>
          </div>
          <div class="acc-stat">
            <div class="acc-stat-val" style="color:var(--muted)" id="acc-stat-disabled">—</div>
            <div class="acc-stat-lbl">Paused</div>
          </div>
        </div>
        <div class="acc-page-actions">
          <button class="btn btn-secondary btn-sm" id="btn-test-proxies" style="display:none">
            <svg style="width:13px;height:13px;vertical-align:middle;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="23"></line><line x1="1" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="23" y2="12"></line></svg>Test Proxies
          </button>
          <button class="btn btn-primary btn-sm" id="btn-add-acc">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;vertical-align:middle;margin-right:5px;fill:none;stroke:currentColor;stroke-width:2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>Add account
          </button>
        </div>
      </div>
      <div id="acc-safety-advice" style="display:none; margin: 15px 25px 0 25px; padding: 12px 15px; background: rgba(255, 171, 0, 0.1); border-left: 3px solid #ffab00; border-radius: 4px; font-size: 13px; color: var(--text);"></div>
      <!-- Scrollable account list -->
      <div class="acc-page-body" id="acc-editor-list"></div>
      <!-- First-time hints -->
      <div class="hint-bar" id="hint-acc-dbl">
        <span class="hint-bar-icon"><svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="6"/><line x1="12" y1="2" x2="12" y2="10"/></svg></span>
        <span>Double-click an account to <strong>enable</strong> or <strong>disable</strong> it</span>
        <button class="hint-bar-close" onclick="dismissHint('acc-dbl')">&#215;</button>
      </div>
      <div class="hint-bar" id="hint-acc-rclick">
        <span class="hint-bar-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></span>
        <span>Right-click an account for <strong>more options</strong></span>
        <button class="hint-bar-close" onclick="dismissHint('acc-rclick')">&#215;</button>
      </div>
    </div>

    <!-- Notification config: Discord -->
    <div class="view-full" id="view-notif-discord">
      <div class="notif-page-head">
        <button class="btn btn-secondary btn-sm" id="notif-discord-back">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;margin-right:5px;vertical-align:middle"><polyline points="15 18 9 12 15 6"/></svg>Settings
        </button>
        <div class="notif-page-identity">
          <div class="notif-page-icon" style="background:rgba(88,101,242,.12);border-color:rgba(88,101,242,.28)">
            <svg viewBox="0 0 24 24" fill="#7289da" stroke="none" style="width:20px;height:20px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
          </div>
          <div>
            <div class="notif-page-title">Discord log webhook</div>
            <div class="notif-page-sub">Stream filtered console logs to a Discord channel.</div>
          </div>
        </div>
        <div class="notif-page-toggle">
          <span>Enabled</span>
          <label class="toggle"><input type="checkbox" id="tog-wh-discord"><span class="toggle-slider"></span></label>
        </div>
      </div>
      <div class="notif-page-body" id="notif-discord-body">
        <div id="hint-notif-discord" class="sett-hint">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span>Paste your Discord webhook URL and toggle <strong>Enabled</strong>. All config changes save automatically.</span>
          <button class="sett-hint-close" onclick="dismissHint('notif-discord')">&#215;</button>
        </div>
        <!-- form injected by loadNotifPage('discord') -->
      </div>
    </div>

    <!-- Notification config: ntfy -->
    <div class="view-full" id="view-notif-ntfy">
      <div class="notif-page-head">
        <button class="btn btn-secondary btn-sm" id="notif-ntfy-back">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;margin-right:5px;vertical-align:middle"><polyline points="15 18 9 12 15 6"/></svg>Settings
        </button>
        <div class="notif-page-identity">
          <div class="notif-page-icon" style="background:rgba(46,232,255,.08);border-color:rgba(46,232,255,.2)">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <div>
            <div class="notif-page-title">ntfy push</div>
            <div class="notif-page-sub">Send notifications to an ntfy topic or self-hosted server.</div>
          </div>
        </div>
        <div class="notif-page-toggle">
          <span>Enabled</span>
          <label class="toggle"><input type="checkbox" id="tog-wh-ntfy"><span class="toggle-slider"></span></label>
        </div>
      </div>
      <div class="notif-page-body" id="notif-ntfy-body">
        <div id="hint-notif-ntfy" class="sett-hint">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span>Set your ntfy Server URL and Topic, then toggle <strong>Enabled</strong>. The access token is only needed for private topics.</span>
          <button class="sett-hint-close" onclick="dismissHint('notif-ntfy')">&#215;</button>
        </div>
        <!-- form injected by loadNotifPage('ntfy') -->
      </div>
    </div>

    <!-- Console view -->
    <div class="console-wrap" id="view-console" style="position:relative">
      <div class="console-head">
        <div class="console-head-left">
          <span class="card-label">Console</span>
          <span class="console-line-count" id="console-line-count">0 lines</span>
          <div class="console-filters">
            <button class="console-filter active" data-level="all">All</button>
            <button class="console-filter" data-level="error">Error</button>
            <button class="console-filter" data-level="warn">Warn</button>
            <button class="console-filter" data-level="success">OK</button>
          </div>
        </div>
        <div class="console-head-actions">
          <input class="console-search" id="console-search" type="search" placeholder="Filter…" autocomplete="off">
          <button class="btn btn-secondary btn-sm" id="console-clear">Clear</button>
          <button class="btn btn-secondary btn-sm" id="console-copy">Copy</button>
        </div>
      </div>
      <div class="console-box" id="console-box"></div>
      <button class="console-jump" id="console-jump">
        <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        Latest
      </button>
    </div>

    <!-- Settings view -->
    <div class="settings-wrap" id="view-settings">
      <!-- Left navigation sidebar -->
      <div class="sett-sidebar">
        <span class="sett-nav-section">Bot</span>
        <button class="sett-nav-item active" data-panel="run">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>Run tasks
        </button>
        <button class="sett-nav-item" data-panel="behavior">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Behavior
        </button>
        <button class="sett-nav-item" data-panel="schedule">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Schedule
        </button>
        <button class="sett-nav-item" data-panel="startup">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>Startup
        </button>
        <span class="sett-nav-section">Features</span>
        <button class="sett-nav-item" data-panel="core">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Core Premium
          <span class="sett-nav-badge sett-nav-badge-gold" id="sett-nav-core-badge"></span>
        </button>
        <button class="sett-nav-item" data-panel="notifications">
          <svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Notifications
        </button>
        <span class="sett-nav-section">System</span>
        <button class="sett-nav-item" data-panel="security">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/></svg>Security
        </button>
        <button class="sett-nav-item" data-panel="privacy">
          <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Privacy
        </button>
        <button class="sett-nav-item" data-panel="advanced">
          <svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>Advanced
        </button>
      </div>

      <!-- Right panel content area -->
      <div class="sett-body">

        <!-- Run tasks -->
        <div class="sett-panel active" id="sett-run">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Run tasks</div>
            <div class="sett-panel-sub">What the bot collects on each run. Free tasks always run — premium ones require Core and are configured under Core Premium.</div>
          </div>
          <div class="settings-section">
            <h3>Free tasks</h3>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily Set</div><div class="toggle-sub">Complete the daily activity set</div></div><label class="toggle"><input type="checkbox" id="tog-doDailySet"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Desktop Search</div><div class="toggle-sub">Bing PC search points</div></div><label class="toggle"><input type="checkbox" id="tog-doDesktopSearch"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Mobile Search</div><div class="toggle-sub">Bing mobile search points</div></div><label class="toggle"><input type="checkbox" id="tog-doMobileSearch"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Special Promotions</div><div class="toggle-sub">Sponsored bonus offers</div></div><label class="toggle"><input type="checkbox" id="tog-doSpecialPromotions"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">More Promotions</div><div class="toggle-sub">Additional bonus tasks</div></div><label class="toggle"><input type="checkbox" id="tog-doMorePromotions"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">App Promotions</div><div class="toggle-sub">Mobile app promotional tasks</div></div><label class="toggle"><input type="checkbox" id="tog-doAppPromotions"><span class="toggle-slider"></span></label></div>
            </div>
          </div>
        </div>

        <!-- Behavior -->
        <div class="sett-panel" id="sett-behavior">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Behavior</div>
            <div class="sett-panel-sub">Browser and run settings applied to every account.</div>
          </div>
          <div class="settings-section">
            <h3>Browser</h3>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Strict proxy mode</div><div class="toggle-sub">Skip accounts without a configured proxy to prevent real IP leaks</div></div><label class="toggle"><input type="checkbox" id="tog-strictProxy"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Headless mode</div><div class="toggle-sub">Run the browser hidden in the background</div></div><label class="toggle"><input type="checkbox" id="tog-headless"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Run on zero points</div><div class="toggle-sub">Keep running even when no points are left to earn</div></div><label class="toggle"><input type="checkbox" id="tog-runOnZero"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Search on Bing local queries</div><div class="toggle-sub">Use local search-history suggestions as Bing queries</div></div><label class="toggle"><input type="checkbox" id="tog-searchOnBing"><span class="toggle-slider"></span></label></div>
            </div>
          </div>
        </div>

        <!-- Schedule -->
        <div class="sett-panel" id="sett-schedule">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Schedule</div>
            <div class="sett-panel-sub">Run the bot at a set time every day, as long as the bot keeps running (start it once, or run it headless/CLI).</div>
          </div>
          <div class="settings-section">
            <div class="toggle-wrap" style="margin-bottom:9px">
              <div class="toggle-wrap-left"><div class="toggle-label">Auto-schedule</div><div class="toggle-sub">Repeats daily once started — keep the bot running</div></div>
              <label class="toggle"><input type="checkbox" id="tog-scheduler"><span class="toggle-slider"></span></label>
            </div>
            <div class="scheduler-fields hidden" id="scheduler-fields">
              <div class="settings-field">
                <div class="settings-label">Start time</div>
                <input type="time" class="settings-input" id="sch-startTime" value="08:00">
              </div>
              <div class="settings-field">
                <div class="settings-label">Timezone</div>
                <select class="settings-input" id="sch-timezone">
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Berlin">Europe/Berlin</option>
                  <option value="Europe/Madrid">Europe/Madrid</option>
                  <option value="Europe/Rome">Europe/Rome</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="America/Sao_Paulo">America/Sao_Paulo</option>
                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                  <option value="Asia/Shanghai">Asia/Shanghai</option>
                  <option value="Asia/Kolkata">Asia/Kolkata</option>
                  <option value="Asia/Dubai">Asia/Dubai</option>
                  <option value="Australia/Sydney">Australia/Sydney</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
              <div class="settings-label">Random delay (before start)</div>
              <div class="settings-input-row">
                <div class="settings-field">
                  <div class="settings-label">Min</div>
                  <input type="text" class="settings-input" id="sch-delayMin" placeholder="0min">
                </div>
                <div class="settings-field">
                  <div class="settings-label">Max</div>
                  <input type="text" class="settings-input" id="sch-delayMax" placeholder="30min">
                </div>
              </div>
              <div class="toggle-wrap">
                <div class="toggle-wrap-left"><div class="toggle-label">Run on startup</div><div class="toggle-sub">Run immediately when the bot starts</div></div>
                <label class="toggle"><input type="checkbox" id="tog-runOnStartup"><span class="toggle-slider"></span></label>
              </div>
            </div>
          </div>
        </div>

        <!-- Startup -->
        <div class="sett-panel" id="sett-startup">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Startup</div>
            <div class="sett-panel-sub">What starts with your computer, and how to reach your bot from elsewhere. <b>Open Desk</b> shows this window at sign-in · <b>Remote access</b> lets you control it from Nexus anywhere (while the Desk runs) · <b>Headless service</b> runs it with no window for servers.</div>
          </div>
          <div class="startup-grid">
            <div class="startup-card">
              <div class="startup-icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg></div>
              <div class="startup-copy">
                <div class="toggle-label">Open Rewards Desk</div>
                <div class="toggle-sub">Show this interface automatically when you sign in.</div>
                <div class="startup-method" id="startup-desk-method"></div>
              </div>
              <label class="toggle"><input type="checkbox" id="tog-startup-desk"><span class="toggle-slider"></span></label>
            </div>
            <div class="startup-card core-only">
              <div class="startup-icon"><svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a4 4 0 0 0 4 4h1"/><path d="M12 3a6 6 0 0 1 6 6v3a4 4 0 0 1-4 4h-1"/><path d="M9 20h6"/></svg></div>
              <div class="startup-copy">
                <div class="toggle-label">Remote access <span class="startup-badge">Core</span></div>
                <div class="toggle-sub">Control your bot from Nexus anywhere — even off your home network — while the Desk (or the headless service) is running. Closing the Desk turns it off.</div>
                <div class="startup-method" id="remote-access-method"></div>
              </div>
              <label class="toggle"><input type="checkbox" id="tog-remote-access"><span class="toggle-slider"></span></label>
            </div>
            <div class="startup-card">
              <div class="startup-icon"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
              <div class="startup-copy">
                <div class="toggle-label">Headless service</div>
                <div class="toggle-sub">For a server/Docker with no screen: run the Desk in the background (no window) so the bot stays reachable from Nexus. Takes effect on the next launch.</div>
              </div>
              <label class="toggle"><input type="checkbox" id="tog-desk-headless"><span class="toggle-slider"></span></label>
            </div>
          </div>
        </div>

        <!-- Core Premium -->
        <div class="sett-panel" id="sett-core">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Core Premium</div>
            <div class="sett-panel-sub">Premium features that run on top of the free bot. Each one only activates when your Core license is valid.</div>
          </div>
          <div class="settings-section settings-section-core" id="settings-core-premium">
            <h3>
              <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:var(--gold);stroke:none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              Premium features
              <span class="core-section-badge" id="core-license-badge">No license</span>
            </h3>
            <div class="settings-section-note" id="core-section-note" style="display:none">Activate a Core license to unlock these features. Each one only runs — and only counts — when your license is valid and the feature is enabled here.</div>
            <div class="settings-section-note">Some features only run on one Microsoft Rewards dashboard. Badges show which.</div>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Claim points</div><div class="toggle-sub">Auto-claim ready-to-claim dashboard point cards</div></div><label class="toggle"><input type="checkbox" id="tog-core-claimPoints"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Apply coupons<span class="next-badge">Next only</span></div><div class="toggle-sub">Detect &amp; apply dashboard coupons automatically</div></div><label class="toggle"><input type="checkbox" id="tog-core-applyCoupons"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Double search points</div><div class="toggle-sub">Activate eligible double-search promotions</div></div><label class="toggle"><input type="checkbox" id="tog-core-doubleSearchPoints"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Explore on Bing</div><div class="toggle-sub">Commercial topic searches (cards, insurance, travel…) for bonus points</div></div><label class="toggle"><input type="checkbox" id="tog-core-exploreOnBing"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">App rewards</div><div class="toggle-sub">Mobile app-only reward promotions</div></div><label class="toggle"><input type="checkbox" id="tog-core-appReward"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Read to Earn<span class="beta-badge">Beta</span></div><div class="toggle-sub">MSN app-only reading rewards</div></div><label class="toggle"><input type="checkbox" id="tog-core-readToEarn"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily check-in</div><div class="toggle-sub">App-only daily check-in bonus</div></div><label class="toggle"><input type="checkbox" id="tog-core-dailyCheckIn"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily streak</div><div class="toggle-sub">Read streak details from the dashboard</div></div><label class="toggle"><input type="checkbox" id="tog-core-dailyStreak"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Streak protection</div><div class="toggle-sub">Keep streak protection enabled on the dashboard</div></div><label class="toggle"><input type="checkbox" id="tog-core-streakProtection"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Temporary punchcards<span class="beta-badge">Beta</span><span class="next-badge">Next only</span></div><div class="toggle-sub">New-dashboard limited-time punchcards (distinct from classic punch cards)</div></div><label class="toggle"><input type="checkbox" id="tog-core-temporaryPunchcards"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Dashboard data</div><div class="toggle-sub">Rich dashboard snapshots, ready-to-claim &amp; streak info</div></div><label class="toggle"><input type="checkbox" id="tog-core-collectDashboardInfo"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Set Rewards goal<span class="next-badge">Next only</span></div><div class="toggle-sub">Auto-pick an eligible gift card as your Rewards goal</div></div><label class="toggle"><input type="checkbox" id="tog-core-setGoal"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Page Harvester<span class="beta-badge">Diagnostic</span></div><div class="toggle-sub">Snapshots all Rewards pages (HTML + data) into the Page/ folder. Enable once, run the bot — Page/ is rebuilt and the toggle resets. For selector maintenance only, does not earn points.</div></div><label class="toggle"><input type="checkbox" id="tog-core-captureDashboardPages"><span class="toggle-slider"></span></label></div>
            </div>
          </div>
          <div class="settings-section">
            <h3>Parallelism</h3>
            <div class="acc-grid-2">
              <div class="modal-field"><label>Parallel accounts (clusters)</label><input type="number" class="modal-input" id="set-clusters" min="1" max="20" placeholder="1" autocomplete="off"><div class="toggle-sub" style="margin-top:4px">How many accounts run simultaneously. Requires Core. Higher = faster but riskier.</div></div>
            </div>
          </div>
        </div>

        <!-- Notifications -->
        <div class="sett-panel" id="sett-notifications">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Notifications</div>
            <div class="sett-panel-sub">Free, open-source alerting channels. Click a channel to configure it.</div>
          </div>
          <div id="hint-sett-notifications" class="sett-hint">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>Enable a channel, then click it to enter the URL and configure filtering. Changes save automatically.</span>
            <button class="sett-hint-close" onclick="dismissHint('sett-notifications')">&#215;</button>
          </div>
          <div class="settings-section">
            <div style="display:flex;flex-direction:column;gap:8px">
              <button class="notif-nav-btn" data-notif="discord">
                <div class="notif-nav-btn-icon" style="background:rgba(88,101,242,.12);border-color:rgba(88,101,242,.25)">
                  <svg viewBox="0 0 24 24" fill="#7289da" stroke="none"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
                </div>
                <div class="notif-nav-btn-info">
                  <div class="notif-nav-btn-name">Discord log webhook</div>
                  <div class="notif-nav-btn-sub">Stream filtered console logs to a channel</div>
                </div>
                <span class="notif-nav-btn-arrow">&#8250;</span>
              </button>
              <button class="notif-nav-btn" data-notif="ntfy">
                <div class="notif-nav-btn-icon" style="background:rgba(46,232,255,.08);border-color:rgba(46,232,255,.2)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                </div>
                <div class="notif-nav-btn-info">
                  <div class="notif-nav-btn-name">ntfy push</div>
                  <div class="notif-nav-btn-sub">Send notifications to an ntfy topic or server</div>
                </div>
                <span class="notif-nav-btn-arrow">&#8250;</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Security (account protection — moved out of Advanced) -->
        <div class="sett-panel" id="sett-security">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Security</div>
            <div class="sett-panel-sub">Account storage encryption and key management.</div>
          </div>
          <div id="hint-sett-security" class="sett-hint">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>Your accounts are encrypted automatically with AES-256-GCM. Export a backup before rotating the key or disabling encryption.</span>
            <button class="sett-hint-close" onclick="dismissHint('sett-security')">&#215;</button>
          </div>
          <div class="settings-section">
            <div class="advanced-block">
              <div class="storage-panel">
                <div class="storage-shield"><svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3z"/><path d="m9 12 2 2 4-5"/></svg></div>
                <div class="advanced-copy">
                  <div class="toggle-label">Account protection</div>
                  <div class="toggle-sub">Automatic AES-256-GCM encryption with the key protected by your operating system.</div>
                  <div class="storage-state" id="account-storage-status">Checking protected storage…</div>
                </div>
              </div>
              <div class="advanced-actions">
                <button class="btn btn-secondary btn-sm" id="storage-export">Export protected backup</button>
                <button class="btn btn-secondary btn-sm" id="storage-toggle">Disable encryption</button>
              </div>
            </div>
            <details class="storage-tools">
              <summary>Security and recovery options</summary>
              <div class="advanced-caption">These actions are rarely needed. Disabling protection requires an explicit local-user confirmation and writes credentials to plaintext JSON.</div>
              <div class="advanced-actions" style="margin-top:10px">
                <button class="btn btn-secondary btn-sm" id="storage-rotate">Rotate local key</button>
                <button class="btn btn-secondary btn-sm" id="storage-import">Import protected backup</button>
              </div>
            </details>
          </div>
          <div class="settings-section">
            <h3>Shortcuts</h3>
            <div class="advanced-block term-row">
              <div class="toggle-wrap-left">
                <div class="toggle-label">Desktop shortcuts</div>
                <div class="toggle-sub">Remove the Desktop and application-menu shortcuts. Autostart settings are not changed.</div>
              </div>
              <button class="btn btn-secondary btn-sm" id="desktop-uninstall" style="flex-shrink:0">Uninstall shortcuts</button>
            </div>
          </div>
        </div>

        <!-- Privacy -->
        <div class="sett-panel" id="sett-privacy">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Privacy &amp; data</div>
            <div class="sett-panel-sub">Anonymous usage data helps fix bugs and improve the bot. It never includes passwords, emails, cookies or licence keys.</div>
          </div>
          <div class="settings-section">
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Anonymous telemetry</div><div class="toggle-sub">Send anonymous run stats and error signals to the maintainer</div></div><label class="toggle"><input type="checkbox" id="tog-analytics"><span class="toggle-slider"></span></label></div>
            </div>
            <div id="analytics-warning" class="settings-section-note" style="display:none;margin-top:10px;margin-bottom:0;background:rgba(255,170,0,.06);border-color:rgba(255,170,0,.22);color:#f5c542">&#9888; Telemetry disabled — errors are silent and bugs go unreported.</div>
          </div>
        </div>

        <!-- Advanced -->
        <div class="sett-panel" id="sett-advanced">
          <div class="sett-panel-header">
            <div class="sett-panel-title">Advanced</div>
            <div class="sett-panel-sub">Rarely-needed options — defaults are fine for most setups. Only change these if you know what you are doing.</div>
          </div>
          <div id="hint-sett-advanced" class="sett-hint">
            <svg viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span><strong>Heads up:</strong> the defaults work well for most users. Only adjust search tuning if you experience detection issues or performance problems.</span>
            <button class="sett-hint-close" onclick="dismissHint('sett-advanced')">&#215;</button>
          </div>
          <div class="settings-section">
            <h3>Developer</h3>
            <div class="settings-section-note">Verbose logging and a raw-terminal run mode for debugging the bot.</div>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Debug logs</div><div class="toggle-sub">Print verbose internal logs to the console</div></div><label class="toggle"><input type="checkbox" id="tog-debugLogs"><span class="toggle-slider"></span></label></div>
            </div>
            <div class="advanced-block term-row" style="margin-top:12px">
              <div class="toggle-wrap-left">
                <div class="toggle-label">Developer terminal mode</div>
                <div class="toggle-sub">Close Rewards Desk and relaunch the bot in PowerShell with live developer logs.</div>
              </div>
              <button class="btn btn-secondary" id="btn-terminal-mode" style="flex-shrink:0">Open terminal &amp; run &#8250;</button>
            </div>
          </div>
          <div class="settings-section">
            <h3>Network access</h3>
            <div class="settings-section-note">Control this Desk from another device on your home network (e.g. your phone). When you open Nexus on the same network, it can load this Desk directly. The Desk embedded on this same computer already works without this.</div>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Local network access (LAN)</div><div class="toggle-sub">Off by default. When on, the Desk also listens on your computer's network address so other devices on your Wi-Fi can reach it &mdash; anyone on the network who opens that address can control the bot. The first launch may ask Windows Firewall to allow it. Takes effect after a Desk restart.</div></div><label class="toggle"><input type="checkbox" id="tog-lanAccess"><span class="toggle-slider"></span></label></div>
            </div>
            <div id="lan-url-row" class="advanced-block term-row" style="margin-top:12px; display:none">
              <div class="toggle-wrap-left">
                <div class="toggle-label">Connect a phone</div>
                <div class="toggle-sub">Your Desk's local address stays private. Use the <b>Use on phone</b> button (bottom-left) to get a link that routes your phone here automatically.</div>
              </div>
              <button class="btn btn-secondary" id="btn-open-remote" style="flex-shrink:0">Use on phone</button>
            </div>
          </div>
          <div class="settings-section">
            <h3>Update notifier</h3>
            <div class="settings-section-note">A tiny background process (desktop only, no window) that starts with your computer, checks for bot updates, and reminds you to open Rewards Desk if it's been a while. Stays inside this install folder — deleting the bot removes it too.</div>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Background update notifier</div><div class="toggle-sub">Notify me about updates and remind me to run the bot</div></div><label class="toggle"><input type="checkbox" id="tog-updateNotifier"><span class="toggle-slider"></span></label></div>
            </div>
          </div>
          <div class="settings-section">
            <h3>Search tuning</h3>
            <div class="settings-section-note">Fine-tune search behaviour and timing. Delays accept values like <b>3min</b> or <b>8sec</b>.</div>
            <div class="toggle-grid">
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Parallel searching</div><div class="toggle-sub">Run desktop &amp; mobile searches together (faster)</div></div><label class="toggle"><input type="checkbox" id="tog-parallelSearching"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Scroll results</div><div class="toggle-sub">Scroll result pages like a human</div></div><label class="toggle"><input type="checkbox" id="tog-scrollRandomResults"><span class="toggle-slider"></span></label></div>
              <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Click results</div><div class="toggle-sub">Occasionally open a result link</div></div><label class="toggle"><input type="checkbox" id="tog-clickRandomResults"><span class="toggle-slider"></span></label></div>
            </div>
            <div class="acc-grid-2" style="margin-top:12px">
              <div class="modal-field"><label>Result visit time</label><input class="modal-input" id="set-visitTime" autocomplete="off" placeholder="8sec"></div>
              <div class="modal-field"><label>Global timeout</label><input class="modal-input" id="set-globalTimeout" autocomplete="off" placeholder="30sec"></div>
              <div class="modal-field"><label>Search delay min</label><input class="modal-input" id="set-searchDelayMin" autocomplete="off" placeholder="3min"></div>
              <div class="modal-field"><label>Search delay max</label><input class="modal-input" id="set-searchDelayMax" autocomplete="off" placeholder="5min"></div>
              <div class="modal-field"><label>Read delay min</label><input class="modal-input" id="set-readDelayMin" autocomplete="off" placeholder="3sec"></div>
              <div class="modal-field"><label>Read delay max</label><input class="modal-input" id="set-readDelayMax" autocomplete="off" placeholder="5sec"></div>
            </div>
          </div>
          <div class="settings-section">
            <h3>Installation</h3>
            <div class="settings-section-note">Open the folder where the bot is installed, or reset the full configuration to the official defaults.</div>
            <div class="acc-grid-2">
              <button class="btn btn-secondary" id="btn-open-folder" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px">
                <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>Open installation folder
              </button>
              <button class="btn btn-secondary" id="btn-reset-config" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;border-color:rgba(255,170,0,.38);color:#f5c542">
                <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>Reset config to defaults
              </button>
            </div>
            <div id="reset-confirm-area" style="display:none">
              <div class="reset-warning">
                <p>This replaces your entire <strong>config.json</strong> with the official defaults fetched from GitHub. Your accounts are <strong>not</strong> affected. This cannot be undone.</p>
                <div class="reset-warning-actions">
                  <button class="btn-danger-sm" id="reset-confirm-yes">Yes, reset config</button>
                  <button class="btn btn-secondary btn-sm" id="reset-confirm-no">Cancel</button>
                </div>
              </div>
            </div>
          </div>
          <div class="settings-section">
            <h3>Maintenance</h3>
            <div class="settings-section-note">Manage temporary files and cached data. <strong>Warning:</strong> Deleting the data folder resets avatars, launch statistics, and cached markers.</div>
            <div class="acc-grid-2">
              <button class="btn btn-secondary" id="btn-clear-sessions" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px">
                <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>Delete all sessions
              </button>
              <button class="btn btn-secondary" id="btn-clear-data" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;border-color:rgba(255,107,138,.38);color:var(--rose)">
                <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete data folder
              </button>
            </div>
            <div id="maintenance-confirm-area" style="display:none; margin-top: 12px">
              <div class="reset-warning" style="border-color: rgba(255, 107, 138, 0.4);">
                <p id="maintenance-confirm-text"></p>
                <div class="reset-warning-actions">
                  <button class="btn-danger-sm" id="maintenance-confirm-yes">Yes, delete</button>
                  <button class="btn btn-secondary btn-sm" id="maintenance-confirm-no">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Core view -->
    <div class="core-view" id="view-core">
      <!-- Active / retention sub-view (shown when Core license is valid) -->
      <div id="core-view-active" style="display:none;flex-direction:column;gap:16px">
        <!-- Member status -->
        <div class="cmember-hero">
          <div class="cmember-hero-row">
            <div class="cmember-badge"><span class="cmember-badge-dot"></span>Core active</div>
            <div class="cmember-status" id="cmember-status">Active</div>
          </div>
          <h1 class="cmember-title">Welcome back — <span>Core is running</span></h1>
          <p class="cmember-sub">Every premium automation is working across your accounts, hands-off. Thanks for being a Core member.</p>
          <div class="cmember-actions">
            <button class="btn-cmember" onclick="window.open('https://bot.lgtw.tf')">
              <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Open remote dashboard
            </button>
            <button class="btn-cmember-ghost" id="core-manage-license">Manage license</button>
            <button class="btn-cmember-ghost" id="core-manual-rate">Rate Core</button>
          </div>
        </div>
        <!-- Renewal nudge (shown only when expiry is near) -->
        <div class="core-expiry-band" id="core-expiry-band">
          <div class="core-expiry-left">
            <div class="core-expiry-text"><span id="core-expiry-days">—</span> remaining</div>
            <div class="core-expiry-sub">Renew before <span id="core-expiry-date">—</span> to keep every feature active</div>
          </div>
          <button class="core-expiry-btn" onclick="window.open('https://discord.gg/JWhCkhSYtg')">Renew on Discord →</button>
        </div>
        <!-- Real results snapshot -->
        <div class="core-real-card" id="core-real-card">
          <div class="core-real-head">
            <div class="core-real-title">Your results</div>
            <div class="core-real-since" id="cr-since"></div>
          </div>
          <div class="core-real-grid">
            <div class="core-real-stat"><div class="core-real-val" id="cr-points">—</div><div class="core-real-lbl">Points collected</div></div>
            <div class="core-real-stat"><div class="core-real-val" id="cr-7d">—</div><div class="core-real-lbl">Last 7 days</div></div>
            <div class="core-real-stat"><div class="core-real-val" id="cr-runs">—</div><div class="core-real-lbl">Runs completed</div></div>
            <div class="core-real-stat"><div class="core-real-val" id="cr-success">—</div><div class="core-real-lbl">Account success</div></div>
            <div class="core-real-stat"><div class="core-real-val" id="cr-claimed">—</div><div class="core-real-lbl">Claimed points</div></div>
            <div class="core-real-stat"><div class="core-real-val" id="cr-coupons">—</div><div class="core-real-lbl">Coupons applied</div></div>
          </div>
          <div class="core-real-empty" id="cr-empty" style="display:none">No runs recorded yet — start a run and your numbers will appear here.</div>
        </div>
        <!-- Active automations (what Core is doing for the member) -->
        <div class="cmember-auto">
          <div class="cmember-auto-head">Core is handling for you</div>
          <div class="cmember-auto-chips" id="cmember-auto-chips"></div>
        </div>
      </div>

      <!-- Marketing sub-view (shown when no license) -->
      <div id="core-view-market" style="display:flex;flex-direction:column;gap:34px">
      <!-- Sales hero -->
      <div class="csell-hero">
        <div class="csell-hero-inner">
          <div class="csell-badge">
            <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            Official premium plugin
          </div>
          <h1 class="csell-title">Stop leaving points<br><span>on the table.</span></h1>
          <p class="csell-sub">The free bot collects the basics. <strong style="color:#e9eefb;font-weight:700">Core grabs everything else</strong> — auto-claimed every day, on every account.</p>
          <div class="csell-value">
            <div class="csell-value-num" id="csell-value-num">+~2,150</div>
            <div class="csell-value-lbl">estimated bonus points<br>per account, every month</div>
          </div>
          <div class="csell-hero-cta">
            <button class="btn-csell-primary" onclick="window.open('https://discord.gg/JWhCkhSYtg')">Get Core <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
            <button class="btn-csell-ghost" onclick="window.open('https://discord.gg/JWhCkhSYtg')">
              <svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.1.131 18.11a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.027c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              Ask on Discord
            </button>
          </div>
          <div class="csell-trust">Activated with a license key · Covers all your accounts · Renew anytime on Discord</div>
        </div>
      </div>
      <!-- Value strip -->
      <div class="csell-strip">
        <div class="csell-strip-item"><div class="csell-strip-num">9</div><div class="csell-strip-lbl">bonus automations</div></div>
        <div class="csell-strip-item"><div class="csell-strip-num">&infin;</div><div class="csell-strip-lbl">accounts covered</div></div>
        <div class="csell-strip-item"><div class="csell-strip-num">24/7</div><div class="csell-strip-lbl">remote dashboard</div></div>
        <div class="csell-strip-item"><div class="csell-strip-num">100%</div><div class="csell-strip-lbl">hands-off</div></div>
      </div>
      <!-- Problem -->
      <div class="csell-section">
        <div class="csell-eyebrow">The problem</div>
        <h2 class="csell-h2">Every day without Core, you lose points.</h2>
        <p class="csell-lead">Coupons, promos, read-to-earn, app tasks, punchcards — the free bot can't reach them. So they expire, untouched, every single day.</p>
      </div>
      <!-- What you get (wraps the features grid) -->
      <div class="csell-section">
        <div class="csell-eyebrow">What you get</div>
        <h2 class="csell-h2" style="margin-bottom:16px">Premium automations the free bot can't do.</h2>
      <div class="core-features">
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="core-feature-title">Remote Dashboard</div>
          <div class="core-feature-desc">Control every machine running the bot from a single web dashboard. Phone, tablet, anywhere.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <div class="core-feature-title">Live Telemetry</div>
          <div class="core-feature-desc">Real-time logs, points gained, run state and account status — all synced live to your browser.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div class="core-feature-title">Streak Protection</div>
          <div class="core-feature-desc">Automatic daily streak guard with intelligent recovery — never lose your streak again.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="core-feature-title">Background Agent</div>
          <div class="core-feature-desc">Bot auto-starts on your machine and connects to the remote dashboard — one-click run from anywhere.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          </div>
          <div class="core-feature-title">Double Search Points</div>
          <div class="core-feature-desc">Automatically activate double search point promotions, read-to-earn articles, app rewards and daily check-ins for extra points.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
          </div>
          <div class="core-feature-title">Temporary Punchcards</div>
          <div class="core-feature-desc">Automatically complete limited-time punchcard challenges for extra bonus points.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>
          </div>
          <div class="core-feature-title">Auto-Claim Points</div>
          <div class="core-feature-desc">Scans the Rewards dashboard each run and claims every ready-to-claim point card automatically.</div>
        </div>
        <div class="core-feature">
          <div class="core-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6"/><path d="M2 7h20v5H2z"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
          </div>
          <div class="core-feature-title">Auto-Apply Coupons</div>
          <div class="core-feature-desc">Detects and applies available dashboard coupons, then reports the points you saved in the run summary.</div>
        </div>
      </div>
      </div><!-- /what-you-get section -->
      <!-- Free vs Core comparison -->
      <div class="csell-section">
        <div class="csell-eyebrow">Free vs Core</div>
        <h2 class="csell-h2" style="margin-bottom:14px">See exactly what changes.</h2>
        <div class="ccompare">
          <div class="ccompare-row ccompare-head"><div class="ccompare-feat">Feature</div><div class="ccompare-free">Free</div><div class="ccompare-core">Core</div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Daily set &amp; activities</div><div class="ccompare-free"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Desktop &amp; mobile Bing searches</div><div class="ccompare-free"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Special &amp; more promotions</div><div class="ccompare-free"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Auto-claim ready points</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Auto-apply coupons</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Double search-point promos</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Read-to-earn articles</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">App &amp; daily check-in rewards</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Daily streak protection</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Temporary punchcards</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Remote web dashboard</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div class="ccompare-row"><div class="ccompare-feat">Live telemetry &amp; history</div><div class="ccompare-free"><svg class="cmark cmark-no" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div><div class="ccompare-core"><svg class="cmark cmark-yes" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div></div>
        </div>
      </div>
      <!-- How to get it -->
      <div class="csell-section">
        <div class="csell-eyebrow">Get started</div>
        <h2 class="csell-h2" style="margin-bottom:14px">Up and running in three steps.</h2>
        <div class="csteps">
          <div class="cstep"><div class="cstep-n">1</div><div class="cstep-t">Join the Discord</div><div class="cstep-d">Hop into the community server, where Core licenses are handed out and supported.</div></div>
          <div class="cstep"><div class="cstep-n">2</div><div class="cstep-t">Get your license key</div><div class="cstep-d">Follow the pinned instructions to grab your personal Core key — the team will sort you out.</div></div>
          <div class="cstep"><div class="cstep-n">3</div><div class="cstep-t">Activate in Desk</div><div class="cstep-d">Paste the key into Desk. The bot picks up Core on its next run — fully hands-off from there.</div></div>
        </div>
      </div>
      <!-- FAQ -->
      <div class="csell-section">
        <div class="csell-eyebrow">Questions</div>
        <h2 class="csell-h2" style="margin-bottom:14px">Good to know.</h2>
        <div class="cfaq">
          <details class="cfaq-item"><summary>Is Core a different bot?</summary><p>No. Core is an official plugin that sits on top of the same open-source bot. Every free feature keeps working exactly as before — Core just adds the premium automations and the remote dashboard.</p></details>
          <details class="cfaq-item"><summary>How do I get a license?</summary><p>Join the Discord server and follow the instructions there. You'll receive a personal license key to activate inside Desk.</p></details>
          <details class="cfaq-item"><summary>Does it cover all my accounts?</summary><p>Yes. Once Core is active it applies to every account the bot runs, across all your configured clusters — no per-account fees.</p></details>
          <details class="cfaq-item"><summary>What happens when my license expires?</summary><p>The premium features simply pause and the bot falls back to the free open-source tasks. Renew on Discord anytime to switch everything back on.</p></details>
          <details class="cfaq-item"><summary>Where do I get help?</summary><p>The Discord community — that's where setup, licenses and support all live. Real people, quick answers.</p></details>
        </div>
      </div>
      <!-- Final CTA -->
      <div class="csell-final">
        <h2>Ready to collect everything?</h2>
        <p>Grab your Core license on Discord, paste it into Desk, and let the bot sweep up every point Microsoft offers.</p>
        <button class="btn-csell-primary" onclick="window.open('https://discord.gg/JWhCkhSYtg')">Get Core on Discord <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
      </div>
      </div><!-- /core-view-market -->
    </div>

    <!-- Plugins view -->
    <div class="plugins-wrap" id="view-plugins">
      <div class="plugins-head">
        <div class="plugins-head-top">
          <div class="plugins-head-ico">
            <svg viewBox="0 0 24 24"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>
          </div>
          <div class="plugins-head-titles">
            <div class="plugins-head-title">Plugins<span class="beta-badge">BETA</span></div>
            <div class="plugins-head-sub">Extend your bot with official and community add-ons.</div>
          </div>
          <div class="plugins-head-actions">
            <div class="plugins-search-wrap">
              <svg class="plugins-search-ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input class="plugins-search" id="plugins-search" type="text" placeholder="Search plugins…" autocomplete="off" spellcheck="false">
            </div>
            <button class="pbtn-icon" id="plugins-refresh-btn" title="Refresh store">
              <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>
            </button>
            <button class="pbtn-primary" id="plugins-publish-btn">
              <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Publish
            </button>
          </div>
        </div>
        <div class="plugins-tabsrow">
          <div class="plugins-tabs" id="plugins-tabs">
            <button class="plugins-tab active" data-pfilter="all">All</button>
            <button class="plugins-tab" data-pfilter="installed" id="ptab-installed">Installed</button>
            <button class="plugins-tab" data-pfilter="marketplace" id="ptab-marketplace">Store</button>
          </div>
          <button class="ptxt-btn" id="plugins-doc-btn">Dev guide ↗</button>
        </div>
      </div>
      <div class="plugins-body" id="plugins-catalog"></div>
    </div>

  <!-- Dedicated Account Edit Page -->
  <div class="view-full" id="view-accedit">
    <!-- Page header -->
    <div style="display:flex;align-items:center;gap:14px;padding:clamp(12px,1.5vh,18px) clamp(18px,2vw,30px);border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:rgba(4,10,20,.5)">
      <button id="acc-modal-cancel" class="btn-icon" title="Back to Accounts">
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div id="acc-modal-avatar" class="acc-modal-avatar" style="flex-shrink:0">+</div>
      <div style="flex:1;min-width:0">
        <h2 id="acc-modal-title" style="margin:0;font-size:clamp(15px,1.3vw,19px);font-weight:700">Add account</h2>
        <p style="margin:2px 0 0;color:var(--muted);font-size:clamp(11px,0.85vw,12.5px)">Stored locally &mdash; encrypted on disk.</p>
      </div>
      <button class="btn btn-primary" id="acc-modal-save" style="flex-shrink:0;border-radius:12px">Save account</button>
    </div>
    <!-- Two-column form body -->
    <div style="flex:1;overflow-y:auto;padding:clamp(14px,2vh,24px) clamp(18px,2.2vw,32px);display:grid;grid-template-columns:1fr 1fr;gap:clamp(14px,2vw,28px);align-content:start">
      <!-- LEFT: Credentials -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="acc-form-section-head">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg>
          Credentials
        </div>
        <div class="modal-field">
          <label>Email</label>
          <input class="modal-input" id="acc-email" type="email" autocomplete="off" placeholder="account@outlook.com">
        </div>
        <div class="modal-field">
          <label>Password</label>
          <div class="modal-pw">
            <input class="modal-input" id="acc-password" type="password" autocomplete="new-password" placeholder="Password" readonly onfocus="this.removeAttribute('readonly');">
            <button class="modal-pw-toggle" type="button" id="acc-pw-toggle">
              <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <div class="modal-field">
          <label>TOTP secret <span class="lbl-opt">(optional)</span></label>
          <input class="modal-input" id="acc-totp" autocomplete="off" placeholder="Base32 secret — only if 2FA enabled">
        </div>
        <div class="modal-field">
          <label>Recovery email <span class="lbl-opt">(optional)</span></label>
          <input class="modal-input" id="acc-recovery" type="email" autocomplete="off" placeholder="recovery@outlook.com">
        </div>
      </div>
      <!-- RIGHT: Region, Proxy, Fingerprint -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="acc-form-section-head">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          Region &amp; Dashboard
        </div>
        <div class="acc-grid-2">
          <div class="modal-field">
            <label>Geo locale</label>
            <input class="modal-input" id="acc-geo" autocomplete="off" placeholder="auto">
          </div>
          <div class="modal-field">
            <label>Language</label>
            <input class="modal-input" id="acc-lang" autocomplete="off" placeholder="en">
          </div>
        </div>
        <div class="modal-field">
          <label>Dashboard variant <span class="lbl-opt">(auto-detected)</span></label>
          <select class="modal-input" id="acc-dashboard-mode">
            <option value="auto">Auto-detect (recommended)</option>
            <option value="next">Force new dashboard</option>
            <option value="legacy">Force classic (ASP)</option>
          </select>
        </div>
        <div class="acc-form-section-head" style="margin-top:6px">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          Proxy <span class="lbl-opt" style="font-weight:400;font-size:10px;margin-left:4px">(optional)</span>
        </div>
        <div class="modal-field" style="margin-top: 4px; margin-bottom: 8px; font-size: 11px; color: var(--muted); background: rgba(255,255,255,.025); border: 1px solid var(--border); padding: 8px 10px; border-radius: 8px;">
           <span style="color:var(--cyan);font-weight:600">💡 Recommendation:</span> We recommend <b>Decodo</b> for mobile proxies. They offer high success rates with Microsoft Rewards and excellent sticky session stability to minimize ban risks. Avoid cheap datacenter proxies.
        </div>
        <div class="modal-field">
          <label>Host / URL</label>
          <input class="modal-input" id="acc-proxy-url" autocomplete="off" placeholder="http://host or ip">
        </div>
        <div class="acc-grid-2" style="gap: 12px; margin-top: 8px;">
          <div class="modal-field">
            <label>Port</label>
            <input class="modal-input" id="acc-proxy-port" type="number" autocomplete="off" placeholder="8080">
          </div>
          <label class="cfg-check" style="align-self:flex-end" title="Route the HTTP client (dashboard checks) through this proxy too, not just the browser">
            <span>Use Axios</span>
            <label class="toggle"><input type="checkbox" id="acc-proxy-axios"><span class="toggle-slider"></span></label>
          </label>
        </div>
        <div class="acc-grid-2" style="gap: 12px; margin-top: 8px;">
          <div class="modal-field">
            <label>Username</label>
            <input class="modal-input" id="acc-proxy-user" autocomplete="off" placeholder="user">
          </div>
          <div class="modal-field">
            <label>Password</label>
            <input class="modal-input" id="acc-proxy-pass" type="password" autocomplete="new-password" placeholder="pass" readonly onfocus="this.removeAttribute('readonly');">
          </div>
        </div>
        <div style="margin-top: 10px; display: flex; gap: 10px; align-items: center;">
          <button class="btn btn-secondary" id="btn-test-single-proxy" type="button" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px;">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Test proxy connection
          </button>
          <div id="test-single-proxy-result" style="font-size:12px; font-weight:600; min-height:16px;"></div>
        </div>
        <div class="modal-field" style="margin-top: 8px;">
          <label>Strict proxy mode <span class="lbl-opt">(this account)</span></label>
          <select class="modal-input" id="acc-strict-proxy">
            <option value="auto">Use global setting (Settings &gt; Behavior)</option>
            <option value="require">Always require a proxy — skip this account if none is set</option>
            <option value="exempt">Never require a proxy — always run this account</option>
          </select>
        </div>
        <div class="acc-form-section-head" style="margin-top:6px">
          <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          Fingerprint
        </div>
        <div class="acc-grid-2">
          <label class="cfg-check"><span>Desktop</span>
            <label class="toggle"><input type="checkbox" id="acc-fp-desktop"><span class="toggle-slider"></span></label>
          </label>
          <label class="cfg-check"><span>Mobile</span>
            <label class="toggle"><input type="checkbox" id="acc-fp-mobile"><span class="toggle-slider"></span></label>
          </label>
        </div>
        <div class="modal-msg" id="acc-modal-msg" style="color:var(--rose);font-size:12px;min-height:16px;margin-top:4px"></div>
      </div>
    </div>
  </div>

    <!-- Docs view -->
    <div class="docs-wrap" id="view-docs">
      <div class="docs-head">
        <span class="card-label">Documentation</span>
        <div class="console-head-actions">
          <button class="btn btn-secondary btn-sm" id="docs-github">Open on GitHub ↗</button>
          <button class="btn btn-secondary btn-sm" id="docs-back">← Back</button>
        </div>
      </div>
      <div class="docs-body">
        <div class="docs-sidebar">
          <input class="docs-search" id="docs-search" type="text" placeholder="Search docs…" autocomplete="off" spellcheck="false">
          <div class="docs-nav" id="docs-nav"></div>
        </div>
        <div class="docs-content" id="docs-content"><div class="docs-loading">Loading documentation…</div></div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="footer" id="footer-bar">
      <div class="footer-left">
        <span><span class="footer-dot" id="fdot"></span><span id="ftxt">Bot ready</span></span>
        <span id="facc" style="opacity:.6"></span>
      </div>
    </footer>
  </main>

  <!-- GitHub Star modal -->
  <div class="modal-bg" id="star-modal">
    <div class="modal star-modal-content" style="text-align:center; padding:32px 36px;">
      <img src="/star.gif" class="star-modal-gif" alt="Star Animation">
      <h2>Enjoying the bot? ⭐</h2>
      <p>If Microsoft Rewards Bot has saved you time, a GitHub star goes a long way — it helps the project grow and keeps it free for everyone.</p>
      <div class="modal-actions" style="grid-template-columns:1fr; gap:10px; margin-top:0;">
        <button class="btn btn-star" id="star-btn-go">
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          Star on GitHub
        </button>
        <button class="btn btn-secondary" id="star-btn-later">Maybe later</button>
      </div>
    </div>
  </div>

  <!-- Config modal (Notifications / dashboard sync) -->
  <div class="modal-bg" id="cfg-modal">
    <div class="modal">
      <h2 id="cfg-modal-title">Configure</h2>
      <p id="cfg-modal-sub">Changes are saved automatically.</p>
      <div id="cfg-modal-body"></div>
      <div class="modal-actions" style="grid-template-columns:1fr">
        <button class="btn btn-primary" id="cfg-modal-done">Done</button>
      </div>
    </div>
  </div>

  <!-- Phone & remote access -->
  <div class="modal-bg" id="remote-modal">
    <div class="modal" style="max-width:460px">
      <h2>Use on your phone</h2>
      <p>Open or scan this link on your phone &mdash; it checks where you are and routes you automatically.</p>
      <div style="border:1px solid var(--border); border-radius:12px; padding:16px; margin-top:6px; text-align:center">
        <div id="remote-go-url" style="font-family:monospace; color:#3bc9ff; word-break:break-all; user-select:all; font-size:15px; font-weight:600">${DASHBOARD_URL}/go</div>
        <button class="btn btn-primary" id="remote-copy" style="margin-top:14px; width:100%">Copy link</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-top:14px; line-height:1.6">
        <span style="color:#7fe6ad; font-weight:650">Same Wi-Fi</span> &rarr; opens this Desk directly.<br>
        <span style="color:var(--gold); font-weight:650">Anywhere else</span> &rarr; opens Nexus (Core) &mdash; control from any network.
      </div>
      <div id="remote-lan-off-hint" style="display:none; font-size:11.5px; color:var(--muted); margin-top:10px; opacity:.92">
        Local network access is off, so the link opens Nexus. <a id="remote-goto-settings" style="color:var(--cyan); cursor:pointer; text-decoration:underline">Turn it on</a> for free same-Wi-Fi access.
      </div>
      <div class="modal-actions" style="grid-template-columns:1fr; margin-top:16px">
        <button class="btn btn-secondary" id="remote-close">Close</button>
      </div>
    </div>
  </div>

    <!-- Feedback Modal -->
    <div class="modal-bg" id="fb-modal">
      <div class="lic-card" style="width: min(440px, 92%); border-radius:24px; overflow:hidden">
        <div class="lic-banner-wrap" style="height:110px; flex-shrink:0">
          <div class="lic-banner-tint"></div>
          <div class="lic-banner-badges">
            <svg viewBox="0 0 24 24" style="width:34px;height:34px;color:var(--gold);filter:drop-shadow(0 0 10px rgba(247,200,92,0.5))" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            <div>
              <div class="lic-banner-title" id="fb-title">Rate Core</div>
              <div class="lic-banner-ver">Your Feedback</div>
            </div>
          </div>
        </div>
        <div class="lic-body" style="text-align:center; padding:24px 30px 30px">
          <p style="color:rgba(180,200,230,.8); font-size:14px; line-height:1.6; margin-bottom:18px" id="fb-desc">How would you rate your premium experience so far?</p>
          <div class="rating-stars" id="fb-stars" style="margin-bottom:20px; justify-content:center">
            <div class="rating-star" data-val="1"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
            <div class="rating-star" data-val="2"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
            <div class="rating-star" data-val="3"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
            <div class="rating-star" data-val="4"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
            <div class="rating-star" data-val="5"><svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
          </div>
          <textarea class="fb-textarea" id="fb-comment" placeholder="Any suggestions or issues? (optional)" style="background:rgba(2,7,16,.4); border:1px solid rgba(255,255,255,.05); border-radius:14px; padding:16px; font-size:13.5px"></textarea>
          <div class="lic-actions" style="margin-top:20px; flex-direction:row">
            <button class="btn-lic-secondary" id="fb-btn-skip" style="flex:1; justify-content:center; border-radius:100px">Maybe later</button>
            <button class="btn-lic-primary" id="fb-btn-submit" style="flex:1; justify-content:center; border-radius:100px" disabled>Submit</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Comment Modal -->
    <div class="modal-bg" id="comment-modal">
      <div class="lic-card" style="width: min(460px, 92%); border-radius:24px; overflow:hidden">
        <div class="lic-banner-wrap" style="height:110px; flex-shrink:0">
          <div class="lic-banner-tint"></div>
          <div class="lic-banner-badges">
            <svg viewBox="0 0 24 24" style="width:34px;height:34px;color:rgba(180,200,230,.9)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
            <div>
              <div class="lic-banner-title">General Feedback</div>
              <div class="lic-banner-ver">Suggestions & Issues</div>
            </div>
          </div>
        </div>
        <div class="lic-body" style="text-align:center; padding:24px 30px 30px">
          <p style="color:rgba(180,200,230,.8); font-size:14px; line-height:1.6; margin-bottom:18px">We're always looking to improve Rewards Desk.</p>
          <textarea class="fb-textarea" id="general-comment" placeholder="Describe your thoughts here..." style="height:120px; background:rgba(2,7,16,.4); border:1px solid rgba(255,255,255,.05); border-radius:14px; padding:16px; font-size:13.5px"></textarea>
          <div class="lic-actions" style="margin-top:20px; flex-direction:row">
            <button class="btn-lic-secondary" id="comment-btn-cancel" style="flex:1; justify-content:center; border-radius:100px">Cancel</button>
            <button class="btn-lic-primary" id="comment-btn-submit" style="flex:1; justify-content:center; border-radius:100px">Submit</button>
          </div>
        </div>
      </div>
    </div>


    <!-- Core activation overlay -->
  <div class="lic-overlay" id="lic-overlay">
    <div class="lic-card">
      <div class="lic-confetti" id="lic-confetti"></div>
      <div class="lic-banner-wrap">
        <img src="/banner-core.png" class="lic-banner-img" alt="">
        <div class="lic-banner-tint"></div>
        <div class="lic-banner-badges">
          <img src="/app-icon.png" class="lic-banner-logo" alt="">
          <div>
            <div class="lic-banner-title">Rewards Desk</div>
            <div class="lic-banner-ver">v${APP_VERSION}</div>
          </div>
        </div>
      </div>
      <div class="lic-body">
        <!-- Welcome -->
        <div id="lic-view-welcome">
          <h2>Unlock Core</h2>
          <p>Core is the official premium plugin — it adds coupon claiming, streak protection, doubled search points, the remote dashboard and more on top of the free open-source bot.</p>
          <div class="lic-feats">
            <div class="lic-feat"><svg viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Coupon claiming</div>
            <div class="lic-feat"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Streak protection</div>
            <div class="lic-feat"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Double search pts</div>
            <div class="lic-feat"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Remote dashboard</div>
          </div>
          <div class="lic-hint"><a href="https://github.com/QuestPilot/Microsoft-Rewards-Bot/blob/main/docs/core-plugin.md" target="_blank">Get a license key →</a></div>
          <div class="lic-actions">
            <button class="btn-lic-primary" id="lic-btn-show-key">Activate Core →</button>
            <button class="btn-lic-secondary" id="lic-btn-skip-welcome">Continue without Core</button>
          </div>
        </div>
        <!-- Key entry -->
        <div id="lic-view-key" style="display:none">
          <div class="lic-back-row" id="lic-btn-back">
            <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>Back
          </div>
          <h2>License key</h2>
          <p>Your key is validated online, then stored encrypted on this machine. The bot picks it up automatically on its next run.</p>
          <input class="lic-key-input" id="lic-key" placeholder="MSRB-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="29">
          <div class="lic-error" id="lic-key-error"></div>
          <div class="lic-actions">
            <button class="btn-lic-primary" id="lic-btn-activate">Activate</button>
            <button class="btn-lic-secondary" id="lic-btn-skip-key">Continue without Core</button>
          </div>
          <div class="lic-hint"><a href="https://github.com/QuestPilot/Microsoft-Rewards-Bot/blob/main/docs/core-plugin.md" target="_blank">Get a license key →</a></div>
        </div>
        <!-- Success -->
        <div id="lic-view-success" style="display:none">
          <div class="lic-success-wrap">
            <div class="lic-success-ring">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2>Core activated!</h2>
            <div class="lic-success-plan" id="lic-success-plan">Premium</div>
            <div class="lic-success-expires" id="lic-success-expires"></div>
            <button class="btn-lic-primary" id="lic-btn-success-close" style="margin-top:10px;width:auto;padding:12px 32px">Let's go →</button>
          </div>
        </div>
        <!-- Active license management -->
        <div id="lic-view-manage" style="display:none">
          <div class="lic-success-wrap">
            <div class="lic-success-ring">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2>Core is active</h2>
            <div class="lic-success-plan" id="lic-manage-plan">Premium</div>
            <div class="lic-success-expires" id="lic-manage-expires"></div>
            <p style="margin:4px 0 8px">This computer is linked to your Core license and can use premium features and remote access.</p>
            <button class="btn-lic-secondary btn-lic-danger" id="lic-btn-deactivate">Deactivate Core on this computer</button>
            <button class="btn-lic-secondary" id="lic-btn-manage-close">Close</button>
            <div class="lic-error" id="lic-deactivate-error"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Desktop installation -->
  <div class="lic-overlay" id="install-overlay">
    <div class="lic-card">
      <div class="lic-banner-wrap">
        <img src="/banner-core.png" class="lic-banner-img" alt="">
        <div class="lic-banner-tint"></div>
        <div class="lic-banner-badges">
          <img src="/app-icon.png" class="lic-banner-logo" alt="">
          <div><div class="lic-banner-title">Install Rewards Desk</div><div class="lic-banner-ver">Quick access from your computer</div></div>
        </div>
      </div>
      <div class="lic-body">
        <h2>Install shortcuts</h2>
        <div class="install-status-grid">
          <div class="install-status-item" id="install-status-desktop"><b>Desktop</b><span>Checking…</span></div>
          <div class="install-status-item" id="install-status-menu"><b>App menu</b><span>Checking…</span></div>
        </div>
        <div class="lic-actions">
          <button class="btn-lic-primary" id="install-create">Install</button>
          <button class="btn-lic-secondary" id="install-close">Close</button>
        </div>
        <div class="lic-error" id="install-error"></div>
      </div>
    </div>
  </div>

  <script>
    var API_TOKEN = ${JSON.stringify(API_TOKEN)};
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      init = init || {};
      var url = typeof input === 'string' ? input : input.url;
      if (new URL(url, location.href).origin === location.origin) {
        var headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        headers.set('x-msrb-token', API_TOKEN);
        init.headers = headers;
      }
      return nativeFetch(input, init);
    };
    var G = function(id){return document.getElementById(id);};
    var CIRC = 251.3;
    var view = 'dash';
    var accEditIdx = -1;
    var _licActivated = false;
    var _licClientReady = false;
    var _coreData = { tier: 'free' };
    var _licensePromptVisible = false;
    var _runAfterLicenseFlow = false;
    var _storageConfirmation = '';
    var _toastTimer = null;
    var _bootOverlayReleased = false;
    var PLUGIN_DOC_URL = 'https://github.com/QuestPilot/Microsoft-Rewards-Bot/blob/main/docs/create-plugin.md';
    var DOCS_GITHUB_URL = 'https://github.com/QuestPilot/Microsoft-Rewards-Bot/tree/main/docs';

    var _ctxMenu = null;
    var _ctxAccIdx = -1;
    document.addEventListener('contextmenu', function(e) {
      if (e.target && e.target.closest && e.target.closest('#console-box')) return;
      e.preventDefault();
      if (!_ctxMenu) _ctxMenu = G('ctx-menu');
      if (!_ctxMenu) return;
      // Detect if a right-click is on an account row
      var accRow = e.target.closest && e.target.closest('[data-email]');
      var accItems = _ctxMenu.querySelectorAll('.ctx-acc-only');
      if (accRow) {
        var email = accRow.getAttribute('data-email');
        _ctxAccIdx = _raw ? _raw.findIndex(function(a) { return (a.email || '') === email; }) : -1;
        var acc = _ctxAccIdx >= 0 && _raw ? _raw[_ctxAccIdx] : null;
        var toggleLabel = G('ctx-acc-toggle-label');
        if (toggleLabel) toggleLabel.textContent = acc && acc.enabled === false ? 'Enable account' : 'Disable account';
        accItems.forEach(function(el) { el.style.display = ''; });
      } else {
        _ctxAccIdx = -1;
        accItems.forEach(function(el) { el.style.display = 'none'; });
      }
      _ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 210) + 'px';
      _ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 60) + 'px';
      _ctxMenu.classList.add('open');
    });
    document.addEventListener('click', function(e) {
      if (_ctxMenu) _ctxMenu.classList.remove('open');
      var t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      if (t.closest('#ctx-open-folder') || t.closest('#btn-open-folder')) {
        fetch('/api/open-folder', {method:'POST'}).catch(function(){});
        return;
      }
      if (t.closest('#ctx-acc-edit')) {
        if (_ctxAccIdx >= 0) openAccEdit(_ctxAccIdx);
        return;
      }
      if (t.closest('#ctx-acc-toggle')) {
        if (_ctxAccIdx >= 0) toggleAcc(_ctxAccIdx);
        return;
      }
      if (t.closest('#ctx-acc-copy')) {
        var acc = _ctxAccIdx >= 0 && _raw ? _raw[_ctxAccIdx] : null;
        if (acc && acc.email) {
          navigator.clipboard.writeText(acc.email).then(function() {
            showToast('Email copied to clipboard');
          }).catch(function() {});
        }
        return;
      }
      if (t.closest('#ctx-acc-delete')) {
        if (_ctxAccIdx >= 0) deleteAcc(_ctxAccIdx);
        return;
      }
    });
    document.addEventListener('dragstart', function(e) { e.preventDefault(); });
    document.addEventListener('keydown', function(e) {
      // F12 stays blocked (too easy to hit by accident). Ctrl+Shift+I / J / C are
      // left to Chromium so DevTools remain reachable for debugging the Desk.
      if (e.key === 'F12') { e.preventDefault(); e.stopPropagation(); }
    }, true);

    function showToast(message, isError) {
      var toast = G('toast');
      var icon = isError ? '<svg viewBox="0 0 24 24" style="width:18px;height:18px;flex-shrink:0;color:var(--rose)" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' : '<svg viewBox="0 0 24 24" style="width:18px;height:18px;flex-shrink:0;color:var(--cyan)" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      toast.innerHTML = icon + '<span>' + esc(message) + '</span>';
      toast.classList.toggle('error', !!isError);
      toast.classList.add('show');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function(){toast.classList.remove('show');}, 3500);
    }
    function releaseBootOverlay() {
      if (_bootOverlayReleased) return;
      _bootOverlayReleased = true;
      var boot = G('app-boot');
      if (!boot) return;
      boot.classList.add('ready');
      boot.style.opacity = '0';
      boot.style.visibility = 'hidden';
      boot.style.pointerEvents = 'none';
      setTimeout(function(){if (boot.parentNode) boot.parentNode.removeChild(boot);}, 320);
    }
    setTimeout(function(){
      releaseBootOverlay();
    }, 5000);

    function setButtonBusy(button, busy, label) {
      if (!button) return;
      if (busy) {
        button.dataset.idleText = button.textContent;
        if (label) button.textContent = label;
      } else if (button.dataset.idleText) {
        button.textContent = button.dataset.idleText;
        delete button.dataset.idleText;
      }
      button.disabled = !!busy;
      button.classList.toggle('action-busy', !!busy);
    }

    // ── Core feature gating (config.json core.*) ──
    var CORE_KEYS = ['claimPoints','applyCoupons','doubleSearchPoints','exploreOnBing','appReward','readToEarn',
      'dailyCheckIn','dailyStreak','streakProtection','temporaryPunchcards','collectDashboardInfo','setGoal',
      'captureDashboardPages'];
    // Core features whose run also depends on an open-source worker flag being on.
    var CORE_WORKER_MAP = {
      claimPoints:'doClaimPoints', applyCoupons:'doApplyCoupons', readToEarn:'doReadToEarn',
      dailyCheckIn:'doDailyCheckIn', dailyStreak:'doDailyStreak', collectDashboardInfo:'doDashboardInfo'
    };
    // Core features that only exist on the new (Next.js) dashboard. They silently
    // no-op on classic (ASP) accounts, so the UI badges them and never credits
    // their estimated points to accounts forced onto the legacy dashboard.
    var CORE_NEXT_ONLY = { applyCoupons:true, temporaryPunchcards:true, setGoal:true };

    // ── Config popup forms (essentials on top, advanced expander) ──
    var CFG_FORMS = {
      discord: {
        title: 'Discord log webhook', sub: 'Stream selected console logs to this Discord channel.',
        essential: [
          { label:'Webhook URL', path:'webhook.discord.url', type:'text', placeholder:'https://discord.com/api/webhooks/...' }
        ],
        advanced: [
          { label:'Filter which logs are sent', path:'webhook.webhookLogFilter.enabled', type:'checkbox' },
          { label:'Filter mode', path:'webhook.webhookLogFilter.mode', type:'select', options:['whitelist','blacklist'] },
          { label:'Levels', path:'webhook.webhookLogFilter.levels', type:'csv', hint:'Comma-separated: error, warn, info' },
          { label:'Keywords', path:'webhook.webhookLogFilter.keywords', type:'csv', hint:'Only send logs containing these words' }
        ]
      },
      ntfy: {
        title: 'ntfy push', sub: 'Send notifications to an ntfy topic or self-hosted server.',
        essential: [
          { label:'Server URL', path:'webhook.ntfy.url', type:'text', placeholder:'https://ntfy.sh' },
          { label:'Topic', path:'webhook.ntfy.topic', type:'text', placeholder:'my-rewards-bot' },
          { label:'Access token', path:'webhook.ntfy.token', type:'text', placeholder:'tk_... (optional)' }
        ],
        advanced: [
          { label:'Notification title', path:'webhook.ntfy.title', type:'text', placeholder:'Microsoft-Rewards-Bot' },
          { label:'Tags', path:'webhook.ntfy.tags', type:'csv', hint:'Comma-separated, e.g. bot, notify' },
          { label:'Priority (1–5)', path:'webhook.ntfy.priority', type:'number', placeholder:'3' }
        ]
      },
      _runSummaryRemoved: null /* runSummary replaced by analytics — key kept to avoid openCfgModal('runSummary') crash on stale HTML caches */
    };

    // Animated number count-up
    function animateCount(el, to, prefix) {
      prefix = prefix || '';
      var from = el._cv || 0;
      if (from === to) { el.textContent = prefix + to; return; }
      el._cv = to;
      var start = performance.now(), dur = 550;
      function step(now) {
        var p = Math.min(1, (now - start) / dur);
        var e = 1 - Math.pow(1 - p, 3); // easeOutCubic
        var v = Math.round(from + (to - from) * e);
        el.textContent = prefix + (v >= 0 ? v : v);
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = prefix + to;
      }
      requestAnimationFrame(step);
    }
    // Display the next scheduled run time from a cache of the last /api/settings
    // response. nextRunAt is computed server-side (real Intl timezone math against
    // scheduler.timezone, see computeSchedulerNextRunAt in app-window.js) — this only
    // diffs two absolute instants, so it stays correct no matter what timezone the
    // browser viewing the Desk is in (e.g. viewing a VPS bot's Desk remotely).
    var _schedCache = null;
    function updateNextRun() {
      var el = G('st-next'); if (!el) return;
      var sc = _schedCache;
      if (!sc || !sc.enabled || !sc.startTime || !sc.nextRunAt) { el.style.display = 'none'; return; }
      var next = new Date(sc.nextRunAt);
      var now = new Date();
      if (isNaN(next.getTime())) { el.style.display = 'none'; return; }
      var diffMin = Math.max(0, Math.round((next - now) / 60000));
      var when = diffMin < 60 ? (diffMin + ' min') : (Math.floor(diffMin / 60) + 'h ' + (diffMin % 60) + 'm');
      el.textContent = 'Next run at ' + sc.startTime + ' (in ' + when + ')';
      el.style.display = 'flex';
    }

    function getPath(obj, path) {
      var parts = path.split('.'), cur = obj;
      for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
      return cur;
    }
    function _cfgFieldHtml(f, val) {
      var id = 'cfg-f-' + f.path.replace(/\\./g, '-');
      if (f.type === 'checkbox') {
        return '<div class="cfg-field"><label class="cfg-check"><span>' + f.label + '</span>' +
          '<label class="toggle"><input type="checkbox" id="' + id + '"' + (val ? ' checked' : '') +
          '><span class="toggle-slider"></span></label></label></div>';
      }
      var v = val == null ? '' : (Array.isArray(val) ? val.join(', ') : String(val));
      var input;
      if (f.type === 'select') {
        input = '<select class="cfg-input" id="' + id + '">' + f.options.map(function(o) {
          return '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + o + '</option>';
        }).join('') + '</select>';
      } else {
        input = '<input class="cfg-input" id="' + id + '" type="' + (f.type === 'number' ? 'number' : 'text') +
          '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">';
      }
      return '<div class="cfg-field"><label for="' + id + '">' + f.label + '</label>' + input +
        (f.hint ? '<div class="cfg-hint">' + f.hint + '</div>' : '') + '</div>';
    }
    function _cfgBind(f) {
      var id = 'cfg-f-' + f.path.replace(/\\./g, '-');
      var el = G(id); if (!el) return;
      var ev = (f.type === 'checkbox' || f.type === 'select') ? 'change' : 'input';
      var save = function() {
        var v;
        if (f.type === 'checkbox') v = el.checked;
        else if (f.type === 'number') v = el.value === '' ? 0 : Number(el.value);
        else if (f.type === 'csv') v = el.value.split(',').map(function(x){return x.trim();}).filter(Boolean);
        else v = el.value;
        // Validate webhook URLs before saving (must be http/https).
        if (typeof v === 'string' && f.path.toLowerCase().slice(-3) === 'url' && v) {
          var okUrl = v.indexOf('http://') === 0 || v.indexOf('https://') === 0;
          if (!okUrl) {
            el.style.borderColor = '#ff4b6e';
            el.title = 'Enter a valid http(s) URL';
            return;
          }
          el.style.borderColor = '';
          el.title = '';
        }
        saveSetting(f.path, v);
      };
      el.addEventListener(ev, save);
    }
    async function openCfgModal(key) {
      var form = CFG_FORMS[key]; if (!form) return;
      var s = {}; try { s = await fetch('/api/settings').then(function(r){return r.json();}); } catch(e) {}
      G('cfg-modal-title').textContent = form.title;
      G('cfg-modal-sub').textContent = form.sub || 'Changes are saved automatically.';
      var html = form.essential.map(function(f){ return _cfgFieldHtml(f, getPath(s, f.path)); }).join('');
      if (form.advanced && form.advanced.length) {
        html += '<details class="cfg-adv"><summary>Advanced settings</summary>' +
          form.advanced.map(function(f){ return _cfgFieldHtml(f, getPath(s, f.path)); }).join('') + '</details>';
      }
      G('cfg-modal-body').innerHTML = html;
      form.essential.forEach(_cfgBind);
      if (form.advanced) form.advanced.forEach(_cfgBind);
      G('cfg-modal').classList.add('open');
    }
    async function loadNotifPage(key) {
      var form = CFG_FORMS[key]; if (!form) return;
      var s = {}; try { s = await fetch('/api/settings').then(function(r){return r.json();}); } catch(e) {}
      var bodyEl = G('notif-' + key + '-body'); if (!bodyEl) return;
      var html = '<div class="settings-section" style="border:none;padding:0;background:none">' +
        form.essential.map(function(f){ return _cfgFieldHtml(f, getPath(s, f.path)); }).join('');
      if (form.advanced && form.advanced.length) {
        html += '<details class="cfg-adv"><summary>Advanced settings</summary>' +
          form.advanced.map(function(f){ return _cfgFieldHtml(f, getPath(s, f.path)); }).join('') + '</details>';
      }
      html += '</div>';
      bodyEl.innerHTML = html;
      form.essential.forEach(_cfgBind);
      if (form.advanced) form.advanced.forEach(_cfgBind);
      // Sync toggle state from current settings
      var wh = (s.webhook || {})[key] || {};
      var tog = G('tog-wh-' + key);
      if (tog) tog.checked = !!wh.enabled;
    }

    // ── View ──────────────────────────────────
    function setView(v) {
      view = v;
      var dash = G('view-dash');
      dash.style.display = v === 'dash' ? 'flex' : 'none';
      if (v === 'dash') {
        // Force layout recalc so flex children fill height correctly
        dash.style.height = '100%';
      }
      G('view-accounts').className = v === 'accounts' ? 'view-full vis' : 'view-full';
      G('view-console').className = v === 'console' ? 'console-wrap vis' : 'console-wrap';
      G('view-settings').className = v === 'settings' ? 'settings-wrap vis' : 'settings-wrap';
      G('view-core').className = v === 'core' ? 'core-view vis' : 'core-view';
      G('view-insights').className = v === 'insights' ? 'core-view vis' : 'core-view';
      G('view-plugins').className = v === 'plugins' ? 'plugins-wrap vis' : 'plugins-wrap';
      G('view-docs').className = v === 'docs' ? 'docs-wrap vis' : 'docs-wrap';
      G('view-accedit').className = v === 'accedit' ? 'view-full vis' : 'view-full';
      G('view-notif-discord').className = v === 'notif-discord' ? 'view-full vis' : 'view-full';
      G('view-notif-ntfy').className = v === 'notif-ntfy' ? 'view-full vis' : 'view-full';
      G('footer-bar').style.display = (v === 'dash' || v === 'accounts') ? '' : 'none';
      // Nav highlight — notif sub-pages keep 'settings' nav active
      var navActive = (v === 'notif-discord' || v === 'notif-ntfy') ? 'settings' : v;
      ['dash','accounts','console','settings','core','insights','plugins','docs'].forEach(function(n) {
        var el = G('nav-' + n); if (el) el.classList.toggle('active', n === navActive);
      });
      if (v === 'accounts') {
        loadAccEditor();
        if (!_hintSeen('acc-dbl')) showHint('acc-dbl', 700);
        else showHint('acc-rclick', 700);
      }
      if (v === 'settings') { _settGo(_settTab); loadSettings(); }
      if (v === 'notif-discord') { loadNotifPage('discord'); showHint('notif-discord', 400); }
      if (v === 'notif-ntfy') { loadNotifPage('ntfy'); showHint('notif-ntfy', 400); }
      if (v === 'core') renderCoreView();
      if (v === 'insights') loadInsights();
      if (v === 'plugins') loadPluginsCatalog(false);
      if (v === 'docs') loadDocs();
      if (v === 'console') {
        // Entering the console always snaps to the latest line.
        var cb = G('console-box');
        if (cb) { cb._stick = true; updateConsoleBox(false); cb.scrollTop = cb.scrollHeight; updateJumpBtn(cb); }
      }
      var viewId = (v === 'dash') ? 'view-dash' : 'view-' + v;
      var active = G(viewId);
      if (active) {
        active.classList.remove('view-animate');
        void active.offsetWidth;
        active.classList.add('view-animate');
      }
    }

    function setRing(pct) {
      var el = G('ring-path');
      if (el) el.style.strokeDashoffset = CIRC * (1 - Math.min(100, Math.max(0, pct || 0)) / 100);
    }

    async function loadInsights() {
      var data;
      try { data = await fetch('/api/insights').then(function(r){return r.json();}); } catch(e) { return; }
      var empty = G('ins-empty'), body = G('ins-body');
      var t = data ? data.totals || {} : {};
      if (!data || !data.hasData || (t.points || 0) < 500) {
        if (empty) empty.style.display = 'block';
        if (body) body.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (body) body.style.display = 'flex';
      var t = data.totals || {};
      var kpis = [
        { v: (t.points || 0).toLocaleString(), l: 'Total points' },
        { v: '+' + (t.last7Points || 0).toLocaleString(), l: 'Last 7 days' },
        { v: t.successRate != null ? t.successRate + '%' : '—', l: 'Success rate' },
        { v: (t.accountsTracked || 0), l: 'Accounts' }
      ];
      G('ins-kpis').innerHTML = kpis.map(function(k){
        return '<div class="ins-kpi"><div class="ins-kpi-val">' + esc(k.v) + '</div><div class="ins-kpi-lbl">' + esc(k.l) + '</div></div>';
      }).join('');
      var daily = data.daily || [];
      var max = daily.reduce(function(m, d){ return Math.max(m, d.points || 0); }, 0) || 1;
      G('ins-chart').innerHTML = daily.length ? daily.map(function(d){
        var h = Math.max(2, Math.round(((d.points || 0) / max) * 100));
        var cls = (d.points || 0) > 0 ? 'ins-bar' : 'ins-bar ins-bar-empty';
        return '<div class="' + cls + '" style="height:' + h + '%" title="' + esc(d.date) + ': ' + (d.points || 0) + ' pts"></div>';
      }).join('') : '<div class="ins-acc-meta">No daily data yet.</div>';
      var accts = (data.accounts || []).slice(0, 12);
      G('ins-accounts').innerHTML = accts.length ? accts.map(function(a){
        var dot = a.status === 'failing' ? 'ins-dot-failing' : (a.status === 'idle' ? 'ins-dot-idle' : 'ins-dot-ok');
        var meta = (a.runs || 0) + ' runs' + (a.successRate != null ? ' · ' + a.successRate + '%' : '');
        return '<div class="ins-acc"><span class="ins-acc-dot ' + dot + '"></span>' +
          '<div class="ins-acc-name">' + esc(a.name) + '<div class="ins-acc-meta">' + esc(meta) + '</div></div>' +
          '<span class="ins-acc-pts">' + (a.points || 0).toLocaleString() + '</span></div>';
      }).join('') : '<div class="ins-acc-meta">No account stats yet.</div>';
      var recoEl = G('ins-reco');
      var recos = data.recommendations || [];
      var existingLock = G('ins-reco-lock');
      if (data.hasCoreLicense) {
        if (existingLock) existingLock.remove();
        recoEl.innerHTML = recos.map(function(r){
          return '<div class="ins-reco-item ins-reco-' + (r.severity || 'low') + '"><div class="ins-reco-t">' + esc(r.title) + '</div><div class="ins-reco-d">' + esc(r.detail) + '</div></div>';
        }).join('');
      } else {
        recoEl.innerHTML = recos.map(function(r){
          return '<div class="ins-reco-item ins-reco-' + (r.severity || 'low') + '"><div class="ins-reco-t" style="filter:blur(4px)">' + esc(r.title) + '</div></div>';
        }).join('');
        if (!existingLock) {
          var card = recoEl.closest('.ins-reco-card');
          if (card) {
            var lock = document.createElement('div');
            lock.className = 'ins-lock'; lock.id = 'ins-reco-lock';
            lock.innerHTML = '<div class="ins-lock-t">' + recos.length + ' recommendation' + (recos.length > 1 ? 's' : '') + ' ready</div>' +
              '<div class="ins-lock-d">Unlock Core to see personalized tips on how to earn more from your accounts.</div>' +
              '<button class="btn btn-primary" id="ins-unlock">Activate Core</button>';
            card.appendChild(lock);
            var ub = G('ins-unlock'); if (ub) ub.addEventListener('click', function(){ setView('core'); });
          }
        }
      }
    }

    function esc(v) {
      return String(v).replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      });
    }

    // ── Console ───────────────────────────────
    var _consoleLogs = [];
    var _consoleFilter = 'all';
    var _consoleSearch = '';
    var _consoleClearedAt = 0;

    function getConsoleLvl(l) {
      var m = String(l.message || '').toLowerCase();
      var lv = String(l.level || '').toLowerCase();
      if (lv === 'error' || /\berror\b|fail(ed)?|exception|crash/.test(m)) return 'error';
      if (lv === 'warn'  || /warn(ing)?|\battention\b/.test(m))             return 'warn';
      if (/\bsuccess\b|complete|done|collected|\bok\b|✓/.test(m))           return 'success';
      return 'info';
    }

    function makeLogEl(l, animate) {
      var div = document.createElement('div');
      div.className = 'clog clog-' + getConsoleLvl(l) + (l.spinner ? ' clog-spinline' : '') + (animate ? ' clog-new' : '');
      var ts = new Date(l.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      var spin = l.spinner ? '<span class="clog-spin"></span>' : '';
      div.innerHTML = '<span class="clog-ts">' + ts + '</span>' + spin + '<span class="clog-msg">' + esc(l.message) + '</span>';
      return div;
    }

    function matchesConsoleFilter(l) {
      if (_consoleFilter !== 'all' && getConsoleLvl(l) !== _consoleFilter) return false;
      if (_consoleSearch && String(l.message || '').toLowerCase().indexOf(_consoleSearch) === -1) return false;
      return true;
    }

    function consoleAtBottom(b) {
      return (b.scrollHeight - b.scrollTop - b.clientHeight) < 24;
    }
    function updateJumpBtn(b) {
      var jump = G('console-jump');
      if (jump) jump.classList.toggle('show', view === 'console' && !consoleAtBottom(b));
    }

    function updateConsoleBox(incremental) {
      var b = G('console-box');
      if (!b) return;
      // Stick to the bottom unless the user has deliberately scrolled up.
      var wasBottom = b._stick !== false;
      var hasFilter = _consoleFilter !== 'all' || _consoleSearch;
      var filtered = hasFilter ? _consoleLogs.filter(matchesConsoleFilter) : _consoleLogs;

      if (!filtered.length) {
        b.innerHTML = '<div class="console-empty">' + (hasFilter ? 'No lines match this filter.' : 'No output yet — start a run to see live logs.') + '</div>';
      } else if (incremental && !hasFilter) {
        // Fast path: reconcile only the tail. Handles both newly-appended lines
        // and in-place spinner updates (where the last line's text changed but
        // the count stayed the same) without re-rendering the whole console.
        var rows = b.querySelectorAll('.clog');
        if (rows.length === _consoleLogs.length && rows.length) {
          var lastLog = _consoleLogs[_consoleLogs.length - 1];
          var lastRow = rows[rows.length - 1];
          var msgEl = lastRow.querySelector('.clog-msg');
          if (!msgEl || msgEl.textContent !== String(lastLog.message) || lastRow.classList.contains('clog-spinline') !== !!lastLog.spinner) {
            lastRow.replaceWith(makeLogEl(lastLog, false));
          }
        } else if (rows.length < _consoleLogs.length) {
          var toAdd = _consoleLogs.slice(rows.length);
          var frag = document.createDocumentFragment();
          for (var i = 0; i < toAdd.length; i++) {
            frag.appendChild(makeLogEl(toAdd[i], i >= toAdd.length - 6));
          }
          b.appendChild(frag);
        } else {
          b.innerHTML = filtered.map(function(l) { return makeLogEl(l, false).outerHTML; }).join('');
        }
      } else {
        b.innerHTML = filtered.map(function(l) { return makeLogEl(l, false).outerHTML; }).join('');
      }

      var cnt = G('console-line-count');
      if (cnt) cnt.textContent = (hasFilter ? filtered.length + '/' + _consoleLogs.length : _consoleLogs.length) + ' lines';

      if (wasBottom) b.scrollTop = b.scrollHeight;
      updateJumpBtn(b);
    }

    // ── Dashboard accounts (masked list) ──────
    function renderAccounts(accounts, active, loading, ptsMap) {
      if (loading) {
        return '<div class="loading-block"><span class="inline-spinner"></span><span>Loading protected accounts…</span></div>';
      }
      if (!accounts || !accounts.length) {
        return '<div class="acc-empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg><p>No accounts yet</p></div>';
      }
      return accounts.map(function(a) {
        var isActive = active && a.email && a.email.indexOf(active.slice(0,5)) === 0;
        var disabled = !a.enabled;
        var pts = ptsMap && a.email ? ptsMap[a.email] : 0;
        var badge = pts > 0 ? '<span class="acc-pts-badge"><svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>+' + pts.toLocaleString() + '</span>' : '';
        // avatarId is the real-email hash (server-computed, index-aligned) so the
        // masked Home list still resolves to the correct avatar file.
        var avatarKey = a.avatarId || encodeURIComponent(a.email||'');
        return '<div class="acc-row' + (isActive?' is-active':'') + (disabled?' is-disabled':'') + '">' +
          '<div class="acc-avatar"><img src="/avatars/' + avatarKey + '" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;display:block"></div>' +
          '<div class="acc-info"><div class="acc-email">' + esc(a.email||'') + '</div>' +
          '<div class="acc-st">' + (disabled?'Disabled':isActive?'Running...':'Ready') + '</div></div>' +
          badge +
          '<span class="acc-dot ' + (disabled?'dot-off':isActive?'dot-run':'dot-ready') + '"></span></div>';
      }).join('');
    }

    // ── Refresh ───────────────────────────────
    async function refresh() {
      var data;
      try { data = await fetch('/api/state').then(function(r){return r.json();}); }
      catch(e) { G('st-text').textContent = 'Offline'; return; }
      window._lastStateData = data;
      var s = data.status || 'Ready';
      var running = data.isRunning;
      var m = data.metrics || {};
      var boot = data.boot || {};
      var bootReady = !!boot.accountsReady && !!boot.licenseReady;
      if (bootReady && !_bootOverlayReleased) releaseBootOverlay();
      if (!bootReady && !_bootOverlayReleased) {
        G('app-boot-detail').textContent = !boot.accountsReady
          ? 'Loading protected accounts…'
          : 'Checking Core status…';
      }

      G('st-text').textContent = s;
      G('st-detail').textContent = data.detail || '';
      setRing(m.progress || 0);
      var rw = document.querySelector('.ring-wrap');
      if (rw) rw.classList.toggle('run', !!running);
      var heDot = G('hero-dot'); if (heDot) heDot.classList.toggle('run', !!running);
      var heTxt = G('hero-eyebrow-txt'); if (heTxt) heTxt.textContent = running ? 'Running now' : (s === 'Complete' ? 'Last run complete' : 'Ready when you are');
      updateNextRun();

      var coreOk = m.core === 'Active';
      var coreKnown = m.core === 'Active' || m.core === 'Inactive';
      var cp = G('core-pill');
      cp.style.display = (running || coreKnown) ? '' : 'none';
      cp.className = 'pill ' + (coreOk ? 'pill-ok' : 'pill-muted');
      G('core-pill-txt').textContent = coreOk ? 'Core active' : 'No Core';

      var pts = m.points;
      var hasData = running || (pts !== null && pts !== undefined);
      var pv = G('pts-val');
      if (hasData && pts !== null && pts !== undefined) {
        animateCount(pv, pts, pts >= 0 ? '+' : '');
      } else if (hasData) {
        pv.textContent = '+0'; pv._cv = 0;
      } else {
        pv.textContent = '—'; pv._cv = 0;
      }
      pv.style.color = hasData ? 'var(--gold)' : 'var(--muted)';
      G('pts-label').textContent = hasData ? 'collected this run' : 'start a run to see stats';

      var mc = G('mini-core');
      var cp = data.claimedPoints;
      mc.textContent = cp > 0 ? '+' + cp.toLocaleString() : (running ? '...' : '—');
      mc.style.color = cp > 0 ? 'var(--cyan)' : 'var(--muted)';
      G('mini-coupons').textContent = m.coupons || (running ? '...' : '—');

      // When the bot is running in headless (hidden-window) mode, the browser is
      // off-screen — so swap the disabled Run button for a "Show browser" button
      // that reveals it on demand. Reverts to Run as soon as the bot stops.
      var hl = G('tog-headless');
      var headlessRun = running && hl && hl.checked;
      var sbBtn = G('btn-show-browser');
      // Lock the headless toggle while a run is active: the browser's hidden-window
      // mode is frozen at launch, so flipping headless mid-run would desync the
      // "Show browser" button from the actually-running browser.
      if (hl) {
        hl.disabled = running;
        var hlTog = hl.closest('.toggle');
        if (hlTog) { hlTog.style.opacity = running ? '.45' : ''; hlTog.style.cursor = running ? 'not-allowed' : ''; }
      }
      var allDisabled = data.accounts && data.accounts.length > 0 && data.accounts.every(function(a){ return a.enabled === false; });
      G('btn-run').style.display = headlessRun ? 'none' : '';
      G('btn-run').disabled = running || allDisabled;
      if (sbBtn) sbBtn.style.display = headlessRun ? '' : 'none';
      G('btn-stop').disabled = !running;
      if (data.accountPointsMap) _accPtsMap = data.accountPointsMap;
      G('acc-list').innerHTML = renderAccounts(data.accounts, data.activeAccount, !boot.accountsReady, data.accountPointsMap);

      if (data.consoleLogs) {
        var newLogs = _consoleClearedAt
          ? data.consoleLogs.filter(function(l) { return new Date(l.at).getTime() > _consoleClearedAt; })
          : data.consoleLogs;
        var oldLogs = _consoleLogs;
        var n = newLogs.length, o = oldLogs.length;
        // Detect a head-trim (server dropped the oldest lines past the cap) — that
        // shifts every row, so a full re-render is required, not an append.
        var trimmed = n && o && newLogs[0].at !== oldLogs[0].at && newLogs[0].message !== oldLogs[0].message;
        // Re-render when the count changed or the last line's text changed (covers
        // the in-place spinner collapse, where the count stays the same).
        var changed = n !== o || trimmed ||
          (n && o && (newLogs[n-1].message !== oldLogs[o-1].message || !!newLogs[n-1].spinner !== !!oldLogs[o-1].spinner));
        _consoleLogs = newLogs;
        if (changed) updateConsoleBox(!trimmed);
      }

      var fdot = G('fdot');
      fdot.style.background = running ? 'var(--blue)' : s==='Complete' ? 'var(--green)' : s==='Attention' ? 'var(--gold)' : 'var(--muted)';
      G('ftxt').textContent = running ? 'Bot running' : 'Bot ' + s.toLowerCase();
      G('facc').textContent = data.activeAccount ? 'Account: ' + data.activeAccount : '';

      if (data.licensePrompt) {
        var promptVisible = Boolean(data.licensePrompt.visible);
        if (promptVisible && !_licensePromptVisible) licOpenOverlay('key');
        if (promptVisible && data.licensePrompt.status === 'invalid') {
          _licSetView('key');
          _licSetError(data.licensePrompt.message || 'The license could not be validated.');
        }
        _licensePromptVisible = promptVisible;
      }
      if (view === 'accounts' && _accountsLoaded) {
        updateAccEditorRunningState(data.activeAccount);
      }
    }

    // ── Start/Stop ────────────────────────────
    async function startRun() {
      await fetch('/api/start', {method:'POST'});
      refresh();
    }

    async function startPendingRun() {
      if (!_runAfterLicenseFlow) return;
      _runAfterLicenseFlow = false;
      await startRun();
    }

    // ── Accounts editor ───────────────────────
    var _raw = [];
    var _accountsLoading = false;
    var _accountsLoaded = false;
    var _accPtsMap = {};
    function maskEmailClient(email) {
      var parts = String(email || '').split('@');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return email;
      return parts[0].slice(0,2) + '***@' + parts[1];
    }
    var _accGroupsCollapsed = JSON.parse(localStorage.getItem('acc_groups_collapsed') || '{"proxy":false,"direct":false}');
    var _proxyTestResults = {};
    var _testingProxies = false;
    var _testingIndex = -1;

    function emailMatchesMask(raw, masked) {
      if (!raw || !masked) return false;
      var rParts = raw.split('@');
      var mParts = masked.split('@');
      if (rParts.length !== 2 || mParts.length !== 2) return false;
      if (rParts[1] !== mParts[1]) return false;
      var rName = rParts[0];
      var mName = mParts[0];
      if (rName.length <= 2) return rName === mName;
      if (rName.slice(0, 2) !== mName.slice(0, 2)) return false;
      var expectedMasked = rName.slice(0, 2) + '*'.repeat(Math.min(5, rName.length - 2));
      return expectedMasked === mName;
    }

    function toggleAccGroup(group) {
      _accGroupsCollapsed[group] = !_accGroupsCollapsed[group];
      localStorage.setItem('acc_groups_collapsed', JSON.stringify(_accGroupsCollapsed));
      renderAccEditor();
    }

    async function runProxyTest(index) {
      var isCore = typeof _coreData !== 'undefined' && _coreData && _coreData.tier === 'premium';
      if (!isCore) {
        licOpenOverlay('welcome');
        showToast('Proxy testing is a Core Premium feature.', true);
        return;
      }
      
      _testingProxies = true;
      _testingIndex = typeof index === 'number' ? index : -1;
      renderAccEditor();
      
      try {
        var response = await fetch('/api/test-proxies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index: _testingIndex })
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to test proxies');
        
        Object.assign(_proxyTestResults, data.results || {});
        showToast('Proxy check complete.');
      } catch(e) {
        showToast(e.message, true);
      } finally {
        _testingProxies = false;
        _testingIndex = -1;
        renderAccEditor();
      }
    }

    function updateAccEditorRunningState(activeEmail) {
      var list = G('acc-editor-list');
      if (!list) return;
      var rows = list.querySelectorAll('.acc-editor-row');
      rows.forEach(function(row) {
        var email = row.getAttribute('data-email');
        var isRunning = activeEmail && emailMatchesMask(email, activeEmail);
        var statusEl = row.querySelector('.acc-st');
        if (statusEl) {
          var isEnabled = !row.classList.contains('is-disabled');
          var currentText = statusEl.textContent;
          var expectedText = isRunning ? 'Running' : (isEnabled ? 'Enabled' : 'Disabled');
          if (currentText !== expectedText) {
            statusEl.textContent = expectedText;
            statusEl.className = isRunning ? 'acc-st running' : 'acc-st';
            row.classList.toggle('is-active', isRunning);
          }
        }
      });
    }

    async function loadAccEditor() {
      if (_accountsLoading) return;
      if (_accountsLoaded) { renderAccEditor(); return; }
      _accountsLoading = true;
      G('acc-editor-list').innerHTML = '<div class="loading-block"><span class="inline-spinner"></span><span>Decrypting accounts…</span></div>';
      try {
        var response = await fetch('/api/accounts-raw');
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load accounts');
        _raw = data;
        _accountsLoaded = true;
        renderAccEditor();
      } catch(e) {
        G('acc-editor-list').innerHTML = '<div class="acc-empty"><p>' + esc(e.message) + '</p></div>';
      } finally {
        _accountsLoading = false;
      }
    }

    function renderAccEditor() {
      var list = G('acc-editor-list');
      if (!_raw.length) {
        list.innerHTML = '<div class="acc-empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg><p>No accounts yet. Click &quot;+ Add account&quot; to get started.</p></div>';
        if (G('acc-stat-total')) G('acc-stat-total').textContent = '0';
        if (G('acc-stat-enabled')) G('acc-stat-enabled').textContent = '0';
        if (G('acc-stat-disabled')) G('acc-stat-disabled').textContent = '0';
        return;
      }

      // Update stat counters
      var totalCount = _raw.length;
      var enabledCount = _raw.filter(function(a) { return a.enabled !== false; }).length;
      var disabledCount = totalCount - enabledCount;
      if (G('acc-stat-total')) G('acc-stat-total').textContent = totalCount;
      if (G('acc-stat-enabled')) G('acc-stat-enabled').textContent = enabledCount;
      if (G('acc-stat-disabled')) G('acc-stat-disabled').textContent = disabledCount;
      if (G('acc-page-sub')) G('acc-page-sub').textContent = totalCount + ' account' + (totalCount !== 1 ? 's' : '') + ' configured';

      var safetyBox = G('acc-safety-advice');
      if (safetyBox) {
        if (totalCount > 4) {
           safetyBox.style.display = 'block';
           safetyBox.style.borderLeft = '3px solid #ff453a';
           safetyBox.style.background = 'rgba(255, 69, 58, 0.1)';
           safetyBox.innerHTML = '<b style="color: #ff453a;">High Risk (2026):</b> You have ' + totalCount + ' accounts. The Microsoft household limit is 6. Running this many accounts significantly increases ban risk. Use high-quality mobile proxies (like Decodo) and high delays. Also remember: <b>1 Account = 1 Unique Phone Number</b>.';
        } else if (totalCount > 1) {
           safetyBox.style.display = 'block';
           safetyBox.style.borderLeft = '3px solid #0a84ff';
           safetyBox.style.background = 'rgba(10, 132, 255, 0.1)';
           safetyBox.innerHTML = '<b style="color: #0a84ff;">Tips for Multiple Accounts:</b> The new anti-bot system is strict. Avoid generic searches (to qualify for the <b>Bing Star Bonus</b>), space out your runs, and always use <b>1 Unique Phone Number per Account</b>.';
        } else {
           safetyBox.style.display = 'none';
        }
      }

      var proxyAccs = [];
      var directAccs = [];
      _raw.forEach(function(a, i) {
        var accWithIdx = { account: a, index: i };
        if (a.proxy && a.proxy.url) {
          proxyAccs.push(accWithIdx);
        } else {
          directAccs.push(accWithIdx);
        }
      });

      var activeEmail = window._lastStateData && window._lastStateData.isRunning ? window._lastStateData.activeAccount : null;
      var html = '';

      function renderGroupRows(groupAccs) {
        return groupAccs.map(function(item) {
          var a = item.account;
          var i = item.index;
          var ini = String(a.email||'?').split('@')[0].slice(0,2).toUpperCase();
          var ena = a.enabled !== false;
          var isRunning = activeEmail && emailMatchesMask(a.email, activeEmail);
          
          var statusText = isRunning ? 'Running' : (ena ? 'Enabled' : 'Disabled');
          var statusClass = isRunning ? 'acc-st running' : 'acc-st';
          var rowClass = 'acc-editor-row' + (isRunning ? ' is-active' : '') + (!ena ? ' is-disabled' : '');
          
          var proxyInfo = '';
          if (a.proxy && a.proxy.url) {
            var hostText = a.proxy.url;
            if (a.proxy.port) hostText += ':' + a.proxy.port;
            
            var isThisTesting = _testingProxies && (_testingIndex === -1 || _testingIndex === i);
            var testResult = _proxyTestResults[a.email];
            
            var badgeClass = 'acc-proxy-badge';
            var resultText = '';
            var statusIcon = '<svg style="width:11px;height:11px;margin-right:4px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="23"></line><line x1="1" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="23" y2="12"></line></svg>';
            
            if (isThisTesting) {
              badgeClass += ' testing';
              resultText = ' (testing...)';
              statusIcon = '<svg class="inline-spinner" style="width:11px;height:11px;margin-right:4px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
            } else if (testResult) {
              if (testResult.ok) {
                badgeClass += ' success';
                resultText = ' (' + testResult.latencyMs + 'ms)';
                statusIcon = '<svg style="width:11px;height:11px;margin-right:4px;flex-shrink:0;color:#10b981" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
              } else {
                badgeClass += ' error';
                resultText = ' (failed)';
                statusIcon = '<svg style="width:11px;height:11px;margin-right:4px;flex-shrink:0;color:#ff4b6e" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
              }
            }
            
            var tooltip = 'Proxy: ' + hostText;
            if (testResult && !testResult.ok) tooltip += '\\nError: ' + testResult.error;
            
            proxyInfo = '<div class="' + badgeClass + '" title="' + esc(tooltip) + '" onclick="runProxyTest(' + i + '); event.stopPropagation();">' +
              statusIcon +
              esc(hostText.length > 28 ? hostText.slice(0, 26) + '...' : hostText) +
              resultText +
            '</div>';
          }

          var metaInfo = '';
          if (a.strictProxy === 'require') {
            metaInfo += '<span title="Strict proxy: always required for this account" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(248,113,113,.15);color:#f87171">STRICT</span>';
          } else if (a.strictProxy === 'exempt') {
            metaInfo += '<span title="Strict proxy: exempt for this account" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.07);color:#9aa3b2">EXEMPT</span>';
          }
          if (a.dashboardMode && a.dashboardMode !== 'auto') {
            metaInfo += '<span title="Dashboard override (forced)" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(96,165,250,.15);color:#93c5fd">' + (a.dashboardMode === 'legacy' ? 'ASP' : 'NEW') + '</span>';
          } else if (a.lastDetectedVariant) {
            // 'auto' account: show what the bot detected at the last run, muted to
            // visually distinguish it from a forced override (blue) above.
            metaInfo += '<span title="Auto-detected (last run)" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.07);color:#9aa3b2">' + (a.lastDetectedVariant === 'legacy' ? 'ASP' : 'NEW') + '</span>';
          }
          if (a.geoLocale && String(a.geoLocale).toLowerCase() !== 'auto') {
            metaInfo += '<span title="Geo locale" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.07);color:#9aa3b2">' + esc(String(a.geoLocale).toUpperCase()) + '</span>';
          }
          var accPts = _accPtsMap[maskEmailClient(a.email || '')] || 0;
          var ptsBadge = accPts > 0 ? '<span class="acc-pts-badge"><svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>+' + accPts.toLocaleString() + '</span>' : '';

          return '<div class="' + rowClass + '" data-email="' + esc(a.email||'') + '">' +
            '<div class="acc-avatar' + (isRunning ? ' running' : '') + '"><img src="/avatars/' + encodeURIComponent(a.email||'') + '" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;display:block"></div>' +
            '<div class="acc-info" style="flex:1;min-width:0">' +
              '<div class="acc-email">' + esc(a.email||'(no email)') + '</div>' +
              '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
                '<div class="' + statusClass + '">' + esc(statusText) + '</div>' +
                proxyInfo +
                metaInfo +
                ptsBadge +
              '</div>' +
            '</div>' +
            '<div class="acc-actions-cell">' +
              '<button class="btn-icon' + (ena ? ' btn-icon-on' : '') + '" title="' + (ena ? 'Disable account' : 'Enable account') + '" onclick="toggleAcc(' + i + ')">' +
                '<svg viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>' +
              '</button>' +
              '<button class="btn-icon" title="Edit" onclick="openAccEdit(' + i + ')">' +
                '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
              '</button>' +
              '<button class="btn-icon danger" title="Delete" onclick="deleteAcc(' + i + ')">' +
                '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
              '</button>' +
            '</div></div>';
        }).join('');
      }

      var hasProxies = proxyAccs.length > 0;
      var btnTest = G('btn-test-proxies');
      if (btnTest) {
        btnTest.style.display = hasProxies ? '' : 'none';
        btnTest.disabled = _testingProxies;
        if (_testingProxies) {
          btnTest.innerHTML = '<span class="inline-spinner"></span> Testing...';
        } else {
          btnTest.innerHTML = '<svg style="width:12px;height:12px;vertical-align:middle;margin-right:4px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="23"></line><line x1="1" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="23" y2="12"></line></svg>Test Proxies';
        }
      }

      if (proxyAccs.length > 0) {
        var isCollapsed = !!_accGroupsCollapsed.proxy;
        html += '<div class="acc-group-header" onclick="toggleAccGroup(\\\'proxy\\\')">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="acc-group-arrow' + (isCollapsed ? ' collapsed' : '') + '">▼</span>' +
            '<span class="acc-group-title">Proxy Connections</span>' +
            '<span class="acc-group-badge">' + proxyAccs.length + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="acc-group-content' + (isCollapsed ? ' collapsed' : '') + '">' +
          renderGroupRows(proxyAccs) +
        '</div>';
      }

      if (directAccs.length > 0 || proxyAccs.length === 0) {
        var isCollapsed = !!_accGroupsCollapsed.direct;
        html += '<div class="acc-group-header" onclick="toggleAccGroup(\\\'direct\\\')">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="acc-group-arrow' + (isCollapsed ? ' collapsed' : '') + '">▼</span>' +
            '<span class="acc-group-title">Direct Connections</span>' +
            '<span class="acc-group-badge">' + directAccs.length + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="acc-group-content' + (isCollapsed ? ' collapsed' : '') + '">' +
          renderGroupRows(directAccs) +
        '</div>';
      }

      list.innerHTML = html;
    }

    async function saveRaw() {
      try {
        var response = await fetch('/api/accounts-save', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(_raw)});
        if (!response.ok) {
          var result = await response.json().catch(function(){return {};});
          throw new Error(result.error || 'Could not save accounts');
        }
        _accountsLoaded = true;
        return true;
      } catch(e) {
        showToast(e.message, true);
        return false;
      }
    }

    async function refreshAccountStorage() {
      var result = await fetch('/api/account-storage').then(function(r){return r.json();});
      var status = G('account-storage-status');
      _storageConfirmation = result.disableConfirmation || '';
      status.textContent = result.encrypted
        ? 'Protected by ' + result.provider
        : 'Plaintext JSON' + (result.warning ? ' — ' + result.warning : '.');
      status.classList.toggle('ok', !!result.encrypted);
      status.classList.toggle('warn', !result.encrypted);
      G('storage-toggle').textContent = result.encrypted ? 'Disable encryption' : 'Enable encryption';
      G('storage-rotate').disabled = !result.encrypted;
      G('storage-toggle').dataset.encrypted = result.encrypted ? '1' : '0';
    }

    async function storageAction(action, payload) {
      var response = await fetch('/api/account-storage', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(Object.assign({action:action}, payload || {}))
      });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Storage operation failed');
      await refreshAccountStorage();
      return result;
    }

    G('storage-toggle').addEventListener('click', async function() {
      var button = this;
      try {
        var encrypted = button.dataset.encrypted === '1';
        var payload = {};
        if (encrypted) {
          var typed = prompt(
            'This will write all account credentials to plaintext JSON.\\n\\nTo confirm as the current local user, type: ' +
              _storageConfirmation
          );
          if (typed === null) return;
          payload.confirmation = typed;
        }
        setButtonBusy(button, true, encrypted ? 'Disabling' : 'Enabling');
        await storageAction(encrypted ? 'disable' : 'enable', payload);
        showToast(encrypted ? 'Account encryption disabled.' : 'Account encryption enabled.');
      } catch(e) { showToast(e.message, true); }
      finally {
        setButtonBusy(button, false);
        refreshAccountStorage().catch(function(){});
      }
    });
    G('storage-rotate').addEventListener('click', async function() {
      if (!confirm('Rotate the local encryption key now?')) return;
      var button = this;
      try {
        setButtonBusy(button, true, 'Rotating');
        await storageAction('rotate');
        showToast('Local encryption key rotated.');
      } catch(e) { showToast(e.message, true); }
      finally { setButtonBusy(button, false); }
    });
    G('storage-export').addEventListener('click', async function() {
      var password = prompt('Backup password (minimum 12 characters):'); if (!password) return;
      var destination = prompt('Backup destination path (leave empty for your home folder):', '');
      var button = this;
      try {
        setButtonBusy(button, true, 'Exporting');
        var result = await storageAction('export', {password:password, destination:destination||''});
        showToast('Encrypted backup created at ' + result.path);
      } catch(e) { showToast(e.message, true); }
      finally { setButtonBusy(button, false); }
    });
    G('storage-import').addEventListener('click', async function() {
      var source = prompt('Path to the encrypted backup:'); if (!source) return;
      var password = prompt('Backup password:'); if (!password) return;
      var button = this;
      try {
        setButtonBusy(button, true, 'Importing');
        var result = await storageAction('import', {password:password, source:source});
        await loadAccEditor();
        showToast(result.count + ' account(s) imported.');
      } catch(e) { showToast(e.message, true); }
      finally { setButtonBusy(button, false); }
    });
    function toggleAcc(i) { _raw[i].enabled = !(_raw[i].enabled !== false); saveRaw(); renderAccEditor(); }
    function deleteAcc(i) {
      if (!confirm('Delete ' + (_raw[i].email || 'this account') + '?')) return;
      _raw.splice(i, 1); saveRaw(); renderAccEditor();
    }
    function _accFill(a) {
      a = a || {};
      var p = a.proxy || {}, fp = a.saveFingerprint || {};
      G('acc-email').value = a.email || '';
      G('acc-password').value = a.password || '';
      G('acc-totp').value = a.totpSecret || '';
      G('acc-recovery').value = a.recoveryEmail || '';
      G('acc-geo').value = a.geoLocale || 'auto';
      G('acc-lang').value = a.langCode || 'en';
      G('acc-proxy-url').value = p.url || '';
      G('acc-proxy-port').value = p.port || 0;
      G('acc-proxy-user').value = p.username || '';
      G('acc-proxy-pass').value = p.password || '';
      G('acc-proxy-axios').checked = !!p.proxyAxios;
      G('acc-strict-proxy').value = a.strictProxy || 'auto';
      var sResult = G('test-single-proxy-result');
      if (sResult) { sResult.textContent = ''; sResult.style.color = ''; }
      G('acc-fp-desktop').checked = !!fp.desktop;
      G('acc-fp-mobile').checked = !!fp.mobile;
      G('acc-dashboard-mode').value = a.dashboardMode || 'auto';
      var av = G('acc-modal-avatar');
      if (av) {
        if (a.email) {
          av.innerHTML = '<img src="/avatars/' + encodeURIComponent(a.email) + '" style="width:100%;height:100%;object-fit:cover;display:block">';
        } else {
          av.textContent = '+';
        }
      }
      var adv = document.querySelector('.acc-adv');
      if (adv) adv.open = false;
      G('acc-modal-msg').textContent = '';
    }
    function openAccAdd() {
      accEditIdx = -1;
      G('acc-modal-title').textContent = 'Add account';
      _accFill({});
      setView('accedit'); G('acc-email').focus();
    }
    function openAccEdit(i) {
      accEditIdx = i;
      G('acc-modal-title').textContent = 'Edit account';
      _accFill(_raw[i]);
      setView('accedit'); G('acc-email').focus();
    }
    async function saveAccModal() {
      var email = G('acc-email').value.trim();
      if (!email) { G('acc-modal-msg').textContent = 'Email is required.'; return; }
      var totpSecret = G('acc-totp').value
        .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
        .replace(/=+$/, '')
        .toUpperCase();
      var acc = {
        email: email,
        password: G('acc-password').value,
        recoveryEmail: G('acc-recovery').value.trim(),
        geoLocale: G('acc-geo').value.trim() || 'auto',
        langCode: G('acc-lang').value.trim() || 'en',
        proxy: {
          proxyAxios: G('acc-proxy-axios').checked,
          url: G('acc-proxy-url').value.trim(),
          port: Number(G('acc-proxy-port').value) || 0,
          username: G('acc-proxy-user').value.trim(),
          password: G('acc-proxy-pass').value
        },
        saveFingerprint: {
          desktop: G('acc-fp-desktop').checked,
          mobile: G('acc-fp-mobile').checked
        }
      };
      if (totpSecret) acc.totpSecret = totpSecret;
      // Per-account dashboard override (auto = omit, let the bot detect at login).
      var dm = G('acc-dashboard-mode').value;
      if (dm && dm !== 'auto') acc.dashboardMode = dm;
      // Per-account strict-proxy override (auto = omit, follow the global setting).
      var sp = G('acc-strict-proxy').value;
      if (sp && sp !== 'auto') acc.strictProxy = sp;

      var btn = G('acc-modal-save');
      var prevItem = accEditIdx === -1 ? null : _raw[accEditIdx];
      if (accEditIdx === -1) {
        acc.enabled = true;
        _raw.push(acc);
      } else {
        acc.enabled = _raw[accEditIdx].enabled !== false;
        _raw[accEditIdx] = acc;
      }

      setButtonBusy(btn, true, 'Saving…');
      G('acc-modal-msg').textContent = '';
      var ok = await saveRaw();
      setButtonBusy(btn, false);

      if (ok === false) {
        // Roll back the optimistic change so a retry does not duplicate or lose data.
        if (accEditIdx === -1) _raw.pop(); else _raw[accEditIdx] = prevItem;
        G('acc-modal-msg').textContent = 'Could not save — check your connection and try again.';
        return;
      }

      setView('accounts');
    }

    // ── Settings ──────────────────────────────
    async function loadSettings() {
      var s; try { s = await fetch('/api/settings').then(function(r){return r.json();}); } catch(e) { return; }
      var w = s.workers || {};
      ['doDailySet','doSpecialPromotions','doMorePromotions','doDesktopSearch','doMobileSearch',
       'doAppPromotions'].forEach(function(id) {
        var el = G('tog-' + id); if (el) el.checked = w[id] !== false;
      });
      // Notifications (free)
      var wh = s.webhook || {};
      var elWd = G('tog-wh-discord'); if (elWd) elWd.checked = !!(wh.discord && wh.discord.enabled);
      var elWn = G('tog-wh-ntfy'); if (elWn) elWn.checked = !!(wh.ntfy && wh.ntfy.enabled);
      var sp = G('tog-strictProxy'); if (sp && s.proxy) sp.checked = !!s.proxy.strictMode;
      var h = G('tog-headless'); if (h) h.checked = s.headless === true;
      var rz = G('tog-runOnZero'); if (rz) rz.checked = s.runOnZeroPoints === true;
      var dl = G('tog-debugLogs'); if (dl) dl.checked = s.debugLogs === true;
      var sb = G('tog-searchOnBing'); if (sb) sb.checked = s.searchOnBingLocalQueries !== false;
      var cl = G('set-clusters'); if (cl) cl.value = s.core && s.core.clusters != null ? s.core.clusters : 1;
      var analyticsEnabled = s.analytics != null ? s.analytics.enabled !== false : true;
      var togAn = G('tog-analytics'); if (togAn) togAn.checked = analyticsEnabled;
      var anWarn = G('analytics-warning'); if (anWarn) anWarn.style.display = analyticsEnabled ? 'none' : 'block';
      var notifTog = G('tog-updateNotifier'); if (notifTog) notifTog.checked = s.updateNotifier == null || s.updateNotifier.enabled !== false;
      // Local network access (LAN) — toggle + bookmarkable address for other devices
      var lan = G('tog-lanAccess'); if (lan) lan.checked = s.deskLanAccess === true;
      var lanRow = G('lan-url-row'); if (lanRow) lanRow.style.display = s.deskLanAccess ? '' : 'none';
      // Search tuning (advanced)
      var ss = s.searchSettings || {};
      if (G('tog-parallelSearching')) G('tog-parallelSearching').checked = ss.parallelSearching === true;
      if (G('tog-scrollRandomResults')) G('tog-scrollRandomResults').checked = ss.scrollRandomResults !== false;
      if (G('tog-clickRandomResults')) G('tog-clickRandomResults').checked = ss.clickRandomResults !== false;
      if (G('set-visitTime')) G('set-visitTime').value = ss.searchResultVisitTime != null ? ss.searchResultVisitTime : '';
      if (G('set-globalTimeout')) G('set-globalTimeout').value = s.globalTimeout != null ? s.globalTimeout : '';
      var sd = ss.searchDelay || {}, rdl = ss.readDelay || {};
      if (G('set-searchDelayMin')) G('set-searchDelayMin').value = sd.min != null ? sd.min : '';
      if (G('set-searchDelayMax')) G('set-searchDelayMax').value = sd.max != null ? sd.max : '';
      if (G('set-readDelayMin')) G('set-readDelayMin').value = rdl.min != null ? rdl.min : '';
      if (G('set-readDelayMax')) G('set-readDelayMax').value = rdl.max != null ? rdl.max : '';
      var sc = s.scheduler || {};
      _schedCache = Object.assign({}, sc, { nextRunAt: s.schedulerNextRunAt }); updateNextRun();
      var schTog = G('tog-scheduler');
      if (schTog) { schTog.checked = !!sc.enabled; _updateSchFields(!!sc.enabled); }
      if (G('sch-startTime')) G('sch-startTime').value = sc.startTime || '08:00';
      if (G('sch-timezone')) { G('sch-timezone').value = sc.timezone || 'Europe/Paris'; }
      var rd = sc.randomDelay || {};
      if (G('sch-delayMin')) G('sch-delayMin').value = rd.min || '0min';
      if (G('sch-delayMax')) G('sch-delayMax').value = rd.max || '30min';
      var rus = G('tog-runOnStartup'); if (rus) rus.checked = sc.runOnStartup !== false;
      // Core Premium — real, config-gated Core features
      var core = s.core || {};
      var hasCore = !!(s.hasCoreLicense);
      var badge = G('core-license-badge');
      var note = G('core-section-note');
      if (badge) badge.textContent = hasCore ? 'Active' : 'No license';
      if (badge) badge.style.background = hasCore ? 'rgba(47,210,125,.15)' : '';
      if (badge) badge.style.color = hasCore ? 'var(--green)' : '';
      if (note) note.style.display = hasCore ? 'none' : '';
      var navBadge = G('sett-nav-core-badge');
      if (navBadge) {
        navBadge.textContent = hasCore ? 'Active' : '';
        navBadge.className = 'sett-nav-badge ' + (hasCore ? 'sett-nav-badge-green' : 'sett-nav-badge-gold');
      }
      CORE_KEYS.forEach(function(k) {
        var el = G('tog-core-' + k);
        if (!el) return;
        var v = core[k];
        el.disabled = !hasCore;
        // Without a Core license the toggle is locked; show it OFF instead of the
        // stored "default on" so it doesn't look already-enabled. Stored value
        // (core.<k>) is left untouched — only the visual checkbox state changes.
        el.checked = hasCore && (v !== false);
        var row = el.closest('.toggle-wrap') || el.closest('.cfg-wrap');
        if (row) {
          var t = !hasCore ? 'Requires an active Core license' : '';
          if (CORE_NEXT_ONLY[k]) {
            t = (t ? t + ' — ' : '') + 'Only runs on the new (Next.js) dashboard — skipped on classic (ASP) accounts.';
          }
          row.title = t;
        }
      });
      // Remote access (Core) + headless service — sourced from /api/settings (s)
      var remoteTog = G('tog-remote-access');
      if (remoteTog) { remoteTog.checked = s.deskRemoteAccess === true; remoteTog.disabled = !hasCore; }
      if (G('remote-access-method')) G('remote-access-method').textContent = !hasCore
        ? 'Activate Core to enable remote access.'
        : (s.deskRemoteAccess ? 'On — controllable from Nexus while the Desk runs.' : 'Off');
      var hlTog = G('tog-desk-headless'); if (hlTog) hlTog.checked = s.deskHeadless === true;
      // Desk autostart (from the startup manager)
      fetch('/api/startup').then(function(r){return r.json();}).then(function(st){
        var desk = G('tog-startup-desk');
        if (desk) desk.checked = !!(st.desk && st.desk.installed);
        if (G('startup-desk-method')) G('startup-desk-method').textContent =
          st.desk && st.desk.method ? 'Uses ' + st.desk.method.replace(/-/g, ' ') : '';
      }).catch(function(){});
    }
    function _updateSchFields(on) {
      var f = G('scheduler-fields'); if (f) f.classList.toggle('hidden', !on);
    }
    async function saveSetting(dotPath, value) {
      var patch = {}, parts = dotPath.split('.'), cur = patch;
      for (var i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
      cur[parts[parts.length-1]] = value;
      try { await fetch('/api/settings', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)}); }
      catch(e) {}
    }

    // ── Hints ─────────────────────────────────
    var _hintsKey = 'msrb-hints-v1';
    var _hintsData = {};
    try { _hintsData = JSON.parse(localStorage.getItem(_hintsKey) || '{}'); } catch(e) {}
    function _hintSeen(id) { return !!_hintsData[id]; }
    function _markHint(id) {
      _hintsData[id] = 1;
      try { localStorage.setItem(_hintsKey, JSON.stringify(_hintsData)); } catch(e) {}
    }
    function showHint(id, delay) {
      if (_hintSeen(id)) return;
      setTimeout(function() {
        if (_hintSeen(id)) return;
        var el = G('hint-' + id);
        if (!el) return;
        el.classList.add('show');
        el._hintTimer = setTimeout(function() { dismissHint(id); }, 8000);
      }, delay || 500);
    }
    function dismissHint(id) {
      var el = G('hint-' + id);
      if (el) { clearTimeout(el._hintTimer); el.classList.remove('show'); }
      _markHint(id);
    }
    // ── Settings panels ───────────────────────
    var _settTab = 'run';
    function _settGo(panel) {
      _settTab = panel;
      document.querySelectorAll('.sett-nav-item').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-panel') === panel);
      });
      document.querySelectorAll('.sett-panel').forEach(function(p) {
        p.classList.toggle('active', p.id === 'sett-' + panel);
      });
      showHint('sett-' + panel, 300);
    }
    document.querySelectorAll('.sett-nav-item').forEach(function(b) {
      b.addEventListener('click', function() { _settGo(b.getAttribute('data-panel')); });
    });
    // Notification sub-page nav buttons
    document.querySelectorAll('.notif-nav-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = btn.getAttribute('data-notif');
        if (key) setView('notif-' + key);
      });
    });
    // Notification sub-page back buttons
    if (G('notif-discord-back')) G('notif-discord-back').addEventListener('click', function() {
      setView('settings'); _settGo('notifications');
    });
    if (G('notif-ntfy-back')) G('notif-ntfy-back').addEventListener('click', function() {
      setView('settings'); _settGo('notifications');
    });
    // Settings: Open installation folder
    if (G('btn-open-folder')) G('btn-open-folder').addEventListener('click', function() {
      fetch('/api/open-folder', {method:'POST'}).catch(function(){});
    });
    // Settings: Reset config to defaults
    if (G('btn-reset-config')) G('btn-reset-config').addEventListener('click', function() {
      var area = G('reset-confirm-area');
      if (area) area.style.display = area.style.display === 'none' ? '' : 'none';
    });
    if (G('reset-confirm-no')) G('reset-confirm-no').addEventListener('click', function() {
      var area = G('reset-confirm-area'); if (area) area.style.display = 'none';
    });
    if (G('reset-confirm-yes')) G('reset-confirm-yes').addEventListener('click', function() {
      var btn = G('reset-confirm-yes');
      if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
      fetch('/api/reset-config', {method:'POST'}).then(function(r) {
        if (!r.ok) throw new Error('Server error ' + r.status);
        return r.json();
      }).then(function() {
        showToast('Config reset to defaults. Reloading…');
        setTimeout(function() { location.reload(); }, 1200);
      }).catch(function(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Yes, reset config'; }
        showToast('Reset failed: ' + (e.message || 'unknown error'), true);
      });
    });
    // ── Listeners ─────────────────────────────
    G('btn-run').addEventListener('click', async function() {
      var s = await fetch('/api/state').then(function(r){return r.json();}).catch(function(){return {};});
      if (s.hasLicenseCache || s.corePluginEnabled === false) {
        startRun();
        return;
      }
      _runAfterLicenseFlow = true;
      licOpenOverlay('welcome');
    });
    G('btn-stop').addEventListener('click', function() { fetch('/api/stop',{method:'POST'}).then(refresh); });
    (function() {
      var sb = G('btn-show-browser');
      if (sb) sb.addEventListener('click', function() { fetch('/api/show-browser', { method: 'POST' }); });
    })();
    G('btn-add-acc').addEventListener('click', openAccAdd);
    G('acc-editor-list').addEventListener('dblclick', function(e) {
      var row = e.target.closest('[data-email]');
      if (!row) return;
      var email = row.getAttribute('data-email');
      var idx = _raw.findIndex(function(a) { return (a.email || '') === email; });
      if (idx !== -1) { toggleAcc(idx); dismissHint('acc-dbl'); }
    });
    G('btn-test-proxies').addEventListener('click', function() { runProxyTest(); });
    G('btn-test-single-proxy').addEventListener('click', function() {
      var url = G('acc-proxy-url').value.trim();
      var port = Number(G('acc-proxy-port').value) || 0;
      var username = G('acc-proxy-user').value.trim();
      var password = G('acc-proxy-pass').value;
      var btn = G('btn-test-single-proxy');
      var res = G('test-single-proxy-result');
      
      if (!url) {
        if (res) { res.textContent = 'Enter a proxy URL'; res.style.color = 'var(--rose)'; }
        return;
      }
      
      if (btn) btn.disabled = true;
      if (res) { res.textContent = 'Testing…'; res.style.color = 'var(--muted)'; }
      
      fetch('/api/test-single-proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url, port: port, username: username, password: password })
      }).then(function(r) {
        if (r.status === 403) {
          throw new Error('Core Premium required');
        }
        if (!r.ok) {
          throw new Error('Test failed');
        }
        return r.json();
      }).then(function(data) {
        if (res) {
          if (data.ok) {
            res.textContent = 'Success (' + data.latencyMs + 'ms)';
            res.style.color = '#2fd27d';
          } else {
            res.textContent = data.error || 'Connection failed';
            res.style.color = 'var(--rose)';
          }
        }
      }).catch(function(err) {
        if (res) {
          res.textContent = err.message || 'Error occurred';
          res.style.color = 'var(--rose)';
        }
      }).finally(function() {
        if (btn) btn.disabled = false;
      });
    });

    // Settings: Clear sessions / clear data
    var _maintenanceAction = '';
    if (G('btn-clear-sessions')) G('btn-clear-sessions').addEventListener('click', function() {
      var area = G('maintenance-confirm-area');
      var txt = G('maintenance-confirm-text');
      if (area && txt) {
        _maintenanceAction = 'clear-sessions';
        txt.innerHTML = 'This will delete all saved browser sessions. You will need to log in to all accounts again on the next run. This cannot be undone.';
        area.style.display = '';
      }
    });
    if (G('btn-clear-data')) G('btn-clear-data').addEventListener('click', function() {
      var area = G('maintenance-confirm-area');
      var txt = G('maintenance-confirm-text');
      if (area && txt) {
        _maintenanceAction = 'clear-data';
        txt.innerHTML = 'This will delete the local <strong>data</strong> folder. This resets your avatars, first-launch screen, update checks, and build caches. Your accounts and config are <strong>not</strong> affected. This cannot be undone.';
        area.style.display = '';
      }
    });
    if (G('maintenance-confirm-no')) G('maintenance-confirm-no').addEventListener('click', function() {
      var area = G('maintenance-confirm-area'); if (area) area.style.display = 'none';
      _maintenanceAction = '';
    });
    if (G('maintenance-confirm-yes')) G('maintenance-confirm-yes').addEventListener('click', function() {
      var btn = G('maintenance-confirm-yes');
      if (!btn || !_maintenanceAction) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      fetch('/api/' + _maintenanceAction, { method: 'POST' }).then(function(r) {
        if (!r.ok) throw new Error('Server error ' + r.status);
        return r.json();
      }).then(function() {
        var actionText = _maintenanceAction === 'clear-sessions' ? 'Sessions' : 'Data folder';
        showToast(actionText + ' deleted successfully. Reloading…');
        setTimeout(function() { location.reload(); }, 1200);
      }).catch(function(e) {
        showToast('Operation failed: ' + (e.message || 'unknown error'), true);
      }).finally(function() {
        btn.disabled = false; btn.textContent = 'Yes, delete';
        var area = G('maintenance-confirm-area'); if (area) area.style.display = 'none';
        _maintenanceAction = '';
      });
    });
    G('acc-modal-save').addEventListener('click', saveAccModal);
    G('acc-modal-cancel').addEventListener('click', function() { setView('accounts'); });
    G('acc-email').addEventListener('keydown', function(e) { if (e.key==='Enter') G('acc-password').focus(); });
    G('acc-password').addEventListener('keydown', function(e) { if (e.key==='Enter') saveAccModal(); });
    G('acc-pw-toggle').addEventListener('click', function() {
      var i = G('acc-password'); i.type = i.type === 'password' ? 'text' : 'password';
    });
    G('discord-btn').addEventListener('click', function() { window.open('https://discord.gg/JWhCkhSYtg'); });
    // Phone / remote access info modal — clarifies what's free (same Wi-Fi LAN URL) vs Core (Nexus).
    G('remote-btn').addEventListener('click', function() {
      // /go does all the routing; just hint if the free same-Wi-Fi path needs LAN turned on.
      fetch('/api/settings').then(function(r){return r.json();}).then(function(s){
        var off = !(s && s.deskLanAccess);
        var h = G('remote-lan-off-hint'); if (h) h.style.display = off ? 'block' : 'none';
      }).catch(function(){});
      G('remote-modal').classList.add('open');
    });
    G('remote-close').addEventListener('click', function(){ G('remote-modal').classList.remove('open'); });
    G('remote-modal').addEventListener('click', function(e){ if (e.target === this) this.classList.remove('open'); });
    G('remote-copy').addEventListener('click', function(){
      var v = G('remote-go-url').textContent || '';
      if (v) navigator.clipboard.writeText(v).then(function(){ showToast('Link copied to clipboard'); }).catch(function(){ showToast('Could not copy', true); });
    });
    G('remote-goto-settings').addEventListener('click', function(){ G('remote-modal').classList.remove('open'); setView('settings'); });
    G('nav-dash').addEventListener('click', function() { setView('dash'); });
    G('nav-accounts').addEventListener('click', function() { setView('accounts'); });
    G('nav-console').addEventListener('click', function() { setView('console'); });
    G('nav-settings').addEventListener('click', function() { setView('settings'); });
    G('nav-core').addEventListener('click', function() { setView('core'); });
    G('nav-insights').addEventListener('click', function() { setView('insights'); });
    if (G('ins-refresh')) G('ins-refresh').addEventListener('click', function() { loadInsights(); });
    if(G('console-back')) G('console-back').addEventListener('click', function() { setView('dash'); });
    if(G('settings-back')) G('settings-back').addEventListener('click', function() { setView('dash'); });
    // Scheduler toggle shows/hides fields
    G('tog-scheduler').addEventListener('change', function() {
      _updateSchFields(this.checked);
      saveSetting('scheduler.enabled', this.checked);
    });
    // Scheduler field changes — debounced save
    var _schTimer;
    function _schSave() {
      clearTimeout(_schTimer);
      _schTimer = setTimeout(function() {
        var t = G('sch-startTime'), tz = G('sch-timezone'), mn = G('sch-delayMin'), mx = G('sch-delayMax');
        if (t) saveSetting('scheduler.startTime', t.value);
        if (tz) saveSetting('scheduler.timezone', tz.value);
        if (mn) saveSetting('scheduler.randomDelay.min', mn.value);
        if (mx) saveSetting('scheduler.randomDelay.max', mx.value);
      }, 600);
    }
    ['sch-startTime','sch-timezone','sch-delayMin','sch-delayMax'].forEach(function(id) {
      var el = G(id); if (el) el.addEventListener('change', _schSave);
    });
    G('tog-runOnStartup').addEventListener('change', function() { saveSetting('scheduler.runOnStartup', this.checked); });
    // Core Premium toggles — write core.<key> (+ ensure backing worker is on)
    CORE_KEYS.forEach(function(k) {
      var el = G('tog-core-' + k); if (!el) return;
      el.addEventListener('change', function() {
        if (this.checked && CORE_WORKER_MAP[k]) saveSetting('workers.' + CORE_WORKER_MAP[k], true);
        saveSetting('core.' + k, this.checked);
      });
    });
    // Notification toggles (free)
    var _whD = G('tog-wh-discord');
    if (_whD) _whD.addEventListener('change', function() { saveSetting('webhook.discord.enabled', this.checked); });
    var _whN = G('tog-wh-ntfy');
    if (_whN) _whN.addEventListener('change', function() { saveSetting('webhook.ntfy.enabled', this.checked); });
    // Analytics toggle — persist + show/hide warning
    var _togAn = G('tog-analytics');
    if (_togAn) _togAn.addEventListener('change', function() {
      saveSetting('analytics.enabled', this.checked);
      var w = G('analytics-warning'); if (w) w.style.display = this.checked ? 'none' : 'block';
    });
    // Clusters number input — clamp 1-20 then persist
    var _clEl = G('set-clusters');
    if (_clEl) _clEl.addEventListener('change', function() {
      var v = Math.min(20, Math.max(1, parseInt(this.value, 10) || 1));
      this.value = v;
      saveSetting('core.clusters', v);
    });
    // Configure buttons → open the config modal
    document.querySelectorAll('[data-cfg]').forEach(function(btn) {
      btn.addEventListener('click', function() { openCfgModal(btn.getAttribute('data-cfg')); });
    });
    G('cfg-modal-done').addEventListener('click', function() { G('cfg-modal').classList.remove('open'); });
    G('cfg-modal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('open'); });
    function bindStartupToggle(id, mode) {
      var el = G(id); if (!el) return;
      el.addEventListener('change', async function() {
        var enabled = this.checked;
        var card = this.closest('.startup-card');
        this.disabled = true;
        if (card) card.classList.add('is-busy');
        try {
          var response = await fetch('/api/startup', {
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({mode:mode, enable:enabled})
          });
          var result = await response.json().catch(function(){return {};});
          if (!response.ok) throw new Error(result.error || 'Could not update startup settings.');
          showToast(enabled ? 'Startup enabled.' : 'Startup disabled.');
          await loadSettings();
        } catch(e) {
          this.checked = !enabled;
          showToast(e.message, true);
        } finally {
          this.disabled = false;
          if (card) card.classList.remove('is-busy');
        }
      });
    }
    bindStartupToggle('tog-startup-desk', 'desk');
    // Remote access (Core) — starts/stops the background agent now + persists the setting.
    var _remoteTog = G('tog-remote-access');
    if (_remoteTog) _remoteTog.addEventListener('change', async function() {
      var enabled = this.checked;
      var card = this.closest('.startup-card');
      this.disabled = true; if (card) card.classList.add('is-busy');
      try {
        var r = await fetch('/api/remote-access', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enable:enabled})});
        var res = await r.json().catch(function(){return {};});
        if (!r.ok) throw new Error(res.error || 'Could not update remote access.');
        showToast(enabled ? 'Remote access on — connecting to Nexus…' : 'Remote access off.');
        await loadSettings();
      } catch(e) { this.checked = !enabled; showToast(e.message, true); }
      finally { this.disabled = false; if (card) card.classList.remove('is-busy'); }
    });
    // Headless service — config flag; takes effect on the next launch.
    var _hlTog = G('tog-desk-headless');
    if (_hlTog) _hlTog.addEventListener('change', function() {
      saveSetting('desk.headless', this.checked);
      showToast(this.checked ? 'Headless service on — restart to apply.' : 'Headless service off — restart to apply.');
    });
    var TOGGLE_MAP = {
      'tog-doDailySet':'workers.doDailySet','tog-doSpecialPromotions':'workers.doSpecialPromotions',
      'tog-doMorePromotions':'workers.doMorePromotions','tog-doDesktopSearch':'workers.doDesktopSearch',
      'tog-doMobileSearch':'workers.doMobileSearch','tog-doAppPromotions':'workers.doAppPromotions',
      'tog-strictProxy':'proxy.strictMode',
      'tog-headless':'headless','tog-runOnZero':'runOnZeroPoints',
      'tog-debugLogs':'debugLogs','tog-searchOnBing':'searchOnBingLocalQueries',
      'tog-parallelSearching':'searchSettings.parallelSearching',
      'tog-scrollRandomResults':'searchSettings.scrollRandomResults',
      'tog-clickRandomResults':'searchSettings.clickRandomResults'
    };
    Object.keys(TOGGLE_MAP).forEach(function(id) {
      var el = G(id); if (!el) return;
      el.addEventListener('change', function() { saveSetting(TOGGLE_MAP[id], el.checked); });
    });
    // LAN access — persisted like the others, but the bound socket only changes on
    // the next launch, so we tell the user to restart for it to take effect.
    var _lanTog = G('tog-lanAccess');
    if (_lanTog) _lanTog.addEventListener('change', function() {
      saveSetting('desk.lanAccess', this.checked);
      showToast(this.checked
        ? 'LAN access enabled — restart the Desk to apply.'
        : 'LAN access disabled — restart the Desk to apply.');
    });
    var _openRemote = G('btn-open-remote');
    if (_openRemote) _openRemote.addEventListener('click', function() { var b = G('remote-btn'); if (b) b.click(); });
    // Update notifier — the background process is installed/removed by scripts/start.js
    // at the NEXT launch (not live), so this just persists the flag and tells the user.
    var _notifierTog = G('tog-updateNotifier');
    if (_notifierTog) _notifierTog.addEventListener('change', function() {
      saveSetting('updateNotifier.enabled', this.checked);
      showToast(this.checked
        ? 'Update notifier enabled — restart the Desk to apply.'
        : 'Update notifier disabled — restart the Desk to apply.');
    });
    // Free-text search-tuning fields (debounced save on change; brief saved pulse).
    var TEXT_MAP = {
      'set-visitTime':'searchSettings.searchResultVisitTime',
      'set-globalTimeout':'globalTimeout',
      'set-searchDelayMin':'searchSettings.searchDelay.min',
      'set-searchDelayMax':'searchSettings.searchDelay.max',
      'set-readDelayMin':'searchSettings.readDelay.min',
      'set-readDelayMax':'searchSettings.readDelay.max'
    };
    Object.keys(TEXT_MAP).forEach(function(id) {
      var el = G(id); if (!el) return;
      el.addEventListener('change', function() {
        var v = el.value.trim();
        if (v === '') return; // keep the existing value rather than writing an invalid empty
        saveSetting(TEXT_MAP[id], v);
        el.style.borderColor = 'rgba(47,210,125,.6)';
        setTimeout(function(){ el.style.borderColor = ''; }, 800);
      });
    });
    // Nav: Plugins & Docs
    G('nav-plugins').addEventListener('click', function() { setView('plugins'); });
    G('nav-docs').addEventListener('click', function() { setView('docs'); });
    if(G('plugins-back')) G('plugins-back').addEventListener('click', function() { setView('dash'); });
    if(G('docs-back')) G('docs-back').addEventListener('click', function() { setView('dash'); });
    G('plugins-doc-btn').addEventListener('click', function() { window.open(PLUGIN_DOC_URL); });
    G('plugins-publish-btn').addEventListener('click', function() {
      // Open the developer portal in the user's real default browser.
      window.open('https://bot.lgtw.tf/?view=developers');
    });
    G('plugins-refresh-btn').addEventListener('click', function() { loadPluginsCatalog(true); });
    var _pluginSearchT;
    G('plugins-search').addEventListener('input', function() {
      var q = this.value; clearTimeout(_pluginSearchT);
      _pluginSearchT = setTimeout(function(){ renderCatalog(q); }, 110);
    });
    document.querySelectorAll('.plugins-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        _catalogFilter = btn.getAttribute('data-pfilter') || 'all';
        document.querySelectorAll('.plugins-tab').forEach(function(b) {
          b.classList.toggle('active', b === btn);
        });
        renderCatalog(G('plugins-search') ? G('plugins-search').value : '');
      });
    });
    G('docs-github').addEventListener('click', function() { window.open(DOCS_GITHUB_URL); });
    // Terminal / developer mode
    G('btn-terminal-mode').addEventListener('click', async function() {
      var btn = this;
      if (!confirm('This will set the bot to terminal mode, close Rewards Desk and open a PowerShell window running the bot. Continue?')) return;
      btn.disabled = true; btn.textContent = 'Opening terminal…';
      try {
        await fetch('/api/terminal-mode', {method:'POST'});
        try { window.close(); } catch(e) {}
        document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#6e92b8;font-size:15px;text-align:center;padding:30px">Terminal mode started in a new PowerShell window.<br>You can close this window.</div>';
      } catch(e) {
        btn.disabled = false; btn.textContent = 'Open terminal & run →';
        alert('Could not start terminal mode: ' + e);
      }
    });
    // Console — filters, search, clear, copy, jump
    document.querySelectorAll('.console-filter').forEach(function(btn) {
      btn.addEventListener('click', function() {
        _consoleFilter = btn.getAttribute('data-level');
        document.querySelectorAll('.console-filter').forEach(function(b) {
          b.classList.toggle('active', b === btn);
        });
        updateConsoleBox(false);
      });
    });
    G('console-search').addEventListener('input', function() {
      _consoleSearch = this.value.toLowerCase().trim();
      updateConsoleBox(false);
    });
    G('console-clear').addEventListener('click', function() {
      _consoleClearedAt = Date.now();
      _consoleLogs = [];
      var b = G('console-box');
      if (b) b.innerHTML = '';
      var cnt = G('console-line-count');
      if (cnt) cnt.textContent = '0 lines';
      _consoleFilter = 'all';
      _consoleSearch = '';
      document.querySelectorAll('.console-filter').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-level') === 'all');
      });
      var s = G('console-search');
      if (s) s.value = '';
      fetch('/api/clear-logs', {method:'POST'}).catch(function(){});
    });
    G('console-copy').addEventListener('click', function() {
      var txt = _consoleLogs.map(function(l) {
        var ts = new Date(l.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        return '[' + ts + '] ' + l.message;
      }).join('\\n');
      navigator.clipboard.writeText(txt).then(function(){
        var b = G('console-copy'); var o = b.textContent; b.textContent = 'Copied ✓';
        setTimeout(function(){ b.textContent = o; }, 1400);
      }).catch(function(){});
    });
    G('console-jump').addEventListener('click', function() {
      var b = G('console-box');
      b._stick = true;
      b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' });
    });
    // Track whether the user is following the tail. Only show the jump button
    // when they've scrolled meaningfully up — never while pinned to the bottom.
    G('console-box').addEventListener('scroll', function() {
      this._stick = consoleAtBottom(this);
      updateJumpBtn(this);
    });
    // Tell the Desk a page is alive so it cancels any shutdown a prior refresh scheduled.
    fetch('/api/alive', {method:'POST'}).catch(function(){});
    window.addEventListener('beforeunload', function() {
      // Only the dedicated app window (top-level, loopback) should ask the Desk to quit
      // when it closes. The Desk embedded inside Nexus (an iframe) or opened from a phone
      // over the LAN must NEVER shut it down — and a refresh is rescued by /api/alive above.
      var loopback = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
      if (window.top === window.self && loopback) {
        fetch('/api/close', {method:'POST', keepalive:true}).catch(function(){});
      }
    });
    // Prime scheduler cache for the home "next run" indicator
    // ── Core Activation Overlay ────────────────────────────────────
    async function initLicOverlay() {
      var data;
      try { data = await fetch('/api/license').then(function(r){return r.json();}); }
      catch(e) { return; }
      _coreData = data || { tier: 'free' };
      _licClientReady = !!data.clientReady;
      _licActivated = data.tier === 'premium';
      if (data.loading) {
        setTimeout(initLicOverlay, 500);
        return;
      }
      document.body.classList.toggle('core-enhanced', _licActivated);
      _updateLicSidebarBtn(data);
      renderCoreView();
      if (!_licActivated && _licClientReady && data.coreEnabled !== false) {
        setTimeout(function() { licOpenOverlay('welcome'); }, 750);
      }
    }

    function _updateLicSidebarBtn(data) {
      var btn = G('btn-lic'); if (!btn) return;
      var lbl = G('lic-sidebar-label');
      if (data.tier === 'premium') {
        btn.classList.add('active');
        if (lbl) lbl.textContent = 'Core Active';
        btn.style.display = '';
      } else if (data.clientReady) {
        btn.classList.remove('active');
        if (lbl) lbl.textContent = 'Activate Core';
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    }

    function licOpenOverlay(v) {
      G('lic-overlay').classList.add('open');
      _licSetView(v || 'welcome');
      if (v === 'key' || v === 'welcome') { G('lic-key').value = ''; _licSetError(''); }
      if (v === 'manage') {
        G('lic-manage-plan').textContent = _coreData.planType || 'Premium';
        G('lic-manage-expires').textContent = _coreData.expiresAt
          ? 'Expires ' + new Date(_coreData.expiresAt).toLocaleDateString()
          : 'Lifetime license';
        G('lic-deactivate-error').textContent = '';
      }
    }

    function licCloseOverlay() { G('lic-overlay').classList.remove('open'); }

    function _licSetView(v) {
      ['welcome','key','success','manage'].forEach(function(n) {
        G('lic-view-' + n).style.display = (n === v) ? '' : 'none';
      });
      if (v === 'key') setTimeout(function() { G('lic-key').focus(); }, 60);
    }

    function _licSetError(msg) {
      var el = G('lic-key-error'); if (el) el.textContent = msg || '';
      if (msg) {
        var inp = G('lic-key');
        if (inp) {
          inp.classList.remove('shake');
          void inp.offsetWidth;
          inp.classList.add('shake');
          setTimeout(function(){inp.classList.remove('shake');}, 400);
        }
      }
    }

    async function _licDoActivate() {
      var key = (G('lic-key').value || '').trim();
      if (!key) { _licSetError('Enter your license key.'); return; }
      var btn = G('lic-btn-activate');
      var orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px"><svg style="animation:spin .7s linear infinite;width:15px;height:15px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Validating…</span>';
      _licSetError('');
      var result;
      try {
        result = await fetch('/api/license/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:key})}).then(function(r){return r.json();});
      } catch(e) {
        btn.disabled = false; btn.innerHTML = orig;
        _licSetError('Connection error. Please try again.');
        return;
      }
      btn.disabled = false; btn.innerHTML = orig;
      if (result.success) {
        _licActivated = true;
        document.body.classList.add('core-enhanced');
        _coreData = { tier: 'premium', planType: result.planType, expiresAt: result.expiresAt, clientReady: true };
        G('lic-success-plan').textContent = result.planType || 'Premium';
        G('lic-success-expires').textContent = result.expiresAt
          ? 'Expires ' + new Date(result.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
          : 'Lifetime license';
        _updateLicSidebarBtn({tier:'premium',clientReady:true});
        renderCoreView();
        _licSetView('success');
        _licSpawnConfetti();
        await startPendingRun();
      } else {
        _licSetError(result.message || 'Activation failed.');
      }
    }

    async function _licDoSkip() {
      var buttons = [G('lic-btn-skip-welcome'), G('lic-btn-skip-key')];
      buttons.forEach(function(button){ if (button) button.disabled = true; });
      _licSetError('');
      try {
        var response = await fetch('/api/license/skip', {method:'POST'});
        var result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Could not disable Core.');
        _licensePromptVisible = false;
        licCloseOverlay();
        await startPendingRun();
      } catch(e) {
        _licSetError(e.message || 'Could not continue without Core.');
      } finally {
        buttons.forEach(function(button){ if (button) button.disabled = false; });
      }
    }

    async function _licDoDeactivate() {
      if (!confirm('Deactivate Core on this computer?\\n\\nThis removes the machine activation, disables remote startup, and deletes the local license cache. Your license itself is not cancelled.')) return;
      var btn = G('lic-btn-deactivate');
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Deactivating…';
      G('lic-deactivate-error').textContent = '';
      try {
        var response = await fetch('/api/license/deactivate', {method:'POST'});
        var result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || 'Deactivation failed');
        _licActivated = false;
        _coreData = {tier:'free',clientReady:true};
        document.body.classList.remove('core-enhanced');
        _updateLicSidebarBtn(_coreData);
        renderCoreView();
        licCloseOverlay();
      } catch(e) {
        G('lic-deactivate-error').textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    function paintInstallStatus(data) {
      [['desktop',data.desktop],['menu',data.menu]].forEach(function(entry) {
        var el = G('install-status-' + entry[0]);
        el.classList.toggle('ok', !!entry[1]);
        el.querySelector('span').textContent = entry[1] ? 'Installed' : 'Not installed';
      });
      var installed = data.complete === true;
      var anyInstalled = !!data.desktop || !!data.menu;
      G('install-btn').style.display = installed ? 'none' : '';
      G('desktop-uninstall').disabled = !anyInstalled;
      G('desktop-uninstall').textContent = anyInstalled ? 'Uninstall shortcuts' : 'Not installed';
      return installed;
    }

    async function syncDesktopInstallStatus() {
      var response = await fetch('/api/desktop-install');
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not read installation status');
      return paintInstallStatus(result);
    }

    async function openInstallOverlay() {
      G('install-overlay').classList.add('open');
      G('install-error').textContent = '';
      try { await syncDesktopInstallStatus(); }
      catch(e) { G('install-error').textContent = e.message; }
    }

    async function desktopInstallAction(action) {
      var response = await fetch('/api/desktop-install', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action:action})
      });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Desktop installation failed');
      paintInstallStatus(result);
      return result;
    }

    function _licSpawnConfetti() {
      var c = G('lic-confetti'); if (!c) return;
      c.innerHTML = '';
      var colors = ['#1e9bff','#2ee8ff','#2fd27d','#f7c85c','#ff6b8a','#a78bfa','#fb923c'];
      for (var i = 0; i < 32; i++) {
        var d = document.createElement('div');
        d.className = 'lic-confetti-dot';
        var w = 5 + Math.random() * 6, h = 5 + Math.random() * 6;
        d.style.cssText = 'width:'+w+'px;height:'+h+'px;left:'+(Math.random()*90+5)+'%;top:'+(30+Math.random()*40)+'%;background:'+colors[Math.floor(Math.random()*colors.length)]+';';
        d.style.setProperty('--cx', (Math.random()*180-90)+'px');
        d.style.setProperty('--cy', (-70-Math.random()*130)+'px');
        d.style.setProperty('--cr', (Math.random()*720-360)+'deg');
        d.style.setProperty('--cd', (0.7+Math.random()*0.5)+'s');
        d.style.setProperty('--cdelay', (Math.random()*0.25)+'s');
        c.appendChild(d);
      }
      setTimeout(function(){c.innerHTML='';}, 2000);
    }

    // ── Core view (marketing vs active/retention) ──────────────────
    // Monthly per-account estimates. Intentionally optimistic but grounded in
    // typical Microsoft Rewards values — labelled clearly as estimates in the UI.
    var CORE_EST = {
      claimPoints:      { pts: 220, name: 'Auto-claim points',   d: 'M20 6 9 17l-5-5' },
      applyCoupons:     { pts: 130, name: 'Auto-apply coupons',  d: 'M9 11l3 3L22 4' },
      doubleSearchPoints:{pts: 180, name: 'Double search points',d: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z' },
      exploreOnBing:    { pts: 600, name: 'Explore on Bing',     d: 'M12 2 15 8l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z' },
      appReward:        { pts: 280, name: 'App rewards',         d: 'M5 3h14v18H5z' },
      readToEarn:       { pts: 540, name: 'Read to Earn',        d: 'M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z' },
      dailyCheckIn:     { pts: 150, name: 'Daily check-in',      d: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5' },
      dailyStreak:      { pts: 90,  name: 'Daily streak',        d: 'M12 2 4 7v6c0 5 8 9 8 9s8-4 8-9V7z' },
      streakProtection: { pts: 320, name: 'Streak protection',   d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
      temporaryPunchcards:{pts:240, name: 'Temporary punchcards',d: 'M12 2 15 8l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z' }
    };
    async function loadCoreRealStats() {
      var card = G('core-real-card'); if (!card) return;
      var s; try { s = await fetch('/api/stats').then(function(r){return r.json();}); } catch(e) { return; }
      var empty = G('cr-empty'), grid = card.querySelector('.core-real-grid');
      if (!s || !s.hasData || (s.totalRuns || 0) < 3 || (s.totalPoints || 0) < 500) {
        if (empty) empty.style.display = 'block';
        if (grid) grid.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (grid) grid.style.display = '';
      function fmt(n){ return (n == null ? 0 : n).toLocaleString(); }
      function setTxt(id, v){ var el = G(id); if (el) el.textContent = v; }
      setTxt('cr-points', '+' + fmt(s.totalPoints));
      setTxt('cr-7d', '+' + fmt(s.last7Points));
      setTxt('cr-runs', fmt(s.totalRuns));
      setTxt('cr-success', s.successRate == null ? '—' : s.successRate + '%');
      setTxt('cr-claimed', '+' + fmt(s.claimedPoints));
      setTxt('cr-coupons', fmt(s.couponsApplied));
      var since = G('cr-since');
      if (since && s.firstRunAt) { try { since.textContent = 'since ' + new Date(s.firstRunAt).toLocaleDateString(); } catch(e) {} }
    }

    async function renderCoreView() {
      var active = _coreData && _coreData.tier === 'premium';
      var mk = G('core-view-market'), ac = G('core-view-active');
      if (mk) mk.style.display = active ? 'none' : 'flex';
      if (ac) ac.style.display = active ? 'flex' : 'none';
      if (!active) {
        // Sales hero headline value — sum of the product's own per-account monthly estimates.
        var perAcct = 0; Object.keys(CORE_EST).forEach(function(k){ perAcct += CORE_EST[k].pts; });
        var cv = G('csell-value-num'); if (cv) cv.textContent = '+~' + perAcct.toLocaleString();
        return;
      }
      void loadCoreRealStats();
      var settings = {};
      try { settings = await fetch('/api/settings').then(function(r){return r.json();}); } catch(e) {}
      var core = settings.core || {};
      // Active automations — what Core is currently running for the member (reassurance, no sales numbers).
      var check = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
      var chips = '';
      Object.keys(CORE_EST).forEach(function(k) {
        if (core[k] === false) return;
        chips += '<span class="cmember-chip">' + check + CORE_EST[k].name + '</span>';
      });
      var chipsWrap = G('cmember-auto-chips');
      if (chipsWrap) chipsWrap.innerHTML = chips || '<span style="color:var(--muted);font-size:12.5px">Turn on Core features in Settings to see them here.</span>';
      // License status pill in the header
      var statusEl = G('cmember-status');
      if (statusEl) {
        var statusTxt = 'Active';
        if (_coreData && _coreData.expiresAt) {
          var dleft = Math.ceil((new Date(_coreData.expiresAt) - Date.now()) / 86400000);
          if (dleft > 0) statusTxt = dleft === 1 ? '1 day left' : dleft + ' days left';
          else statusTxt = 'Expired';
        }
        statusEl.textContent = statusTxt;
      }
      // Expiry indicator — reads from already-loaded license state, no extra API call
      var expiryBand = G('core-expiry-band');
      if (expiryBand && _coreData && _coreData.expiresAt) {
        var exp = new Date(_coreData.expiresAt);
        var daysLeft = Math.ceil((exp - Date.now()) / 86400000);
        if (daysLeft > 0 && daysLeft <= 30) {
          G('core-expiry-days').textContent = daysLeft === 1 ? '1 day' : daysLeft + ' days';
          G('core-expiry-date').textContent = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          expiryBand.style.display = 'flex';
        } else {
          expiryBand.style.display = 'none';
        }
      }
    }

    // ── Plugins page ───────────────────────────────────────────────
    // ── Plugins page (unified catalog) ─────────────────────────────
    var _catalog = [];
    var _catalogCore = null;
    var _catalogMeta = { source: 'none', error: null };
    var _hasCoreLicense = false;

    function escAttr(s) { return esc(String(s == null ? '' : s)); }

    function cmpVer(a, b) {
      var pa = String(a || '').split(/[-.+]/), pb = String(b || '').split(/[-.+]/);
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
        if (isNaN(na) && isNaN(nb)) continue;
        if (isNaN(na)) return -1;
        if (isNaN(nb)) return 1;
        if (na > nb) return 1;
        if (na < nb) return -1;
      }
      return 0;
    }

    async function loadPluginsCatalog(forceRefresh) {
      var wrap = G('plugins-catalog');
      if (!_catalog.length && !_catalogCore) wrap.innerHTML = '<div class="docs-loading">Loading plugins…</div>';
      var pluginsData = { plugins: [], hasCoreLicense: false };
      var catData = { catalog: null, source: 'none' };
      try {
        var results = await Promise.all([
          fetch('/api/plugins').then(function(r){ return r.json(); }),
          fetch('/api/marketplace-catalog' + (forceRefresh ? '?refresh=1' : '')).then(function(r){ return r.json(); }).catch(function(e){ return { catalog: null, source: 'none', error: e.message }; })
        ]);
        pluginsData = results[0] || pluginsData;
        catData = results[1] || catData;
      } catch(e) {
        wrap.innerHTML = '<div class="pempty">Could not read plugins.<br><span style="font-size:11px;opacity:.7">Make sure the bot is running, then try again.</span></div>';
        return;
      }
      var installed = {};
      (pluginsData.plugins || []).forEach(function(p){ installed[p.name] = p; });
      _hasCoreLicense = !!pluginsData.hasCoreLicense;
      _catalogCore = installed['core'] || null;
      var catalogPlugins = (catData && catData.catalog && Array.isArray(catData.catalog.plugins)) ? catData.catalog.plugins : [];
      _catalogMeta = { source: (catData && catData.source) || 'none', error: (catData && catData.error) || null };

      var byName = {};
      catalogPlugins.forEach(function(c){
        if (!c || c.name === 'core') return;
        var existing = byName[c.name];
        if (!existing || cmpVer(c.version, existing.latest) > 0) {
          byName[c.name] = { name: c.name, version: c.version || '', author: c.authorUsername || '', license: c.license || '', description: c.description || '', inCatalog: true, latest: c.version || '' };
        }
      });
      (pluginsData.plugins || []).forEach(function(p){
        if (p.name === 'core') return;
        var m = byName[p.name] || { name: p.name, version: p.version || '', author: '', license: '', description: p.description || '', inCatalog: false, latest: '' };
        m.installed = true;
        m.enabled = p.enabled;
        m.source = p.source;
        m.trust = p.trust;
        m.unmanaged = !!p.unmanaged;
        m.installedVersion = p.installedVersion || p.version || '';
        m.pinned = !!p.version;
        m.autoUpdate = p.autoUpdate;
        m.stale = p.stale;
        if (!m.description && p.description) m.description = p.description;
        byName[p.name] = m;
      });
      _catalog = Object.keys(byName).map(function(k){ return byName[k]; });
      _catalog.sort(function(a, b){
        var ai = a.installed ? 0 : 1, bi = b.installed ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
      renderCatalog(G('plugins-search') ? G('plugins-search').value : '');
    }

    var _catalogFilter = 'all';

    function coreCardHtml(core) {
      var features = ['Auto-claim','Coupons','2× Search points','App rewards','Read-to-earn','Streak shield','Punchcards','Remote dashboard'];
      var featsHtml = features.map(function(f){ return '<span class="pcore-feat">' + f + '</span>'; }).join('');
      return '<div class="pcore-card">' +
        '<div class="pcore-ico"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>' +
        '<div class="pcore-main">' +
          '<div class="pcore-head">' +
            '<span class="pcore-name">Core</span>' +
            '<span class="pchip pchip-official">Official</span>' +
            (core.enabled ? '' : '<span class="pchip pchip-off">Off</span>') +
            '<div class="pcore-side">' +
              (_hasCoreLicense ? '' : '<div class="pcore-locked"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Unlock</div>') +
              '<label class="toggle"><input type="checkbox" data-plugin="core"' + (core.enabled ? ' checked' : '') + '><span class="toggle-slider"></span></label>' +
            '</div>' +
          '</div>' +
          '<div class="pcore-desc">The official premium plugin — unlocks every bonus task and the remote dashboard.</div>' +
          '<div class="pcore-feats">' + featsHtml + '</div>' +
        '</div>' +
      '</div>';
    }

    function pluginCardHtml(p) {
      var puzzle = '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5"/>';
      var updatable = p.installed && p.inCatalog && p.installedVersion && p.latest && cmpVer(p.latest, p.installedVersion) > 0;
      var held = p.installed && (p.pinned || p.autoUpdate === false || p.trust === 'full');
      var isMkt = p.source === 'marketplace';
      // Chips — version, status, update hint
      var ver = p.installed ? (p.installedVersion || p.version) : p.version;
      var chips = '';
      if (ver) chips += '<span class="pchip pchip-ver">v' + esc(ver) + '</span>';
      if (!p.installed && p.license) chips += '<span class="pchip pchip-ver">' + esc(p.license) + '</span>';
      if (p.installed && p.trust === 'full') chips += '<span class="pchip pchip-trusted">Trusted</span>';
      if (p.unmanaged) chips += '<span class="pchip pchip-stale">Not in config</span>';
      if (p.installed && !p.enabled && !p.unmanaged) chips += '<span class="pchip pchip-off">Off</span>';
      if (p.installed && p.stale) chips += '<span class="pchip pchip-stale">Outdated</span>';
      if (updatable) chips += '<span class="pchip pchip-update">v' + esc(p.latest) + ' ready</span>';
      // Author / origin line
      var meta = [];
      if (p.author) meta.push('by ' + esc(p.author));
      if (p.installed && !p.inCatalog) meta.push('local');
      // Top-right primary control: enable toggle (installed) — store cards install from the
      // footer. Unmanaged (on-disk, no config entry) plugins have no toggle to flip.
      var topCtrl = (p.installed && !p.unmanaged)
        ? '<label class="toggle" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '"><input type="checkbox" data-plugin="' + escAttr(p.name) + '" data-source="' + escAttr(p.source || 'local') + '"' + (p.enabled ? ' checked' : '') + '><span class="toggle-slider"></span></label>'
        : '';
      // Footer — manage controls (left) + actions (right)
      var footL = '', footR = '';
      if (p.installed) {
        if (isMkt && !p.unmanaged) {
          footL += '<label class="pmanage-trust" title="Lets this plugin access more bot APIs — no OS, admin or filesystem access"><input type="checkbox" data-trust="' + escAttr(p.name) + '"' + (p.trust === 'full' ? ' checked' : '') + '>Trusted</label>';
          if (!p.pinned) footL += '<label class="pmanage-au" title="Keep this plugin up to date from the store"><input type="checkbox" data-autoupdate="' + escAttr(p.name) + '"' + (p.autoUpdate !== false ? ' checked' : '') + '>Auto-update</label>';
        }
        if (held && updatable) footR += '<button class="pbtn pbtn-update" data-update="' + escAttr(p.name) + '" data-ver="' + escAttr(p.latest) + '">Update</button>';
        var hasPanel = (p.settings && p.settings.length) || p.panel || (p.elevatedPermissions && p.elevatedPermissions.length);
        if (hasPanel) footR += '<button class="pbtn pbtn-cfg" data-cfg="' + escAttr(p.name) + '">Settings</button>';
        if (isMkt) footR += '<button class="plink plink-ico" data-report="' + escAttr(p.name) + '" data-rv="' + escAttr(p.installedVersion || p.version) + '" title="Report a problem"><svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></button>';
        footR += '<button class="plink plink-ico danger" data-remove="' + escAttr(p.name) + '" title="Remove"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
      } else {
        footR += '<button class="pbtn pbtn-install" data-install="' + escAttr(p.name) + '" data-ver="' + escAttr(p.version) + '">Install</button>';
      }
      var foot = '<div class="pcard-foot"><div class="pcard-foot-l">' + footL + '</div><div class="pcard-foot-r">' + footR + '</div></div>';
      return '<div class="pcard' + (p.installed ? ' is-installed' : '') + (p.installed && !p.enabled ? ' is-off' : '') + '">' +
        '<div class="pcard-top">' +
          '<div class="pcard-ico"><svg viewBox="0 0 24 24">' + puzzle + '</svg></div>' +
          '<div class="pcard-id">' +
            '<div class="pcard-name">' + esc(p.name) + '</div>' +
            (meta.length ? '<div class="pcard-author">' + meta.join(' · ') + '</div>' : '') +
          '</div>' + topCtrl +
        '</div>' +
        (chips ? '<div class="pcard-chips">' + chips + '</div>' : '') +
        (p.description ? '<div class="pcard-desc">' + esc(p.description) + '</div>' : '<div class="pcard-desc pcard-desc-empty">No description provided.</div>') +
        foot +
        pluginPanelHtml(p) +
      '</div>';
    }

    // Read-only panel (fixed vocabulary: title + labelled stats + text lines) a plugin
    // pushed via ctx.ui.panel — never HTML. Everything is escaped on the way in.
    function pluginOutputHtml(panel) {
      if (!panel) return '';
      var h = '';
      if (panel.title) h += '<div class="pp-out-title">' + esc(panel.title) + '</div>';
      if (Array.isArray(panel.stats) && panel.stats.length) {
        h += '<div class="pp-out-stats">' + panel.stats.map(function(s){
          return '<div class="pp-out-stat"><div class="pp-out-v">' + esc(String(s.value)) + '</div><div class="pp-out-l">' + esc(String(s.label)) + '</div>' +
            (s.hint ? '<div class="pp-out-h">' + esc(String(s.hint)) + '</div>' : '') + '</div>';
        }).join('') + '</div>';
      }
      if (Array.isArray(panel.lines) && panel.lines.length) {
        h += '<div class="pp-out-lines">' + panel.lines.map(function(l){ return '<div class="pp-out-line">' + esc(String(l)) + '</div>'; }).join('') + '</div>';
      }
      if (panel.updatedAt) { var t = new Date(panel.updatedAt); if (!isNaN(t)) h += '<div class="pp-out-ts">Updated ' + esc(t.toLocaleString()) + '</div>'; }
      return h ? '<div class="pp-out">' + h + '</div>' : '';
    }

    // One settings field -> a labelled input bound by data-k. Values come from p.settingsValues.
    function pluginFieldHtml(name, f, values) {
      var val = (values && values[f.key] !== undefined) ? values[f.key] : (f.default !== undefined ? f.default : '');
      var id = 'set-' + name + '-' + f.key;
      var input;
      if (f.type === 'toggle') {
        input = '<label class="pp-switch"><input type="checkbox" id="' + escAttr(id) + '" data-k="' + escAttr(f.key) + '"' + (val ? ' checked' : '') + '><span class="pp-switch-s"></span></label>';
      } else if (f.type === 'select') {
        var opts = (f.options || []).map(function(o){ return '<option value="' + escAttr(String(o.value)) + '"' + (String(o.value) === String(val) ? ' selected' : '') + '>' + esc(String(o.label != null ? o.label : o.value)) + '</option>'; }).join('');
        input = '<select class="pp-input" id="' + escAttr(id) + '" data-k="' + escAttr(f.key) + '">' + opts + '</select>';
      } else {
        var t = f.type === 'number' ? 'number' : 'text';
        var attrs = '';
        if (f.type === 'number') { if (f.min != null) attrs += ' min="' + escAttr(String(f.min)) + '"'; if (f.max != null) attrs += ' max="' + escAttr(String(f.max)) + '"'; if (f.step != null) attrs += ' step="' + escAttr(String(f.step)) + '"'; }
        input = '<input class="pp-input" type="' + t + '" id="' + escAttr(id) + '" data-k="' + escAttr(f.key) + '" value="' + escAttr(String(val)) + '"' + (f.placeholder ? ' placeholder="' + escAttr(f.placeholder) + '"' : '') + attrs + '>';
      }
      return '<div class="pp-field"><label class="pp-label" for="' + escAttr(id) + '">' + esc(f.label) + (f.help ? '<span class="pp-help">' + esc(f.help) + '</span>' : '') + '</label>' + input + '</div>';
    }

    // Elevated (net:*) permissions with a warning + a consent toggle each. Denied by
    // default; the plugin's ctx.fetch only works for hosts the user turns on here.
    function pluginPermsHtml(p) {
      if (!p.elevatedPermissions || !p.elevatedPermissions.length) return '';
      var rows = p.elevatedPermissions.map(function(perm){
        return '<div class="pp-perm">' +
          '<div class="pp-perm-info"><div class="pp-perm-host">' + esc(perm.host) + '</div>' +
          '<div class="pp-perm-sub">Network access — this plugin can send/receive data with this host</div></div>' +
          '<label class="pp-switch"><input type="checkbox" data-grant="' + escAttr(p.name) + '" data-perm="' + escAttr(perm.permission) + '"' + (perm.granted ? ' checked' : '') + '><span class="pp-switch-s"></span></label>' +
        '</div>';
      }).join('');
      return '<div class="pp-perms"><div class="pp-perms-head"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>Elevated permissions</div>' +
        '<div class="pp-perms-warn">Only turn these on for a plugin you trust. Network access lets it talk to outside servers.</div>' +
        rows + '</div>';
    }

    function pluginPanelHtml(p) {
      if (!p.installed || (!(p.settings && p.settings.length) && !p.panel && !(p.elevatedPermissions && p.elevatedPermissions.length))) return '';
      var h = '<div class="pcard-panel" data-panel-for="' + escAttr(p.name) + '" style="display:none">';
      h += pluginPermsHtml(p);
      if (p.settings && p.settings.length) {
        h += '<form class="pp-form" data-settings-for="' + escAttr(p.name) + '">';
        h += p.settings.map(function(f){ return pluginFieldHtml(p.name, f, p.settingsValues); }).join('');
        h += '<div class="pp-form-actions"><button type="submit" class="pbtn pbtn-primary pp-save">Save settings</button><span class="pp-saved" style="display:none">Saved ✓</span></div>';
        h += '</form>';
      }
      h += pluginOutputHtml(p.panel);
      h += '</div>';
      return h;
    }

    function psectHtml(title, n) {
      return '<div class="psect"><span class="psect-title">' + title + '</span>' +
        (n ? '<span class="psect-count">' + n + '</span>' : '') +
        '<span class="psect-line"></span></div>';
    }

    function marketplaceEmptyHtml() {
      if (_catalogMeta.error) return '<div class="pempty">Could not reach the store.<br><small>' + esc(_catalogMeta.error) + '</small></div>';
      return '<div class="pempty">No community plugins in the store yet — check back soon.</div>';
    }

    function renderCatalog(filterQ) {
      var wrap = G('plugins-catalog');
      if (!wrap) return;
      var q = (filterQ || '').trim().toLowerCase();
      var showInst = _catalogFilter !== 'marketplace';
      var showMkt = _catalogFilter !== 'installed';
      var html = '';
      if (_catalogCore && showInst) {
        var matchCore = !q || 'core official premium'.indexOf(q) >= 0;
        if (matchCore) html += coreCardHtml(_catalogCore);
      }
      var items = _catalog.filter(function(p){
        if (!q) return true;
        return (p.name + ' ' + (p.author || '') + ' ' + (p.description || '')).toLowerCase().indexOf(q) >= 0;
      });
      var inst = showInst ? items.filter(function(p){ return p.installed; }) : [];
      var avail = showMkt ? items.filter(function(p){ return !p.installed; }) : [];
      if (inst.length) {
        html += '<div class="psection">' + psectHtml('Installed', inst.length) +
          '<div class="pgrid">' + inst.map(pluginCardHtml).join('') + '</div></div>';
      }
      if (showMkt) {
        html += '<div class="psection">' + psectHtml('Store', avail.length) +
          (avail.length ? '<div class="pgrid">' + avail.map(pluginCardHtml).join('') + '</div>' : marketplaceEmptyHtml()) +
          '</div>';
      }
      if (!html) html = '<div class="pempty">No plugins match your search.</div>';
      wrap.innerHTML = html;
      var totalInst = _catalog.filter(function(p){ return p.installed; }).length + (_catalogCore ? 1 : 0);
      var totalAvail = _catalog.filter(function(p){ return !p.installed; }).length;
      var ti = G('ptab-installed'); if (ti) ti.textContent = totalInst ? 'Installed (' + totalInst + ')' : 'Installed';
      var tm = G('ptab-marketplace'); if (tm) tm.textContent = totalAvail ? 'Store (' + totalAvail + ')' : 'Store';
      bindCatalogEvents();
    }

    function bindCatalogEvents() {
      var wrap = G('plugins-catalog');
      wrap.querySelectorAll('input[data-plugin]').forEach(function(inp) {
        inp.addEventListener('change', function() {
          var name = inp.getAttribute('data-plugin');
          var source = inp.getAttribute('data-source');
          if (inp.checked && source === 'marketplace') {
            if (!window.confirm('"' + name + '" is a community plugin — made by the community, NOT the official team. It runs sandboxed with limited access. Enable it?')) { inp.checked = false; return; }
          }
          fetch('/api/plugins', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, enabled:inp.checked})}).catch(function(){});
        });
      });
      wrap.querySelectorAll('input[data-trust]').forEach(function(inp) {
        inp.addEventListener('change', function() {
          var name = inp.getAttribute('data-trust');
          if (inp.checked) {
            if (!window.confirm('Trusted Mode lets "' + name + '" access more of the bot\\'s internal APIs. It still runs inside the bot process — no OS, admin or filesystem access is granted. Enable only if you trust this plugin\\'s author. Continue?')) { inp.checked = false; return; }
          }
          fetch('/api/plugins', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, trust: inp.checked ? 'full' : 'sandbox'})}).catch(function(){});
        });
      });
      wrap.querySelectorAll('input[data-autoupdate]').forEach(function(inp) {
        inp.addEventListener('change', function() {
          var name = inp.getAttribute('data-autoupdate');
          fetch('/api/plugins', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, autoUpdate: inp.checked})}).catch(function(){});
        });
      });
      wrap.querySelectorAll('button[data-install]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var name = btn.getAttribute('data-install');
          var ver = btn.getAttribute('data-ver');
          
          if (!btn.classList.contains('confirming')) {
            btn.classList.add('confirming');
            var oldText = btn.textContent;
            btn.textContent = 'Confirm Install?';
            btn.style.background = 'rgba(255,107,138,0.2)';
            btn.style.color = 'var(--rose)';
            btn.style.borderColor = 'rgba(255,107,138,0.6)';
            setTimeout(() => {
              if (btn && btn.classList.contains('confirming')) {
                btn.classList.remove('confirming');
                btn.textContent = oldText;
                btn.style = '';
              }
            }, 3000);
            return;
          }
          
          btn.classList.remove('confirming');
          btn.style = '';
          btn.disabled = true; btn.textContent = 'Installing…';
          try {
            var r = await fetch('/api/plugins/install', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, version:ver})});
            if (r.ok) { loadPluginsCatalog(false); }
            else { btn.disabled = false; btn.textContent = 'Failed'; setTimeout(() => btn.textContent = 'Install', 2000); }
          } catch(e) { btn.disabled = false; btn.textContent = 'Error'; setTimeout(() => btn.textContent = 'Install', 2000); }
        });
      });
      wrap.querySelectorAll('button[data-update]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var name = btn.getAttribute('data-update');
          var ver = btn.getAttribute('data-ver');
          btn.disabled = true; btn.textContent = 'Updating…';
          try {
            var r = await fetch('/api/plugins/update', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, version:ver})});
            if (r.ok) { loadPluginsCatalog(false); }
            else { var msg = await r.text(); btn.disabled = false; btn.textContent = 'Update'; alert('Could not update "' + name + '": ' + (msg || 'Unknown error')); }
          } catch(e) { btn.disabled = false; btn.textContent = 'Update'; alert('Update failed: ' + e.message); }
        });
      });
      wrap.querySelectorAll('button[data-remove]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var name = btn.getAttribute('data-remove');
          if (!window.confirm('Remove "' + name + '"? This disables it and deletes its downloaded files. You can re-install it from the marketplace anytime.')) return;
          try {
            var r = await fetch('/api/plugins/remove', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name})});
            if (r.ok) { loadPluginsCatalog(false); }
            else { var msg = await r.text(); alert('Could not remove "' + name + '": ' + (msg || 'Unknown error')); }
          } catch(e) { alert('Remove failed: ' + e.message); }
        });
      });
      wrap.querySelectorAll('button[data-report]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var name = btn.getAttribute('data-report');
          var ver = btn.getAttribute('data-rv');
          var reason = window.prompt('Report "' + name + '" to the maintainers. What is the problem? (malware, abuse, broken, impersonation, etc.)');
          if (!reason || reason.trim().length < 3) return;
          try {
            var r = await fetch('/api/plugins/report', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, version:ver, reason:reason})});
            if (r.ok) { alert('Thanks — your report was sent to the maintainers.'); }
            else { var msg = await r.text(); alert('Could not send the report: ' + (msg || 'Unknown error')); }
          } catch(e) { alert('Report failed: ' + e.message); }
        });
      });
      // Toggle a plugin's settings/panel area open/closed.
      wrap.querySelectorAll('button[data-cfg]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var name = btn.getAttribute('data-cfg');
          var panel = wrap.querySelector('.pcard-panel[data-panel-for="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
          if (!panel) return;
          var open = panel.style.display !== 'none';
          panel.style.display = open ? 'none' : 'block';
          btn.classList.toggle('active', !open);
        });
      });
      // Grant / revoke an elevated (net:*) permission — with a confirm when turning ON.
      wrap.querySelectorAll('input[data-grant]').forEach(function(inp) {
        inp.addEventListener('change', async function() {
          var name = inp.getAttribute('data-grant');
          var perm = inp.getAttribute('data-perm');
          if (inp.checked && !window.confirm('Allow "' + name + '" to access the network host "' + perm.slice(4) + '"?\\n\\nThe plugin will be able to send and receive data with this server. Only allow this if you trust the plugin.')) {
            inp.checked = false; return;
          }
          try {
            var r = await fetch('/api/plugins/grant', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, permission:perm, granted:inp.checked})});
            if (!r.ok) { var msg = await r.text(); inp.checked = !inp.checked; alert('Could not change permission: ' + (msg || 'Unknown error')); }
          } catch(e) { inp.checked = !inp.checked; alert('Permission change failed: ' + e.message); }
        });
      });
      // Save a plugin's settings (coerced server-side against its declared schema).
      wrap.querySelectorAll('form[data-settings-for]').forEach(function(form) {
        form.addEventListener('submit', async function(e) {
          e.preventDefault();
          var name = form.getAttribute('data-settings-for');
          var values = {};
          form.querySelectorAll('[data-k]').forEach(function(inp) {
            var key = inp.getAttribute('data-k');
            values[key] = inp.type === 'checkbox' ? inp.checked : inp.value;
          });
          var saveBtn = form.querySelector('.pp-save');
          var savedMsg = form.querySelector('.pp-saved');
          if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
          try {
            var r = await fetch('/api/plugins/settings', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name, values:values})});
            if (r.ok) {
              if (savedMsg) { savedMsg.style.display = ''; setTimeout(function(){ savedMsg.style.display = 'none'; }, 2200); }
            } else { var msg = await r.text(); alert('Could not save settings: ' + (msg || 'Unknown error')); }
          } catch(err) { alert('Save failed: ' + err.message); }
          finally { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save settings'; } }
        });
      });
    }

    // (legacy loadMarketplace removed — marketplace browsing is unified into
    // loadPluginsCatalog / renderCatalog above.)

    // ── Docs page ──────────────────────────────────────────────────
    var _docsLoaded = false;
    var _allDocFiles = [];
    async function loadDocs() {
      if (_docsLoaded) return;
      var nav = G('docs-nav');
      var data;
      try { data = await fetch('/api/docs').then(function(r){return r.json();}); }
      catch(e) { G('docs-content').innerHTML = '<div class="docs-loading">Could not load documentation.</div>'; return; }
      var files = data.files || [];
      if (!files.length) { G('docs-content').innerHTML = '<div class="docs-loading">No documentation found.</div>'; return; }
      // Mark What's New as new if version changed since last visit
      var lastVer = localStorage.getItem('msrb_whatsNewVersion');
      files = files.map(function(f) {
        if (f.virtual && f.name === 'whats-new') return Object.assign({}, f, { isNew: data.version && data.version !== lastVer });
        return f;
      });
      _allDocFiles = files;
      function renderNav(list) {
        nav.innerHTML = list.map(function(f) {
          var cat = f.category ? '<div class="docs-nav-section">'+esc(f.category)+'</div>' : '';
          var badge = f.isNew ? '<span class="docs-badge-new">New</span>' : '';
          var extra = f.virtual ? ' docs-nav-item-whats-new' : (f.core ? ' docs-nav-core' : '');
          var cls = 'docs-nav-item' + extra;
          return cat + '<div class="'+cls+'" data-doc="'+esc(f.name)+'">'+esc(f.title)+badge+'</div>';
        }).join('');
        nav.querySelectorAll('[data-doc]').forEach(function(el) {
          el.addEventListener('click', function() { openDoc(el.getAttribute('data-doc')); });
        });
      }
      renderNav(files);
      var searchEl = G('docs-search');
      if (searchEl) {
        searchEl.addEventListener('input', function() {
          var q = searchEl.value.trim().toLowerCase();
          if (!q) { renderNav(_allDocFiles); return; }
          var filtered = _allDocFiles.filter(function(f) {
            return f.title.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
          }).map(function(f) { return Object.assign({}, f, { category: null }); });
          renderNav(filtered);
          nav.querySelectorAll('[data-doc]').forEach(function(el) {
            if (el.getAttribute('data-doc') === _currentDoc) el.classList.add('active');
          });
        });
      }
      _docsLoaded = true;
      openDoc(data.default || files[0].name);
    }
    var _currentDoc = '';
    async function openDoc(name) {
      _currentDoc = name;
      var isCore = /^(core-plugin|core-plugin-reference|dashboard)\.md$/i.test(name);
      var isWhatsNew = name === 'whats-new';
      G('docs-nav').querySelectorAll('[data-doc]').forEach(function(el) {
        el.classList.toggle('active', el.getAttribute('data-doc') === name);
      });
      var content = G('docs-content');
      content.innerHTML = '<div class="docs-loading">Loading…</div>';
      var html = '';
      if (isWhatsNew) {
        // Mark as seen
        try {
          var verData = await fetch('/api/docs').then(function(r){return r.json();});
          if (verData.version) localStorage.setItem('msrb_whatsNewVersion', verData.version);
          // Remove NEW badge from What's New in nav
          G('docs-nav').querySelectorAll('[data-doc="whats-new"] .docs-badge-new').forEach(function(b){b.remove();});
        } catch(e) {}
        var log;
        try { log = await fetch('/api/whats-new').then(function(r){return r.json();}); }
        catch(e) { log = null; }
        var entries = log && log.commits ? log.commits : null;
        if (!entries) {
          html = '<h1>What\\'s New</h1><div class="changelog-empty">Git history is not available in this install.</div>';
        } else if (!entries.length) {
          html = '<h1>What\\'s New</h1><div class="changelog-empty">No recent changes found.</div>';
        } else {
          html = '<h1>What\\'s New</h1><p style="color:var(--muted);font-size:13px;margin:0 0 20px">Recent changes to Microsoft Rewards Bot. Updates apply automatically on <code>npm start</code>.</p><div class="changelog-wrap">' +
            entries.map(function(c){
              return '<div class="changelog-entry"><span class="changelog-hash">'+esc(c.hash)+'</span><div class="changelog-msg">'+esc(c.message)+'</div></div>';
            }).join('') + '</div>';
        }
      } else {
        var md;
        try { md = await fetch('/api/docs?file=' + encodeURIComponent(name)).then(function(r){return r.text();}); }
        catch(e) { content.innerHTML = '<div class="docs-loading">Could not load this page.</div>'; return; }
        content.classList.toggle('docs-content-core', isCore);
        var promo = isCore
          ? '<div class="docs-core-promo"><div class="docs-core-promo-left"><span class="docs-core-promo-badge">CORE</span><span class="docs-core-promo-text">3 free days — claim on Discord</span></div><button class="docs-core-promo-btn" onclick="window.open(\\'https://discord.gg/JWhCkhSYtg\\')">View Store →</button></div>'
          : '';
        html = promo + renderMarkdown(md);
      }
      content.innerHTML = html;
      content.scrollTop = 0;
      content.style.animation = 'none';
      content.getBoundingClientRect();
      content.style.animation = '';
      // Add copy buttons to code blocks
      content.querySelectorAll('pre').forEach(function(pre) {
        var wrap = document.createElement('div');
        wrap.className = 'code-block-wrap';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        var btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', function() {
          var code = pre.querySelector('code');
          navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(function() {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function(){ btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
          }).catch(function(){});
        });
        wrap.appendChild(btn);
      });
      content.querySelectorAll('a[href]').forEach(function(a) {
        var href = a.getAttribute('href');
        if (/^https?:/.test(href)) { a.addEventListener('click', function(e){ e.preventDefault(); window.open(href); }); }
        else if (/\\.md($|#)/.test(href)) {
          var doc = href.replace(/^.*\\//,'').replace(/#.*$/,'');
          a.addEventListener('click', function(e){ e.preventDefault(); openDoc(doc); });
        }
      });
    }
    function renderMarkdown(src) {
      var esch = function(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
      var inline = function(s) {
        s = s.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '');
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(m,t,u){ return '<a href="'+u+'">'+t+'</a>'; });
        s = s.replace(/\`([^\`]+)\`/g, function(m,c){ return '<code>'+esch(c)+'</code>'; });
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
        return s;
      };
      var lines = src.replace(/\\r/g,'').split('\\n');
      var out = [], i = 0, inList = false, listTag = 'ul';
      var closeList = function(){ if (inList){ out.push('</'+listTag+'>'); inList=false; } };
      while (i < lines.length) {
        var ln = lines[i];
        if (/^\`\`\`/.test(ln)) {
          closeList();
          var buf = []; i++;
          while (i < lines.length && !/^\`\`\`/.test(lines[i])) { buf.push(esch(lines[i])); i++; }
          out.push('<pre><code>'+buf.join('\\n')+'</code></pre>'); i++; continue;
        }
        if (/^\\s*\\|(.+)\\|\\s*$/.test(ln) && i+1<lines.length && /^\\s*\\|[-:\\s|]+\\|\\s*$/.test(lines[i+1])) {
          closeList();
          var head = ln.trim().replace(/^\\||\\|$/g,'').split('|').map(function(c){return '<th>'+inline(c.trim())+'</th>';}).join('');
          i += 2; var body = '';
          while (i < lines.length && /^\\s*\\|(.+)\\|\\s*$/.test(lines[i])) {
            body += '<tr>'+lines[i].trim().replace(/^\\||\\|$/g,'').split('|').map(function(c){return '<td>'+inline(c.trim())+'</td>';}).join('')+'</tr>'; i++;
          }
          out.push('<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>'); continue;
        }
        var h = ln.match(/^(#{1,4})\\s+(.*)$/);
        if (h) { closeList(); out.push('<h'+h[1].length+'>'+inline(esch(h[2]))+'</h'+h[1].length+'>'); i++; continue; }
        if (/^\\s*>\\s?/.test(ln)) { closeList(); out.push('<blockquote>'+inline(esch(ln.replace(/^\\s*>\\s?/,'')))+'</blockquote>'); i++; continue; }
        if (/^\\s*([-*+])\\s+/.test(ln)) {
          if (!inList || listTag!=='ul'){ closeList(); out.push('<ul>'); inList=true; listTag='ul'; }
          out.push('<li>'+inline(esch(ln.replace(/^\\s*[-*+]\\s+/,'')))+'</li>'); i++; continue;
        }
        if (/^\\s*\\d+\\.\\s+/.test(ln)) {
          if (!inList || listTag!=='ol'){ closeList(); out.push('<ol>'); inList=true; listTag='ol'; }
          out.push('<li>'+inline(esch(ln.replace(/^\\s*\\d+\\.\\s+/,'')))+'</li>'); i++; continue;
        }
        if (/^\\s*(---|\\*\\*\\*|___)\\s*$/.test(ln)) { closeList(); out.push('<hr>'); i++; continue; }
        if (/^\\s*$/.test(ln)) { closeList(); i++; continue; }
        closeList(); out.push('<p>'+inline(esch(ln))+'</p>'); i++;
      }
      closeList();
      return out.join('\\n');
    }

    G('btn-lic').addEventListener('click', function() {
      licOpenOverlay(_licActivated ? 'manage' : 'welcome');
    });
    G('lic-btn-show-key').addEventListener('click', function() { _licSetView('key'); });
    G('lic-btn-back').addEventListener('click', function() { _licSetView('welcome'); });
    G('lic-btn-skip-welcome').addEventListener('click', _licDoSkip);
    G('lic-btn-skip-key').addEventListener('click', _licDoSkip);
    G('lic-btn-activate').addEventListener('click', _licDoActivate);
    G('lic-key').addEventListener('keydown', function(e) { if (e.key==='Enter') _licDoActivate(); });
    G('lic-btn-success-close').addEventListener('click', licCloseOverlay);
    G('lic-btn-deactivate').addEventListener('click', _licDoDeactivate);
    G('lic-btn-manage-close').addEventListener('click', licCloseOverlay);
    G('core-manage-license').addEventListener('click', function(){licOpenOverlay('manage');});
    G('lic-overlay').addEventListener('click', function(e) { if (e.target===this) licCloseOverlay(); });
    G('install-btn').addEventListener('click', openInstallOverlay);
    G('install-close').addEventListener('click', function(){G('install-overlay').classList.remove('open');});
    G('install-overlay').addEventListener('click', function(e){if(e.target===this)this.classList.remove('open');});
    G('install-create').addEventListener('click', async function() {
      var button = this;
      setButtonBusy(button, true, 'Installing');
      try {
        await desktopInstallAction('install');
        showToast('Rewards Desk shortcuts installed.');
        G('install-overlay').classList.remove('open');
      }
      catch(e) { G('install-error').textContent = e.message; }
      finally { setButtonBusy(button, false); }
    });
    G('desktop-uninstall').addEventListener('click', async function() {
      if (!confirm('Remove the Rewards Desk shortcuts?')) return;
      var button = this;
      setButtonBusy(button, true, 'Removing');
      try {
        await desktopInstallAction('uninstall');
        showToast('Rewards Desk shortcuts removed.');
      } catch(e) {
        showToast(e.message, true);
      } finally {
        setButtonBusy(button, false);
        syncDesktopInstallStatus().catch(function(){});
      }
    });

    // ── Global external link handler ─────────────────────────────────────────
    window.open = function(url) {
      fetch('/api/open-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url })
      }).catch(function(){});
    };

    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (a && a.href && /^https?:/.test(a.href)) {
        e.preventDefault();
        window.open(a.href);
      }
    });

    // ── GitHub Star prompt ──────────────────────────────────────────────────
    (function initStarPrompt() {
      var modal = G('star-modal');
      if (!modal) return;

      function close() { modal.classList.remove('open'); }

      // Check if any other modal/overlay is currently visible
      function isAnyModalOpen() {
        var openEls = document.querySelectorAll('.modal-bg.open, .lic-overlay.open, .install-overlay.open');
        return openEls.length > 0;
      }

      // Show only if no other modal is in the way; retry every 1.2s until clear
      function tryShow() {
        if (isAnyModalOpen()) {
          setTimeout(tryShow, 1200);
          return;
        }
        modal.classList.add('open');
      }

      G('star-btn-go').addEventListener('click', function() {
        window.open('https://github.com/QuestPilot/Microsoft-Rewards-Bot');
        fetch('/api/star/done', { method: 'POST' }).catch(function(){});
        
        var btn = G('star-btn-go');
        btn.disabled = true;
        
        setTimeout(function() {
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#0a0800" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Thank you!';
          G('star-btn-later').textContent = 'Close';
        }, 1200);
      });
      G('star-btn-later').addEventListener('click', function() {
        fetch('/api/star/later', { method: 'POST' }).catch(function(){});
        close();
      });
      modal.addEventListener('click', function(e) {
        if (e.target === modal) {
          fetch('/api/star/later', { method: 'POST' }).catch(function(){});
          close();
        }
      });

      // Initial delay so boot overlay clears, then wait for any open modal to close
      setTimeout(function() {
        fetch('/api/star').then(function(r) { return r.json(); }).then(function(d) {
          if (d && d.show) tryShow();
        }).catch(function(){});
      }, 2800);
    })();
    // ── end GitHub Star prompt ──────────────────────────────────────────────

    fetch('/api/settings').then(function(r){return r.json();}).then(function(s){
      _schedCache = (s && s.scheduler) ? Object.assign({}, s.scheduler, { nextRunAt: s.schedulerNextRunAt }) : null;
      updateNextRun();
    }).catch(function(){});
    setInterval(updateNextRun, 30000);
    initLicOverlay();
    refreshAccountStorage().catch(function(){});
    syncDesktopInstallStatus().catch(function(){});
    setInterval(function(){ syncDesktopInstallStatus().catch(function(){}); }, 30000);
    setInterval(refresh, 900);
    refresh();


    // ── Feedback / review prompt (Core users only) ──────────────────────
    // Smart timing so we never nag:
    //  - only Core (premium) users are ever asked;
    //  - first ask only after a bit of real usage (>= MIN_RUNS app opens);
    //  - we prefer "good moments" (a run that just finished with points);
    //  - after a skip we wait at least one month before asking again;
    //  - once a review is actually submitted, we never ask again.
    (function initFeedbackPrompt() {
      var MIN_RUNS = 3;
      var REASK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 1 month
      var STARTUP_DELAY_MS = 6000;

      function load() { try { return JSON.parse(localStorage.getItem('core_fb') || '{}'); } catch (e) { return {}; } }
      function save(st) { localStorage.setItem('core_fb', JSON.stringify(st)); }

      var st = load();
      // Migrate the legacy {done,runs} shape: done meant "asked once".
      if (st.done && typeof st.submitted === 'undefined') {
        st = { submitted: false, runs: st.runs || 0, asks: 1, lastAskAt: Date.now(), lastFinishedAt: null };
      }
      st.submitted = !!st.submitted;
      st.runs = st.runs || 0;
      st.asks = st.asks || 0;
      st.lastAskAt = st.lastAskAt || 0;
      st.lastFinishedAt = st.lastFinishedAt || null;
      st.runs++; // this app open is one usage signal
      save(st);

      var modalOpen = false;
      var selectedRating = 0;

      function isCoreUser() {
        return typeof _coreData !== 'undefined' && _coreData && _coreData.tier === 'premium';
      }
      function eligible() {
        if (st.submitted) return false;
        if (!isCoreUser()) return false;
        if (st.runs < MIN_RUNS) return false;
        if (st.asks > 0 && (Date.now() - st.lastAskAt) < REASK_COOLDOWN_MS) return false;
        return true;
      }
      
      function isAnyModalOpen() {
        return document.querySelectorAll('.modal-bg.open, .lic-overlay.open, .install-overlay.open').length > 0;
      }

      function openModal() {
        if (modalOpen || !eligible()) return false;
        if (isAnyModalOpen() && !G('fb-modal').classList.contains('open')) return false;
        if (G('fb-modal').classList.contains('open')) return false;
        modalOpen = true;
        selectedRating = 0;
        G('fb-btn-submit').disabled = true;
        document.querySelectorAll('.rating-star').forEach(function(ss) { ss.classList.remove('active'); });
        if (G('fb-comment')) G('fb-comment').value = '';
        st.asks++;
        st.lastAskAt = Date.now(); // starts the >= 1 month cooldown
        save(st);
        G('fb-modal').classList.add('open');
        return true;
      }

      // Bind the modal controls ONCE.
      document.querySelectorAll('.rating-star').forEach(function(s) {
        s.addEventListener('click', function() {
          selectedRating = parseInt(this.getAttribute('data-val'));
          document.querySelectorAll('.rating-star').forEach(function(ss) {
            ss.classList.toggle('active', parseInt(ss.getAttribute('data-val')) <= selectedRating);
          });
          G('fb-btn-submit').disabled = false;
        });
      });

      G('fb-btn-skip').addEventListener('click', function() {
        // Skip = ask again later. Cooldown was already set when the modal opened.
        modalOpen = false;
        modalOpen = false;
        G('fb-modal').classList.remove('open');
      });
      
      if (G('core-manual-rate')) {
        G('core-manual-rate').addEventListener('click', function() {
          if (isAnyModalOpen() && !G('fb-modal').classList.contains('open')) return;
          modalOpen = true;
          selectedRating = 0;
          G('fb-btn-submit').disabled = true;
          document.querySelectorAll('.rating-star').forEach(function(ss) { ss.classList.remove('active'); });
          if (G('fb-comment')) G('fb-comment').value = '';
          G('fb-modal').classList.add('open');
        });
      }

      G('fb-btn-submit').addEventListener('click', function() {
        if (!selectedRating) return;
        st.submitted = true; // submitted a review -> never ask again
        save(st);
        modalOpen = false;
        G('fb-modal').classList.remove('open');
        fetch('https://bot.lgtw.tf/api/bot/inbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'rating', rating: selectedRating, comment: G('fb-comment').value, hasCore: isCoreUser() })
        }).then(function(res) {
          return res.json().catch(function() { return { error: 'Connection or server error.' }; }).then(function(data) {
            if (!res.ok) throw new Error(data.error || 'Failed to submit feedback');
            showFeedbackToast(false);
          });
        }).catch(function(err) { showFeedbackToast(true, err.message); });
      });

      // Driver: catch a freshly finished successful run (best moment to ask),
      // and otherwise fall back to one ask per session once eligible.
      var sessionStart = Date.now();
      var fallbackDone = false;
      setInterval(function() {
        var d = window._lastStateData;
        if (d && !d.isRunning && d.finishedAt && d.finishedAt !== st.lastFinishedAt) {
          var ok = d.exitCode === 0;
          var pts = d.metrics && typeof d.metrics.points === 'number' ? d.metrics.points : 0;
          st.lastFinishedAt = d.finishedAt;
          save(st);
          if (ok && pts > 0) { openModal(); return; }
        }
        // Fallback ask once eligible. Only "burn" the session fallback when the
        // modal actually opened — otherwise (premium license still loading, not
        // enough runs yet, cooldown active) keep checking so it can still appear
        // later this session instead of being permanently skipped.
        if (!fallbackDone && (Date.now() - sessionStart) > STARTUP_DELAY_MS && !(d && d.isRunning)) {
          if (openModal()) fallbackDone = true;
        }
      }, 2000);
    })();

    // General Comment Logic
    G('btn-general-feedback').addEventListener('click', function(e) {
      e.preventDefault();
      G('comment-modal').classList.add('open');
    });

    G('comment-btn-cancel').addEventListener('click', function() {
      G('comment-modal').classList.remove('open');
    });

    G('comment-btn-submit').addEventListener('click', function() {
      var comment = G('general-comment').value.trim();
      if (!comment) return;
      G('comment-modal').classList.remove('open');
      G('general-comment').value = '';
      var isCore = typeof _coreData !== 'undefined' && _coreData && _coreData.tier === 'premium';
      fetch('https://bot.lgtw.tf/api/bot/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'comment', comment: comment, hasCore: isCore })
      }).then(function(res) {
        return res.json().catch(function(){ return { error: 'Connection or server error.' }; }).then(function(data) {
          if (!res.ok) throw new Error(data.error || 'Failed to submit feedback');
          showFeedbackToast(false);
        });
      }).catch(function(err) {
        showFeedbackToast(true, err.message);
      });
    });

    var _fbToastTimer = null;
    function showFeedbackToast(isError, msg) {
      var toast = G('feedback-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'feedback-toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
      }
      toast.classList.toggle('error', !!isError);
      if (isError) {
        toast.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff4b6e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> ' + esc(msg || 'Error sending feedback.');
      } else {
        toast.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Feedback sent successfully!';
      }
      toast.classList.add('show');
      clearTimeout(_fbToastTimer);
      _fbToastTimer = setTimeout(function() { toast.classList.remove('show'); }, 4000);
    }
  </script>
  <div class="ctx-menu" id="ctx-menu">
    <div class="ctx-item" id="ctx-open-folder">
      <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      Open bot folder
    </div>
    <div class="ctx-sep ctx-acc-only" style="display:none"></div>
    <div class="ctx-item ctx-acc-only" id="ctx-acc-edit" style="display:none">
      <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit account
    </div>
    <div class="ctx-item ctx-acc-only" id="ctx-acc-toggle" style="display:none">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      <span id="ctx-acc-toggle-label">Enable / Disable</span>
    </div>
    <div class="ctx-sep ctx-acc-only" style="display:none"></div>
    <div class="ctx-item ctx-acc-only" id="ctx-acc-copy" style="display:none">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy email
    </div>
    <div class="ctx-sep ctx-acc-only" style="display:none"></div>
    <div class="ctx-item ctx-item-danger ctx-acc-only" id="ctx-acc-delete" style="display:none">
      <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      Delete account
    </div>
  </div>
</body>
</html>`
}

// Hosts the localhost API gate accepts. Loopback always; the machine's LAN
// address too when LAN access is enabled (so another device in the house can use
// the Desk). A mismatched host/origin is still rejected — see http.js.
function deskAllowedHosts() {
    const address = server.address()
    if (!address || typeof address !== 'object') return []
    const port = address.port
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
    if (deskLanEnabled && deskLanIp) hosts.push(`${deskLanIp}:${port}`)
    return hosts
}

// Opt this local server in to being embedded/probed by the remote Nexus dashboard
// (an HTTPS page). Without CORS + the Private-Network-Access header, the browser
// blocks a public site from reaching loopback/LAN.
function applyDeskEmbedHeaders(req, res) {
    const origin = req.headers.origin
    if (origin && DESK_EMBED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

// Localhost HTTP utilities extracted to ./desk/http.js (behavior identical; the
// security gate + body limit are covered by tests/desk-behavior.test.js).
const { createHttp } = require('./http')
const { jsonResponse, safeEqual, authorizeApiRequest, readApiBody, parseJson } = createHttp({
    getAllowedHosts: deskAllowedHosts,
    apiToken: API_TOKEN,
    maxBodyBytes: MAX_API_BODY_BYTES
})

// Proxy helpers extracted to ./desk/proxy.js (behavior identical).
const { testProxy } = require('./proxy')

// Cross-process control file: the desk touches it to ask the running bot to
// bring its off-screen ("headless" on desktop) browser window on-screen. The
// bot child watches the same path (see BrowserManager.SHOW_BROWSER_SIGNAL).
const SHOW_BROWSER_SIGNAL = path.join(os.tmpdir(), 'msrb-show-browser.signal')

const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url, 'http://127.0.0.1').pathname
    // CORS + Private-Network-Access preflight for the Nexus embed/probe. Handled
    // before the /api gate so a cross-origin OPTIONS is never 403'd for lacking a token.
    if (req.method === 'OPTIONS') {
        applyDeskEmbedHeaders(req, res)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'x-msrb-token, content-type')
        res.setHeader('Access-Control-Max-Age', '600')
        res.writeHead(204)
        res.end()
        return
    }
    // Ungated reachability probe: lets the remote dashboard detect a local Desk on
    // this machine and learn the LAN URL. Returns only public, non-sensitive coords.
    if (req.method === 'GET' && requestPath === '/__desk_ping') {
        applyDeskEmbedHeaders(req, res)
        jsonResponse(res, 200, {
            desk: true,
            version: readVersion(),
            port: deskBoundPort,
            lanUrl: deskLanUrl,
            lanEnabled: deskLanEnabled
        })
        return
    }
    if (requestPath.startsWith('/api/') && !authorizeApiRequest(req, res)) return
    if (req.method === 'GET' && req.url === '/') {
        applyDeskEmbedHeaders(req, res)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html())
        return
    }
    if (req.method === 'GET' && req.url === '/app-icon.png') {
        serveAppIcon(res)
        return
    }
    if (req.method === 'GET' && req.url === '/banner-core.png') {
        serveStaticImage(res, APP_BANNER_PATH)
        return
    }
    if (req.method === 'GET' && req.url === '/core.png') {
        serveStaticImage(res, path.join(ROOT, 'assets', 'core.png'))
        return
    }
    if (req.method === 'GET' && req.url === '/star.gif') {
        serveStaticGif(res, path.join(ROOT, 'assets', 'star.gif'))
        return
    }
    if (req.method === 'GET' && req.url === '/favicon.ico') {
        serveAppIcon(res)
        return
    }
    if (req.method === 'GET' && req.url === '/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/manifest+json' })
        res.end(
            JSON.stringify({
                name: APP_TITLE,
                short_name: APP_TITLE,
                display: 'standalone',
                background_color: '#040912',
                theme_color: '#071425',
                icons: [
                    { src: '/app-icon.png', sizes: '192x192', type: 'image/x-icon', purpose: 'any' },
                    { src: '/app-icon.png', sizes: '256x256', type: 'image/x-icon', purpose: 'any' },
                    { src: '/app-icon.png', sizes: '512x512', type: 'image/x-icon', purpose: 'any maskable' }
                ]
            })
        )
        return
    }
    if (req.method === 'GET' && req.url === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const gs = readBotStats()
        res.end(
            JSON.stringify({
                ...state,
                accounts: accountsWithAvatarId(),
                corePluginEnabled: isPluginEnabled('core'),
                claimedPoints: gs.claimedPoints,
                accountPointsMap: cachedAccountPointsMap()
            })
        )
        return
    }
    if (req.method === 'POST' && req.url === '/api/clear-logs') {
        state.consoleLogs = []
        state.logs = []
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method === 'GET' && req.url === '/api/license') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...state.deskLicense, coreEnabled: isPluginEnabled('core') }))
        return
    }
    if (req.method === 'POST' && req.url === '/api/license/activate') {
        readApiBody(req, res, async body => {
            try {
                const parsed = parseJson(body, {})
                const result = await runCoreLicenseWorker({ action: 'activate', key: parsed.key || '' })
                if (result.success) {
                    setPluginEnabled('core', true)
                    state.deskLicense.tier = 'premium'
                    state.deskLicense.planType = result.planType
                    state.deskLicense.expiresAt = result.expiresAt
                    state.deskLicense.clientReady = true
                    state.deskLicense.loading = false
                    state.hasLicenseCache = true
                    if (state.licensePrompt.visible) sendInput(parsed.key || '')
                }
                jsonResponse(res, 200, result)
            } catch (error) {
                jsonResponse(res, 500, { success: false, message: error.message || 'Internal error.' })
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/license/skip') {
        try {
            setPluginEnabled('core', false)
            if (state.licensePrompt.visible) sendInput('')
            state.licensePrompt.visible = false
            state.licensePrompt.status = 'skipped'
            state.licensePrompt.message = 'Running without Core.'
            jsonResponse(res, 200, { success: true })
        } catch (error) {
            jsonResponse(res, 500, { success: false, message: error.message || 'Core could not be disabled.' })
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/license/deactivate') {
        readApiBody(req, res, async () => {
            try {
                const result = await runCoreLicenseWorker({ action: 'deactivate' })
                if (result.success) {
                    state.deskLicense.tier = 'free'
                    state.deskLicense.planType = ''
                    state.deskLicense.expiresAt = null
                    state.hasLicenseCache = false
                    try {
                        startupManager.setAgentEnabled(false)
                        writeConfigPatch({
                            backgroundAgent: { enabled: false, allowDashboardAutostart: false, openConsole: false },
                            core: { dashboardSync: false }
                        })
                    } catch (cleanupError) {
                        pushLog(
                            'warn',
                            `Core was deactivated, but startup cleanup needs attention: ${cleanupError.message}`
                        )
                        result.message += ' Automatic startup cleanup could not be completed.'
                    }
                }
                jsonResponse(res, result.success ? 200 : 503, result)
            } catch (error) {
                jsonResponse(res, 500, { success: false, message: error.message || 'Internal error.' })
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/start') {
        Promise.resolve(startBot())
            .then(started => {
                res.writeHead(started ? 204 : 409)
                res.end()
            })
            .catch(error => jsonResponse(res, 500, { error: error.message || 'The bot could not be started.' }))
        return
    }
    if (req.method === 'POST' && req.url === '/api/stop') {
        Promise.resolve(stopBot()).then(stopped => {
            res.writeHead(stopped ? 204 : 409)
            res.end()
        })
        return
    }
    // ── GitHub Star routes ────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/star') {
        const st = readStarState()
        const show = !st.done && (st.shows || 0) < STAR_MAX_SHOWS
        jsonResponse(res, 200, { show })
        if (show) saveStarState({ ...st, shows: (st.shows || 0) + 1 })
        return
    }
    if (req.method === 'POST' && req.url === '/api/star/done') {
        saveStarState({ done: true, shows: STAR_MAX_SHOWS })
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method === 'POST' && req.url === '/api/star/later') {
        const st = readStarState()
        saveStarState({ ...st, shows: st.shows || 0 })
        res.writeHead(204)
        res.end()
        return
    }
    // ── end GitHub Star routes ────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/show-browser') {
        // Signal the running bot to reveal its off-screen browser window. The
        // signal is harmless if the run is truly headless (Docker) — nothing to
        // reveal — so we always answer 204.
        try {
            fs.writeFileSync(SHOW_BROWSER_SIGNAL, String(Date.now()))
        } catch (error) {
            pushLog('warn', `Could not signal Show browser: ${error.message}`)
        }
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method === 'POST' && req.url === '/api/open-url') {
        readApiBody(req, res, body => {
            try {
                const data = JSON.parse(body)
                if (data.url) openDefaultBrowser(data.url)
            } catch {}
            res.writeHead(204)
            res.end()
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/close') {
        scheduleShutdown()
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method === 'POST' && req.url === '/api/alive') {
        // A page (re)loaded — cancel a shutdown a just-fired refresh may have scheduled.
        cancelShutdown()
        res.writeHead(204)
        res.end()
        return
    }

    if (req.method === 'POST' && req.url === '/api/open-accounts') {
        res.writeHead(openAccountsFile() ? 204 : 404)
        res.end()
        return
    }
    if (req.method === 'GET' && req.url === '/api/accounts-raw') {
        if (Array.isArray(accountCache)) {
            jsonResponse(res, 200, enrichAccountsWithVariant(accountCache))
            return
        }
        accountStorageRequest('read')
            .then(result => {
                accountCache = Array.isArray(result.accounts) ? result.accounts : []
                jsonResponse(res, 200, enrichAccountsWithVariant(accountCache))
            })
            .catch(error => jsonResponse(res, 500, { error: error.message }))
        return
    }
    if (req.method === 'GET' && req.url.startsWith('/avatars/')) {
        const input = decodeURIComponent(req.url.split('/avatars/')[1] || '')
        // Accept a pre-computed 16-char hex hash directly (the account avatarId)
        // so the masked Home list can load avatars without reversing the email.
        const hash = /^[0-9a-f]{16}$/.test(input)
            ? input
            : require('crypto').createHash('sha256').update(input.toLowerCase().trim()).digest('hex').substring(0, 16)
        const avatarPath = path.join(ROOT, 'data', 'avatars', `${hash}.jpg`)
        if (fs.existsSync(avatarPath)) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' })
            fs.createReadStream(avatarPath).pipe(res)
        } else {
            const fallback = isPluginEnabled('core')
                ? path.join(ROOT, 'assets', 'core.png')
                : path.join(ROOT, 'assets', 'logo.png')
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store, no-cache, must-revalidate' })
            fs.createReadStream(fallback).pipe(res)
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/accounts-save') {
        readApiBody(req, res, async body => {
            const accounts = parseJson(body, null)
            if (!Array.isArray(accounts)) {
                res.writeHead(400)
                res.end('Invalid')
                return
            }
            // Strip the transient Desk-only enrichment so it never lands in the store.
            accounts.forEach(a => {
                if (a && typeof a === 'object') delete a.lastDetectedVariant
            })
            try {
                const result = await accountStorageRequest('write', { accounts })
                state.accounts = Array.isArray(result.masked) ? result.masked : []
                accountCache = Array.isArray(result.accounts) ? result.accounts : accounts
                res.writeHead(204)
                res.end()
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'GET' && req.url === '/api/settings') {
        const cfg = readConfigRaw()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
            JSON.stringify({
                workers: cfg.workers || {},
                headless: cfg.headless,
                runOnZeroPoints: cfg.runOnZeroPoints,
                debugLogs: cfg.debugLogs,
                searchOnBingLocalQueries: cfg.searchOnBingLocalQueries,
                globalTimeout: cfg.globalTimeout,
                searchSettings: cfg.searchSettings || {},
                analytics: cfg.analytics,
                updateNotifier: cfg.updateNotifier || {},
                terminal: cfg.terminal || { enabled: false },
                // Computed server-side (real Intl timezone math against scheduler.timezone) so
                // the Desk countdown reflects the CONFIGURED timezone instead of whatever
                // timezone the browser viewing the Desk happens to be in — which matters as
                // soon as Desk is viewed remotely (e.g. a VPS bot in a different zone from you).
                schedulerNextRunAt: computeSchedulerNextRunAt(cfg.scheduler),
                scheduler: cfg.scheduler || {},
                core: cfg.core || {},
                backgroundAgent: cfg.backgroundAgent || {},
                webhook: cfg.webhook || {},
                hasCoreLicense: state.deskLicense.tier === 'premium',
                // Live Desk network coordinates (source of truth = what's actually bound,
                // not just the stored config). The toggle writes desk.lanAccess; the bound
                // value only changes after a restart.
                deskLanAccess: deskLanEnabled,
                deskLanUrl,
                deskPort: deskBoundPort,
                deskRemoteAccess: (cfg.core && cfg.core.dashboardSync === true) || false,
                deskHeadless: (cfg.desk && cfg.desk.headless === true) || false
            })
        )
        return
    }
    if (req.method === 'GET' && req.url === '/api/stats') {
        jsonResponse(res, 200, readBotStats())
        return
    }
    if (req.method === 'GET' && req.url === '/api/insights') {
        jsonResponse(res, 200, Object.assign(buildInsights(), { hasCoreLicense: state.deskLicense.tier === 'premium' }))
        return
    }
    if (req.method === 'GET' && req.url === '/api/startup') {
        jsonResponse(res, 200, startupManager.status())
        return
    }
    if (req.method === 'POST' && req.url === '/api/startup') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || data.mode !== 'desk' || typeof data.enable !== 'boolean') {
                jsonResponse(res, 400, { error: 'Invalid startup request' })
                return
            }
            try {
                // Only the Desk autostart is managed here now; remote access is the
                // Desk→agent lifecycle (see /api/remote-access), not a separate service.
                startupManager.setDeskEnabled(data.enable)
                jsonResponse(res, 200, startupManager.status())
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/remote-access') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.enable !== 'boolean') {
                jsonResponse(res, 400, { error: 'Invalid request' })
                return
            }
            if (data.enable && state.deskLicense.tier !== 'premium') {
                jsonResponse(res, 403, { error: 'An active Core license is required for remote access.' })
                return
            }
            try {
                writeConfigPatch({ core: { dashboardSync: data.enable } })
                if (data.enable) void startAgentProcess()
                else void stopAgentProcess()
                jsonResponse(res, 200, { enabled: data.enable })
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/settings') {
        readApiBody(req, res, body => {
            const patch = parseJson(body, null)
            if (!patch || typeof patch !== 'object') {
                res.writeHead(400)
                res.end()
                return
            }
            try {
                writeConfigPatch(patch)
                deskAnalytics.trackSettingsPatch(patch)
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(500)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/reset-config') {
        const _https = require('https')
        const _cfgUrl =
            'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/refs/heads/main/src/config.example.json'
        _https
            .get(_cfgUrl, function (r) {
                let _raw = ''
                r.on('data', function (c) {
                    _raw += c
                })
                r.on('end', function () {
                    try {
                        const obj = JSON.parse(_raw)
                        const cfgSrc = path.join(ROOT, 'config.json')
                        const cfgDist = path.join(ROOT, 'dist', 'config.json')
                        fs.writeFileSync(cfgSrc, JSON.stringify(obj, null, 4), 'utf8')
                        if (fs.existsSync(cfgDist)) fs.writeFileSync(cfgDist, JSON.stringify(obj, null, 4), 'utf8')
                        res.writeHead(200, { 'content-type': 'application/json' })
                        res.end(JSON.stringify({ ok: true }))
                    } catch (e) {
                        res.writeHead(500)
                        res.end(String(e.message))
                    }
                })
            })
            .on('error', function (e) {
                res.writeHead(502)
                res.end(String(e.message))
            })
        return
    }
    if (req.method === 'POST' && req.url === '/api/open-discord') {
        openDiscord()
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method === 'GET' && req.url === '/api/desktop-install') {
        jsonResponse(res, 200, desktopInstallManager.status())
        return
    }
    if (req.method === 'POST' && req.url === '/api/desktop-install') {
        readApiBody(req, res, body => {
            try {
                const data = parseJson(body, {})
                if (data.action === 'install') {
                    jsonResponse(res, 200, desktopInstallManager.install())
                    return
                }
                if (data.action === 'uninstall') {
                    jsonResponse(res, 200, desktopInstallManager.uninstall())
                    return
                }
                jsonResponse(res, 400, { error: 'Unknown desktop installation action' })
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'GET' && req.url === '/api/account-storage') {
        accountStorageRequest('status')
            .then(result => jsonResponse(res, 200, { ...result, disableConfirmation: os.userInfo().username }))
            .catch(error => jsonResponse(res, 500, { error: error.message }))
        return
    }
    if (req.method === 'POST' && req.url === '/api/account-storage') {
        readApiBody(req, res, async body => {
            try {
                const data = parseJson(body, {})
                if (!['enable', 'disable', 'rotate', 'export', 'import'].includes(data.action)) {
                    jsonResponse(res, 400, { error: 'Unknown storage action' })
                    return
                }
                const result = await accountStorageRequest(data.action, data)
                if (Array.isArray(result.masked)) state.accounts = result.masked
                if (Array.isArray(result.accounts)) accountCache = result.accounts
                jsonResponse(res, 200, result)
            } catch (error) {
                jsonResponse(res, 400, { error: error.message })
            }
        })
        return
    }
    if (
        req.method === 'GET' &&
        (req.url === '/api/marketplace-catalog' || req.url.startsWith('/api/marketplace-catalog?'))
    ) {
        const catalogPath = path.join(ROOT, 'plugins', 'marketplace.json')
        const forceRefresh = req.url.includes('refresh=1')
        let catalog = null
        if (!forceRefresh) {
            try {
                catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
            } catch {}
        }
        if (catalog) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ catalog, source: 'disk' }))
            return
        }
        // Default to the production catalog endpoint so the marketplace works out of the
        // box; override with MSRB_MARKETPLACE_CATALOG_URL for local/staging testing.
        const catalogUrl = process.env.MSRB_MARKETPLACE_CATALOG_URL || 'https://bot.lgtw.tf/api/marketplace/catalog'
        const { fetchSignedCatalog } = require('../plugins/marketplace-fetch')
        fetchSignedCatalog(catalogUrl)
            .then(function (result) {
                let parsed = null
                try {
                    parsed = JSON.parse(result.catalog)
                } catch {}
                // Cache the catalog ONLY with its signature: the bot's verifier is fail-closed,
                // so a marketplace.json without a matching marketplace.sig is rejected as
                // 'absent' and the plugins are skipped. Write both atomically, or neither.
                if (parsed && result.signature) {
                    try {
                        fs.mkdirSync(path.join(ROOT, 'plugins'), { recursive: true })
                        fs.writeFileSync(catalogPath, result.catalog, 'utf8')
                        fs.writeFileSync(
                            path.join(ROOT, 'plugins', 'marketplace.sig'),
                            String(result.signature).trim() + '\n',
                            'utf8'
                        )
                    } catch {}
                }
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ catalog: parsed, source: parsed ? 'live' : 'none' }))
            })
            .catch(function (e) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ catalog: null, source: 'none', error: e.message }))
            })
        return
    }
    if (req.method === 'GET' && req.url === '/api/plugins') {
        const list = readPluginsList()
        // Surface plugins that exist ON DISK but have no plugins.jsonc entry (dropped in
        // manually, or left behind by a failed removal). They don't load — with a config
        // file present only listed plugins do — but the user must still see and remove
        // them. Mark them "unmanaged" so the UI shows a remove action without a toggle.
        try {
            const known = new Set(list.map(p => p.name))
            for (const name of listInstalledFolders()) {
                if (known.has(name)) continue
                list.push({
                    name,
                    enabled: false,
                    priority: 0,
                    source: 'local',
                    version: '',
                    autoUpdate: false,
                    trust: '',
                    official: false,
                    unmanaged: true,
                    description: 'Present on disk but not listed in plugins.jsonc — it will not load. Remove it or add it to your config.'
                })
            }
        } catch {}
        // Enrich each plugin with its on-disk installed version (.installed.json) for
        // accurate "update available", and a "may be outdated" flag when this bot has
        // moved well ahead of the bot version the plugin was published for.
        let mpcat = null
        try {
            mpcat = require('../security/marketplace-catalog')
        } catch {}
        const staleWindow = Number(process.env.MSRB_PLUGIN_STALE_WINDOW) || undefined
        for (const p of list) {
            try {
                const marker = JSON.parse(
                    fs.readFileSync(path.join(ROOT, 'plugins', p.name, '.installed.json'), 'utf8')
                )
                if (marker && typeof marker.version === 'string') p.installedVersion = marker.version
                if (
                    marker &&
                    marker.publishedBotVersion &&
                    mpcat &&
                    mpcat.isPluginStale(marker.publishedBotVersion, APP_VERSION, staleWindow)
                ) {
                    p.stale = true
                }
            } catch {}
            // Phase 2 capabilities: the declared settings schema (so the Desk can render a
            // form), the resolved current values, and the last panel snapshot the plugin
            // pushed. All read from the shared store — no plugin code runs here.
            if (pluginDataStore) {
                try {
                    const manifest = pluginDataStore.readManifest(ROOT, p.name)
                    if (manifest.permissions && manifest.permissions.length) {
                        p.permissions = manifest.permissions
                        // Elevated (net:*) permissions need explicit user consent — surface
                        // each with its current grant state so the Desk can show a toggle.
                        const grants = pluginDataStore.readGrants(ROOT, p.name)
                        const elevated = manifest.permissions
                            .filter(perm => typeof perm === 'string' && perm.toLowerCase().startsWith('net:'))
                            .map(perm => ({ permission: perm, host: perm.slice(4), granted: grants[perm] === true }))
                        if (elevated.length) p.elevatedPermissions = elevated
                    }
                    if (manifest.settings && manifest.settings.length) {
                        p.settings = manifest.settings
                        const entry = readPluginsConfig()[p.name]
                        const cfg = entry && typeof entry.config === 'object' ? entry.config : {}
                        p.settingsValues = pluginDataStore.resolveSettings(ROOT, p.name, cfg)
                    }
                    const panel = pluginDataStore.readPanel(ROOT, p.name)
                    if (panel) p.panel = panel
                } catch {}
            }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ plugins: list, hasCoreLicense: state.deskLicense.tier === 'premium' }))
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string') {
                res.writeHead(400)
                res.end()
                return
            }
            try {
                if (typeof data.enabled === 'boolean') setPluginEnabled(data.name, data.enabled)
                else if (data.trust === 'full' || data.trust === 'sandbox') setPluginTrust(data.name, data.trust)
                else if (typeof data.autoUpdate === 'boolean') setPluginAutoUpdate(data.name, data.autoUpdate)
                else {
                    res.writeHead(400)
                    res.end()
                    return
                }
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(500)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/install') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string' || typeof data.version !== 'string') {
                res.writeHead(400)
                res.end('Missing name or version')
                return
            }
            try {
                addMarketplacePlugin(data.name, data.version)
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/update') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string' || typeof data.version !== 'string') {
                res.writeHead(400)
                res.end('Missing name or version')
                return
            }
            try {
                setPluginVersion(data.name, data.version)
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/remove') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string') {
                res.writeHead(400)
                res.end('Missing name')
                return
            }
            if (data.name === 'core') {
                res.writeHead(400)
                res.end('Core cannot be removed')
                return
            }
            if (!/^[a-z0-9][a-z0-9._-]{0,48}$/i.test(data.name)) {
                res.writeHead(400)
                res.end('Invalid plugin name')
                return
            }
            try {
                // Strip the plugins.jsonc entry if there is one (tolerant: a folder-only
                // "unmanaged" plugin has no entry — removePlugin returns false, not throw).
                const removedEntry = removePlugin(data.name)
                // Delete the on-disk plugin folder (guarded against path escape). This is
                // what actually removes an unmanaged plugin, so it must always run.
                let removedFolder = false
                try {
                    const pluginsDir = path.join(ROOT, 'plugins')
                    const dir = path.join(pluginsDir, data.name)
                    if (dir.startsWith(pluginsDir + path.sep) && fs.existsSync(dir)) {
                        fs.rmSync(dir, { recursive: true, force: true })
                        removedFolder = true
                    }
                } catch {}
                // Also drop the plugin's runtime data (storage/panel/settings).
                try { if (pluginDataStore) pluginDataStore.clearData(ROOT, data.name) } catch {}
                if (!removedEntry && !removedFolder) {
                    res.writeHead(404)
                    res.end('Plugin not found: ' + data.name)
                    return
                }
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/settings') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string' || !data.values || typeof data.values !== 'object') {
                res.writeHead(400)
                res.end('Missing name or values')
                return
            }
            if (!/^[a-z0-9][a-z0-9._-]{0,48}$/i.test(data.name)) {
                res.writeHead(400)
                res.end('Invalid plugin name')
                return
            }
            if (!pluginDataStore) {
                res.writeHead(503)
                res.end('Plugin settings unavailable')
                return
            }
            try {
                // writeSettingsValues coerces to the declared schema and ignores unknown keys.
                pluginDataStore.writeSettingsValues(ROOT, data.name, data.values)
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/grant') {
        readApiBody(req, res, body => {
            const data = parseJson(body, null)
            if (!data || typeof data.name !== 'string' || typeof data.permission !== 'string' || typeof data.granted !== 'boolean') {
                res.writeHead(400)
                res.end('Missing name, permission or granted')
                return
            }
            if (!/^[a-z0-9][a-z0-9._-]{0,48}$/i.test(data.name)) {
                res.writeHead(400)
                res.end('Invalid plugin name')
                return
            }
            // Only elevated permissions are consent-gated; today that means net:<host>.
            if (!/^net:[a-z0-9.-]{1,253}$/i.test(data.permission)) {
                res.writeHead(400)
                res.end('Unsupported permission')
                return
            }
            if (!pluginDataStore) {
                res.writeHead(503)
                res.end('Plugin permissions unavailable')
                return
            }
            try {
                pluginDataStore.writeGrant(ROOT, data.name, data.permission, data.granted)
                res.writeHead(204)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/open-folder') {
        try {
            const _cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
            childProcess.spawn(_cmd, [ROOT], { detached: true, stdio: 'ignore' }).unref()
            res.writeHead(204)
            res.end()
        } catch (e) {
            res.writeHead(500)
            res.end(String(e.message))
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/open-portal') {
        try {
            openAppWindow('https://bot.lgtw.tf/?view=developers', { profileSuffix: 'portal' })
            res.writeHead(204)
            res.end()
        } catch (e) {
            res.writeHead(500)
            res.end(String(e.message))
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/plugins/report') {
        readApiBody(req, res, async body => {
            const data = parseJson(body, null)
            if (
                !data ||
                typeof data.name !== 'string' ||
                typeof data.reason !== 'string' ||
                data.reason.trim().length < 3
            ) {
                res.writeHead(400)
                res.end('Missing name or reason')
                return
            }
            // Forward to core-api server-to-server (no browser CORS). The report URL is
            // derived from the configured catalog URL (.../catalog -> .../report).
            const catalogUrl = process.env.MSRB_MARKETPLACE_CATALOG_URL
            if (!catalogUrl) {
                res.writeHead(503)
                res.end('Marketplace not configured')
                return
            }
            const reportUrl = catalogUrl.replace(/\/catalog(\?.*)?$/, '/report')
            try {
                const r = await fetch(reportUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        name: data.name,
                        version: data.version,
                        reason: String(data.reason).slice(0, 500)
                    })
                })
                if (r.ok) {
                    res.writeHead(204)
                    res.end()
                } else {
                    res.writeHead(r.status)
                    res.end((await r.text()).slice(0, 300))
                }
            } catch (e) {
                res.writeHead(502)
                res.end(String(e.message))
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/terminal-mode') {
        try {
            writeConfigPatch({ terminal: { enabled: true } })
            launchTerminalMode()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            scheduleShutdown()
        } catch (e) {
            res.writeHead(500)
            res.end(String(e.message))
        }
        return
    }
    if (req.method === 'GET' && req.url === '/api/whats-new') {
        childProcess.exec('git log --oneline --no-merges -30', { cwd: ROOT, timeout: 5000 }, (err, stdout) => {
            if (err || !stdout) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ commits: [] }))
                return
            }
            const commits = stdout
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(line => {
                    const sp = line.indexOf(' ')
                    return { hash: sp > 0 ? line.slice(0, sp) : line, message: sp > 0 ? line.slice(sp + 1).trim() : '' }
                })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ commits }))
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/clear-sessions') {
        try {
            const sessionPath = readConfigRaw().sessionPath || 'sessions'
            const sessionDir = path.resolve(ROOT, sessionPath)
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true })
            }
            jsonResponse(res, 200, { ok: true })
        } catch (e) {
            jsonResponse(res, 500, { error: e.message })
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/clear-data') {
        try {
            const dataDir = path.join(ROOT, 'data')
            if (fs.existsSync(dataDir)) {
                fs.rmSync(dataDir, { recursive: true, force: true })
            }
            jsonResponse(res, 200, { ok: true })
        } catch (e) {
            jsonResponse(res, 500, { error: e.message })
        }
        return
    }
    if (req.method === 'POST' && req.url === '/api/test-single-proxy') {
        if (state.deskLicense.tier !== 'premium') {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Proxy testing is a Core Premium advantage.' }))
            return
        }
        readApiBody(req, res, async body => {
            try {
                const proxyConfig = parseJson(body, {})
                if (!proxyConfig || !proxyConfig.url) {
                    jsonResponse(res, 400, { error: 'Missing proxy URL' })
                    return
                }
                const result = await testProxy(proxyConfig)
                jsonResponse(res, 200, result)
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/test-proxies') {
        if (state.deskLicense.tier !== 'premium') {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Proxy testing is a Core Premium advantage.' }))
            return
        }
        readApiBody(req, res, async body => {
            try {
                const data = parseJson(body, {})
                const targetIndex = typeof data.index === 'number' ? data.index : -1

                const storageResult = await accountStorageRequest('read')
                const accounts = Array.isArray(storageResult.accounts) ? storageResult.accounts : []

                const results = {}
                const tasks = []

                if (targetIndex >= 0 && targetIndex < accounts.length) {
                    const a = accounts[targetIndex]
                    if (a.proxy && a.proxy.url) {
                        tasks.push(
                            (async () => {
                                results[a.email] = await testProxy(a.proxy)
                            })()
                        )
                    }
                } else {
                    accounts.forEach(a => {
                        if (a.proxy && a.proxy.url) {
                            tasks.push(
                                (async () => {
                                    results[a.email] = await testProxy(a.proxy)
                                })()
                            )
                        }
                    })
                }

                await Promise.all(tasks)
                jsonResponse(res, 200, { results })
            } catch (error) {
                jsonResponse(res, 500, { error: error.message })
            }
        })
        return
    }
    if (req.method === 'GET' && req.url.startsWith('/api/docs')) {
        const u = new URL(req.url, 'http://localhost')
        const file = u.searchParams.get('file')
        if (file) {
            const content = readDocFile(file)
            if (content === null) {
                res.writeHead(404)
                res.end('Not found')
                return
            }
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
            res.end(content)
        } else {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(listDocs()))
        }
        return
    }
    res.writeHead(404)
    res.end('Not found')
})

startDeskServer()

function startDeskServer() {
    const deskCfg = (readConfigRaw() || {}).desk || {}
    // LAN access: env override (tests force loopback with MSRB_DESK_LAN=0) wins, otherwise
    // config desk.lanAccess (default OFF — opt-in). The same-machine Nexus embed only needs
    // loopback, so LAN stays off unless you specifically want to reach the Desk from another
    // device (e.g. a phone). When ON we bind 0.0.0.0 (still covers loopback for the local
    // window); the first such launch may prompt the Windows Firewall to allow Node.
    const lanEnv = process.env.MSRB_DESK_LAN
    deskLanEnabled = lanEnv === '1' ? true : lanEnv === '0' ? false : deskCfg.lanAccess === true
    deskLanIp = deskLanEnabled ? getLanIPv4() : null
    const host = deskLanEnabled ? '0.0.0.0' : '127.0.0.1'

    // Rotating port by design: a fixed port is scriptable/bookmarkable; a random one
    // (OS-assigned, default) changes every launch and the Desk announces it to the server,
    // so discovery still works without ever exposing a stable address. An explicit
    // MSRB_APP_PORT (tests) or a pinned config desk.port still wins for those who want it.
    const explicit = process.env.MSRB_APP_PORT
    const hasExplicit = explicit != null && explicit !== ''
    const desired = hasExplicit ? Number.parseInt(explicit, 10) || 0 : Number.parseInt(deskCfg.port, 10) || 0
    listenWithFallback(host, desired, 0)
}

function listenWithFallback(host, port, attemptsLeft) {
    const onError = err => {
        server.removeListener('listening', onListening)
        if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            listenWithFallback(host, port + 1, attemptsLeft - 1)
        } else if (err && err.code === 'EADDRINUSE' && port !== 0) {
            listenWithFallback(host, 0, 0) // give up on the fixed range — let the OS choose
        } else {
            pushLog('error', `Desk server failed to listen: ${err && err.message ? err.message : err}`)
        }
    }
    const onListening = () => {
        server.removeListener('error', onError)
        finalizeDeskServer()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
}

function finalizeDeskServer() {
    const address = server.address()
    deskBoundPort = address && typeof address === 'object' ? address.port : null
    deskLanUrl = deskLanEnabled && deskLanIp && deskBoundPort ? `http://${deskLanIp}:${deskBoundPort}` : null
    const url = `http://127.0.0.1:${deskBoundPort}`
    if (deskLanUrl) pushLog('info', `Desk reachable on your network at ${deskLanUrl}`)
    if (process.env.MSRB_APP_NO_OPEN !== '1') openAppWindow(url)
    maybeAutoEnableDeskStartup()
    maybeAutoInstallDeskShortcuts()
    initializeDeskInBackground()
    void refreshAgentState()
    setInterval(() => void refreshAgentState(), 900)
    // Announce presence to Nexus (premium only; re-announced before the 90s server TTL).
    setTimeout(reportDeskPresence, 3000)
    setInterval(reportDeskPresence, 60_000)
}

// Browser launcher extracted to ./desk/browser-launcher.js (behavior identical).
const { createBrowserLauncher } = require('./browser-launcher')
const { openAppWindow } = createBrowserLauncher({
    windowWidth: APP_WINDOW_WIDTH,
    windowHeight: APP_WINDOW_HEIGHT,
    pushLog
})

// parseJson is provided by ./desk/http.js (destructured from createHttp above).

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
    if (shuttingDown) return
    shuttingDown = true

    // Best-effort session telemetry — fire-and-forget with its own short timeout;
    // the exit path below never waits on it.
    deskAnalytics.trackSessionEnd({ has_core: state.deskLicense.tier === 'premium' })

    // Desk closing = remote off (owner's model): force the background agent to exit too.
    // Synchronous force-kill (the Desk is exiting, no time for the IPC handshake).
    quickKillAgent()

    if (botProcess) {
        stopRequested = true
        const child = botProcess
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 2500)
        child.once('exit', () => {
            clearTimeout(forceKill)
            closeServerAndExit()
        })
        child.kill('SIGTERM')
        return
    }

    closeServerAndExit()
}

function scheduleShutdown() {
    if (shutdownTimer || shuttingDown) return
    // Grace period: a page *refresh* fires beforeunload (→ /api/close) then immediately
    // reloads and pings /api/alive, which cancels this. Only a real window close (no
    // reload, so no cancel) falls through to an actual shutdown.
    shutdownTimer = setTimeout(shutdown, 1500)
}

function cancelShutdown() {
    if (shutdownTimer) {
        clearTimeout(shutdownTimer)
        shutdownTimer = null
    }
}

function closeServerAndExit() {
    const exitTimer = setTimeout(() => process.exit(0), 1200)
    exitTimer.unref()
    server.close(() => process.exit(0))
}
