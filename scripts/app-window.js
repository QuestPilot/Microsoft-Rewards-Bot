const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number.parseInt(process.env.MSRB_APP_PORT || '0', 10)
const APP_TITLE = 'Rewards Desk'
const APP_ICON_PATH = path.join(ROOT, 'assets', 'logo.png')
const APP_BANNER_PATH = path.join(ROOT, 'assets', 'banner-core.png')
const APP_WINDOW_WIDTH = 1500
const APP_WINDOW_HEIGHT = 900

function readVersion() {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { return '4.0.x' }
}
const APP_VERSION = readVersion()

const state = {
    status: 'Ready',
    detail: 'Click "Run daily set now" to start',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    isRunning: false,
    accounts: readAccounts(),
    activeAccount: null,
    logs: [],
    consoleLogs: [],
    hasLicenseCache: false,
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
let pendingLicenseKey = ''

function readAccounts() {
    try {
        const accounts = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'accounts.json'), 'utf8'))
        if (!Array.isArray(accounts)) return []
        return accounts.map((account, index) => ({
            id: index + 1,
            email: maskEmail(account.email || `Account ${index + 1}`),
            enabled: account.enabled !== false,
            status: account.enabled === false ? 'Disabled' : 'Ready'
        }))
    } catch {
        return []
    }
}

function maskEmail(email) {
    const [name, domain] = String(email).split('@')
    if (!domain) return email
    const visible = name.length <= 2 ? name : `${name.slice(0, 2)}${'*'.repeat(Math.min(5, name.length - 2))}`
    return `${visible}@${domain}`
}

function pushLog(level, message) {
    const clean = String(message || '').replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!clean) return

    updateStateFromLine(clean)
    state.logs.push({ at: new Date().toISOString(), level, message: toFriendlyLog(clean) })
    state.consoleLogs.push({ at: new Date().toISOString(), level, message: clean })
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
    if (/Search counters unavailable/i.test(line)) return 'Microsoft dashboard counters are unavailable; using safe fallback.'
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
    } else if (/Invalid license key|License server not configured|Unable to reach the license server|Try again/i.test(line)) {
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

    const pointsMatch = line.match(/Total points collected:\s*\+?(-?\d+)/i) || line.match(/Points collected:\s*\+?(-?\d+)/i)
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

function startBot(licenseKey = pendingLicenseKey) {
    if (botProcess) return false
    stopRequested = false
    pendingLicenseKey = String(licenseKey || '').trim()
    state.status = 'Starting'
    state.detail = 'Preparing the run'
    state.startedAt = new Date().toISOString()
    state.finishedAt = null
    state.exitCode = null
    state.isRunning = true
    state.licensePrompt.visible = false
    state.licensePrompt.status = pendingLicenseKey ? 'checking' : 'skipped'
    state.licensePrompt.message = pendingLicenseKey ? 'Checking Core license...' : 'Starting without a Core license.'
    state.metrics.progress = 6
    pushLog('info', 'Starting Rewards Bot run.')

    botProcess = childProcess.spawn(process.execPath, ['./dist/index.js', '--ui-child'], {
        cwd: ROOT,
        env: {
            ...process.env,
            ...(pendingLicenseKey ? { LICENSE_KEY: pendingLicenseKey } : {}),
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
        state.status = 'Attention'
        state.detail = `Could not start the bot: ${error.message}`
        pushLog('warn', state.detail)
    })
    botProcess.on('exit', code => {
        botProcess = null
        state.isRunning = false
        state.exitCode = code
        state.finishedAt = new Date().toISOString()
        state.status = stopRequested ? 'Stopped' : code === 0 ? 'Complete' : 'Attention'
        state.detail = stopRequested ? 'Stopped by user' : code === 0 ? 'Run finished' : 'The bot stopped before completing'
        state.metrics.progress = code === 0 ? 100 : state.metrics.progress
    })
    return true
}

function stopBot() {
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

function hasCoreLicenseCache() {
    const candidates = []
    if (process.platform === 'win32' && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, '.msrb', 'license.dat'))
    candidates.push(path.join(os.homedir(), '.msrb', 'license.dat'))
    return candidates.some(candidate => fs.existsSync(candidate))
}

function readAccountsRaw() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'accounts.json'), 'utf8'))
        return Array.isArray(raw) ? raw : []
    } catch { return [] }
}

function writeAccountsRaw(accounts) {
    fs.writeFileSync(path.join(ROOT, 'src', 'accounts.json'), JSON.stringify(accounts, null, 4), 'utf8')
    state.accounts = readAccounts()
}

const CONFIG_SRC  = path.join(ROOT, 'src',  'config.json')
const CONFIG_DIST = path.join(ROOT, 'dist', 'config.json')

function readConfigRaw() {
    // Prefer dist/config.json — that's what the bot actually reads at runtime
    const file = fs.existsSync(CONFIG_DIST) ? CONFIG_DIST : CONFIG_SRC
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch { return {} }
}

function writeConfigPatch(patch) {
    const cfg = readConfigRaw()
    ;(function merge(t, s) {
        for (const [k, v] of Object.entries(s)) {
            if (v !== null && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') merge(t[k], v)
            else t[k] = v
        }
    })(cfg, patch)
    const json = JSON.stringify(cfg, null, 4)
    // Write to both so src and dist stay in sync
    fs.writeFileSync(CONFIG_SRC, json, 'utf8')
    if (fs.existsSync(CONFIG_DIST)) fs.writeFileSync(CONFIG_DIST, json, 'utf8')
}

function prepareInitialRun() {
    state.hasLicenseCache = hasCoreLicenseCache()
    state.status = 'Ready'
    state.detail = 'Click "Run daily set now" to start'
}

function openAccountsFile() {
    const accountsFile = path.join(ROOT, 'src', 'accounts.json')
    if (!fs.existsSync(accountsFile)) return false

    if (process.platform === 'win32') {
        childProcess.spawn('notepad.exe', [accountsFile], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
        return true
    }

    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    childProcess.spawn(opener, [accountsFile], { detached: true, stdio: 'ignore' }).unref()
    return true
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
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
    fs.createReadStream(filePath).pipe(res)
}

function serveAppIcon(res) { serveStaticImage(res, APP_ICON_PATH) }

function html() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_TITLE}</title>
<link rel="icon" type="image/png" href="/app-icon.png">
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
    }
    @keyframes appIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.75)}}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(30,155,255,0)}50%{box-shadow:0 0 24px 4px rgba(30,155,255,.18)}}
    button,input{font:inherit}
    ::-webkit-scrollbar{width:4px;height:4px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(30,155,255,.22);border-radius:99px}

    /* ── Sidebar ── */
    .sidebar{
      width:220px;flex-shrink:0;display:flex;flex-direction:column;
      padding:22px 14px;border-right:1px solid var(--border);
      background:linear-gradient(180deg,rgba(7,17,31,.97) 0%,rgba(3,8,15,.98) 100%);
    }
    .brand{display:flex;align-items:center;gap:11px;padding-bottom:20px;border-bottom:1px solid var(--border);margin-bottom:16px}
    .brand img{width:40px;height:40px;border-radius:12px;box-shadow:0 0 18px rgba(30,155,255,.32)}
    .brand-name{font-size:14px;font-weight:700;line-height:1.2}
    .brand-sub{font-size:11px;color:var(--muted);margin-top:1px}
    nav{display:flex;flex-direction:column;gap:3px;flex:1}
    .nav-item{
      display:flex;align-items:center;gap:10px;padding:10px 11px;
      border-radius:10px;color:var(--muted);cursor:pointer;
      transition:all .16s ease;font-size:13.5px;font-weight:500;
      user-select:none;border:1px solid transparent;
    }
    .nav-item:hover{color:var(--text);background:rgba(30,155,255,.09)}
    .nav-item.active{
      color:var(--text);
      background:linear-gradient(90deg,rgba(30,155,255,.22),rgba(30,155,255,.07));
      border-color:rgba(46,232,255,.22);
    }
    .nav-item svg{width:17px;height:17px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .sidebar-bottom{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
    .discord-btn{
      display:flex;align-items:center;justify-content:center;gap:8px;
      padding:9px 12px;border-radius:10px;border:1px solid rgba(88,101,242,.3);
      background:rgba(88,101,242,.14);color:#bcc3ff;font-size:12.5px;
      font-weight:600;cursor:pointer;transition:all .16s ease;
    }
    .discord-btn:hover{background:rgba(88,101,242,.28);color:#fff;border-color:rgba(88,101,242,.5)}
    .discord-btn svg{width:15px;height:15px;flex-shrink:0}
    .ver{font-size:11px;color:var(--muted);text-align:center;opacity:.7}

    /* ── Main ── */
    .main{
      flex:1;min-width:0;display:grid;
      grid-template-rows:auto 1fr 34px;
      padding:18px 22px 12px;gap:14px;overflow:hidden;
    }

    /* ── Hero ── */
    .hero{
      position:relative;border-radius:var(--r);overflow:hidden;
      min-height:170px;display:flex;align-items:center;padding:28px 36px;
      border:1px solid var(--border);
    }
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
    .hero-content h1 span{color:var(--cyan)}
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
      display:grid;grid-template-columns:1fr 1fr 1.15fr;gap:13px;
      min-height:0;overflow:hidden;
    }
    .card{
      background:linear-gradient(180deg,rgba(10,22,40,.96) 0%,rgba(5,12,24,.97) 100%);
      border:1px solid var(--border);border-radius:var(--r);
      padding:18px;display:flex;flex-direction:column;overflow:hidden;
      transition:border-color .2s;
      animation:slideUp .3s ease-out both;
    }
    .card:nth-child(2){animation-delay:.05s}
    .card:nth-child(3){animation-delay:.1s}
    .card:hover{border-color:rgba(30,155,255,.22)}
    .card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
    .card-label{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}

    /* Status card */
    .st-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center}
    .ring-wrap{position:relative;width:92px;height:92px}
    .ring-svg{width:100%;height:100%;transform:rotate(-90deg)}
    .ring-track{fill:none;stroke:rgba(30,155,255,.1);stroke-width:7}
    .ring-fill{
      fill:none;stroke:url(#rg);stroke-width:7;stroke-linecap:round;
      stroke-dasharray:251.3;stroke-dashoffset:251.3;
      transition:stroke-dashoffset .75s cubic-bezier(.4,0,.2,1);
    }
    .ring-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    .ring-icon svg{width:24px;height:24px;fill:none;stroke:var(--blue);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .st-text{font-size:17px;font-weight:800}
    .st-detail{font-size:12px;color:var(--muted);line-height:1.5;max-width:150px}

    /* Points card */
    .pts-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3px}
    .pts-val{font-size:44px;font-weight:900;color:var(--gold);line-height:1;letter-spacing:-1px}
    .pts-label{font-size:12px;color:var(--muted);margin-top:3px}
    .mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}
    .mini{
      background:rgba(255,255,255,.035);border:1px solid var(--border);
      border-radius:10px;padding:11px 9px;text-align:center;
    }
    .mini-val{font-size:14px;font-weight:800;transition:color .3s}
    .mini-lbl{font-size:11px;color:var(--muted);margin-top:3px}

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
      font-size:12px;font-weight:800;
    }
    .acc-info{flex:1;min-width:0}
    .acc-email{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .acc-st{font-size:11px;color:var(--muted);margin-top:1px}
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
    .view-full{display:none;flex-direction:column;gap:13px;min-height:0;overflow:hidden}
    .view-full.vis{display:flex}
    .full-card{
      flex:1;background:linear-gradient(180deg,rgba(10,22,40,.96),rgba(5,12,24,.97));
      border:1px solid var(--border);border-radius:var(--r);padding:18px;
      display:flex;flex-direction:column;overflow:hidden;
    }

    /* Console view */
    .console-wrap{display:none;flex-direction:column;gap:12px;min-height:0;overflow:hidden}
    .console-wrap.vis{display:flex}
    .console-head{display:flex;align-items:center;justify-content:space-between}
    .console-box{
      flex:1;background:rgba(2,6,14,.9);border:1px solid var(--border);
      border-radius:var(--r);padding:16px;overflow-y:auto;
      font-family:Consolas,"Cascadia Code",monospace;font-size:12.5px;
      line-height:1.6;color:#8ac8e8;white-space:pre-wrap;
    }

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
      width:min(460px,100%);
      background:linear-gradient(180deg,rgba(10,22,42,.99),rgba(4,11,24,.99));
      border:1px solid rgba(46,232,255,.22);border-radius:16px;padding:26px;
      box-shadow:0 40px 100px rgba(0,0,0,.6);animation:slideUp .22s ease-out;
    }
    .modal-icon{
      width:48px;height:48px;border-radius:14px;margin-bottom:16px;
      background:linear-gradient(145deg,var(--blue),var(--cyan));
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 10px 28px rgba(30,155,255,.3);
    }
    .modal-icon svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .modal h2{font-size:21px;font-weight:800;margin-bottom:7px}
    .modal p{color:var(--muted);font-size:13.5px;line-height:1.6;margin-bottom:18px}
    .modal-input{
      width:100%;background:rgba(2,7,16,.7);border:1px solid var(--border);
      border-radius:9px;padding:12px 14px;color:var(--text);font:inherit;
      font-size:14px;letter-spacing:.04em;outline:none;transition:border-color .15s;
      margin-bottom:11px;
    }
    .modal-input:focus{border-color:var(--cyan)}
    .modal-input::placeholder{color:rgba(110,146,184,.4);letter-spacing:0}
    .modal-actions{display:grid;grid-template-columns:1fr auto;gap:9px}
    .modal-msg{min-height:17px;font-size:12px;color:var(--cyan);margin-top:9px}
    /* Accounts editor */
    .btn-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--muted);cursor:pointer;transition:all .15s;flex-shrink:0}
    .btn-icon:hover{color:var(--text);background:rgba(255,255,255,.12);border-color:rgba(30,155,255,.3)}
    .btn-icon.danger:hover{color:var(--rose);border-color:rgba(255,107,138,.3);background:rgba(255,107,138,.07)}
    .btn-icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .acc-editor-row{display:flex;align-items:center;gap:11px;padding:11px 13px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid transparent;transition:all .15s;margin-bottom:7px}
    .acc-editor-row:hover{border-color:var(--border);background:rgba(255,255,255,.045)}
    .acc-actions-cell{display:flex;gap:6px;flex-shrink:0}
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
    /* Settings */
    .settings-wrap{display:none;flex-direction:column;gap:14px;overflow-y:auto;min-height:0}
    .settings-wrap.vis{display:flex}
    .settings-section{background:linear-gradient(180deg,rgba(10,22,40,.96),rgba(5,12,24,.97));border:1px solid var(--border);border-radius:var(--r);padding:16px}
    .settings-section h3{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:11px}
    .toggle-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    /* Account edit modal */
    .modal-field{margin-bottom:10px}
    .modal-field label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
    .modal-pw{position:relative;display:flex;align-items:center}
    .modal-pw .modal-input{padding-right:42px;width:100%}
    .modal-pw-toggle{position:absolute;right:12px;background:none;border:none;color:var(--muted);cursor:pointer;padding:2px;display:flex;transition:color .15s}
    .modal-pw-toggle:hover{color:var(--text)}
    .modal-pw-toggle svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
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
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <img src="/app-icon.png" alt="">
      <div><div class="brand-name">Rewards Desk</div><div class="brand-sub">local control panel</div></div>
    </div>
    <nav>
      <div class="nav-item active" id="nav-dash">
        <svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9 20v-5h6v5"/></svg>
        Dashboard
      </div>
      <div class="nav-item" id="nav-accounts">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg>
        Accounts
      </div>
      <div class="nav-item" id="nav-console">
        <svg viewBox="0 0 24 24"><path d="M4 17h16"/><path d="m6 7 4 4-4 4"/><path d="M13 15h5"/></svg>
        Console
      </div>
      <div class="nav-item" id="nav-settings">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Settings
      </div>
    </nav>
    <div class="sidebar-actions">
      <button class="btn-action-run" id="btn-run">
        <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
        Run now
      </button>
      <button class="btn-action-stop" id="btn-stop">
        <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Stop safely
      </button>
    </div>
    <div class="sidebar-bottom">
      <button class="discord-btn" id="discord-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037 13.8 13.8 0 0 0-.61 1.253 18.3 18.3 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.253.077.077 0 0 0-.079-.037A19.7 19.7 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.08.08 0 0 0 .031.055 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.8 19.8 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        Join Discord
      </button>
      <div class="ver">v${APP_VERSION}</div>
    </div>
  </aside>

  <main class="main">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-bg"></div>
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <h1>Automate more.<br><span>Earn more.</span></h1>
        <p>Rewards Desk — local control panel for Microsoft Rewards Bot. Runs daily sets, searches, and coupons automatically.</p>
      </div>
      <div class="hero-pills">
        <span class="pill pill-muted" id="core-pill" style="display:none">
          <span class="pill-dot"></span><span id="core-pill-txt">Core</span>
        </span>
      </div>
    </section>

    <!-- Dashboard view -->
    <div class="cards" id="view-dash">
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
            <div class="mini-lbl">Core plugin</div>
          </div>
          <div class="mini">
            <div class="mini-val" id="mini-coupons">—</div>
            <div class="mini-lbl">Coupons</div>
          </div>
        </div>
      </div>

      <!-- Accounts -->
      <div class="card">
        <div class="card-head">
          <span class="card-label">Accounts</span>
          <button class="btn btn-secondary btn-sm" id="btn-open-acc">Manage →</button>
        </div>
        <div class="acc-list" id="acc-list"></div>
      </div>
    </div>

    <!-- Accounts full view (editor) -->
    <div class="view-full" id="view-accounts">
      <div class="full-card">
        <div class="card-head">
          <span class="card-label">Accounts</span>
          <button class="btn btn-primary btn-sm" id="btn-add-acc">+ Add account</button>
        </div>
        <div id="acc-editor-list" style="overflow-y:auto;flex:1"></div>
      </div>
    </div>

    <!-- Console view -->
    <div class="console-wrap" id="view-console">
      <div class="console-head">
        <span class="card-label">Console output</span>
        <button class="btn btn-secondary btn-sm" id="console-back">← Back</button>
      </div>
      <div class="console-box" id="console-box"></div>
    </div>

    <!-- Settings view -->
    <div class="settings-wrap" id="view-settings">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <span class="card-label">Settings</span>
        <button class="btn btn-secondary btn-sm" id="settings-back">← Back</button>
      </div>
      <div class="settings-section">
        <h3>Search &amp; Tasks</h3>
        <div class="toggle-grid">
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily Set</div><div class="toggle-sub">Complete the daily activity set</div></div><label class="toggle"><input type="checkbox" id="tog-doDailySet"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Desktop Search</div><div class="toggle-sub">Bing PC search points</div></div><label class="toggle"><input type="checkbox" id="tog-doDesktopSearch"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Mobile Search</div><div class="toggle-sub">Bing mobile search points</div></div><label class="toggle"><input type="checkbox" id="tog-doMobileSearch"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Special Promotions</div><div class="toggle-sub">Sponsored bonus offers</div></div><label class="toggle"><input type="checkbox" id="tog-doSpecialPromotions"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">More Promotions</div><div class="toggle-sub">Additional bonus tasks</div></div><label class="toggle"><input type="checkbox" id="tog-doMorePromotions"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily Check-in</div><div class="toggle-sub">Daily streak check-in</div></div><label class="toggle"><input type="checkbox" id="tog-doDailyCheckIn"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Read to Earn</div><div class="toggle-sub">MSN reading rewards</div></div><label class="toggle"><input type="checkbox" id="tog-doReadToEarn"><span class="toggle-slider"></span></label></div>
        </div>
      </div>
      <div class="settings-section">
        <h3>Core (Premium)</h3>
        <div class="toggle-grid">
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Claim Points</div><div class="toggle-sub">Auto-claim ready point cards</div></div><label class="toggle"><input type="checkbox" id="tog-doClaimPoints"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Apply Coupons</div><div class="toggle-sub">Auto-apply dashboard coupons</div></div><label class="toggle"><input type="checkbox" id="tog-doApplyCoupons"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Daily Streak</div><div class="toggle-sub">Maintain streak protection</div></div><label class="toggle"><input type="checkbox" id="tog-doDailyStreak"><span class="toggle-slider"></span></label></div>
        </div>
      </div>
      <div class="settings-section">
        <h3>Options</h3>
        <div class="toggle-grid">
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Headless mode</div><div class="toggle-sub">Run browser in background</div></div><label class="toggle"><input type="checkbox" id="tog-headless"><span class="toggle-slider"></span></label></div>
          <div class="toggle-wrap"><div class="toggle-wrap-left"><div class="toggle-label">Run on zero points</div><div class="toggle-sub">Run even if no points left</div></div><label class="toggle"><input type="checkbox" id="tog-runOnZero"><span class="toggle-slider"></span></label></div>
        </div>
      </div>
      <div class="settings-section">
        <h3>Scheduler</h3>
        <div class="toggle-wrap" style="margin-bottom:9px">
          <div class="toggle-wrap-left"><div class="toggle-label">Auto-schedule</div><div class="toggle-sub">Run the bot automatically at a set time each day</div></div>
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

    <!-- Footer -->
    <footer class="footer" id="footer-bar">
      <div class="footer-left">
        <span><span class="footer-dot" id="fdot"></span><span id="ftxt">Bot ready</span></span>
        <span id="facc" style="opacity:.6"></span>
      </div>
      <span id="ftime" style="opacity:.5">v${APP_VERSION}</span>
    </footer>
  </main>

  <!-- Account edit modal -->
  <div class="modal-bg" id="acc-modal">
    <div class="modal">
      <h2 id="acc-modal-title">Add account</h2>
      <p>Microsoft account credentials. Passwords are stored locally only.</p>
      <div class="modal-field">
        <label>Email</label>
        <input class="modal-input" id="acc-email" type="email" autocomplete="off" placeholder="account@outlook.com">
      </div>
      <div class="modal-field">
        <label>Password</label>
        <div class="modal-pw">
          <input class="modal-input" id="acc-password" type="password" autocomplete="new-password" placeholder="Password">
          <button class="modal-pw-toggle" type="button" id="acc-pw-toggle">
            <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>
      <div class="modal-field">
        <label>TOTP secret <span style="opacity:.5;font-weight:400;text-transform:none">(optional — only if 2FA enabled)</span></label>
        <input class="modal-input" id="acc-totp" autocomplete="off" placeholder="Base32 TOTP secret">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="acc-modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="acc-modal-save">Save account</button>
      </div>
      <div class="modal-msg" id="acc-modal-msg"></div>
    </div>
  </div>

  <!-- License modal -->
  <div class="modal-bg" id="modal">
    <div class="modal">
      <div class="modal-icon">
        <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </div>
      <h2>Core license</h2>
      <p>Enter your Core license key to enable premium features, or continue without it to use the open-source bot.</p>
      <input class="modal-input" id="lic-input" autocomplete="off" spellcheck="false" placeholder="MSRB-XXXX-XXXX-XXXX-XXXX">
      <div class="modal-actions">
        <button class="btn btn-secondary" id="lic-skip">Continue without Core</button>
        <button class="btn btn-primary" id="lic-submit">Activate</button>
      </div>
      <div class="modal-msg" id="lic-msg"></div>
    </div>
  </div>

  <script>
    var G = function(id){return document.getElementById(id);};
    var CIRC = 251.3;
    var view = 'dash';
    var accEditIdx = -1;

    // ── View ──────────────────────────────────
    function setView(v) {
      view = v;
      G('view-dash').style.display = v === 'dash' ? '' : 'none';
      G('view-accounts').className = v === 'accounts' ? 'view-full vis' : 'view-full';
      G('view-console').className = v === 'console' ? 'console-wrap vis' : 'console-wrap';
      G('view-settings').className = v === 'settings' ? 'settings-wrap vis' : 'settings-wrap';
      G('footer-bar').style.display = (v === 'console' || v === 'settings') ? 'none' : '';
      ['dash','accounts','console','settings'].forEach(function(n) {
        var el = G('nav-' + n); if (el) el.classList.toggle('active', n === v);
      });
      if (v === 'accounts') loadAccEditor();
      if (v === 'settings') loadSettings();
    }

    function setRing(pct) {
      var el = G('ring-path');
      if (el) el.style.strokeDashoffset = CIRC * (1 - Math.min(100, Math.max(0, pct || 0)) / 100);
    }

    function esc(v) {
      return String(v).replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      });
    }

    // ── Dashboard accounts (masked list) ──────
    function renderAccounts(accounts, active) {
      if (!accounts || !accounts.length) {
        return '<div class="acc-empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg><p>No accounts yet</p><button class="btn btn-secondary btn-sm" onclick="setView(&apos;accounts&apos;)">Add accounts</button></div>';
      }
      return accounts.map(function(a) {
        var ini = String(a.email || 'A?').split('@')[0].slice(0,2).toUpperCase();
        var isActive = active && a.email && a.email.indexOf(active.slice(0,5)) === 0;
        var disabled = !a.enabled;
        return '<div class="acc-row' + (isActive?' is-active':'') + (disabled?' is-disabled':'') + '">' +
          '<div class="acc-avatar">' + esc(ini) + '</div>' +
          '<div class="acc-info"><div class="acc-email">' + esc(a.email||'') + '</div>' +
          '<div class="acc-st">' + (disabled?'Disabled':isActive?'Running...':'Ready') + '</div></div>' +
          '<span class="acc-dot ' + (disabled?'dot-off':isActive?'dot-run':'dot-ready') + '"></span></div>';
      }).join('');
    }

    // ── Refresh ───────────────────────────────
    async function refresh() {
      var data;
      try { data = await fetch('/api/state').then(function(r){return r.json();}); }
      catch(e) { G('st-text').textContent = 'Offline'; return; }
      var s = data.status || 'Ready';
      var running = data.isRunning;
      var m = data.metrics || {};

      G('st-text').textContent = s;
      G('st-detail').textContent = data.detail || '';
      setRing(m.progress || 0);

      var coreOk = m.core === 'Active';
      var coreKnown = m.core === 'Active' || m.core === 'Inactive';
      var cp = G('core-pill');
      cp.style.display = (running || coreKnown) ? '' : 'none';
      cp.className = 'pill ' + (coreOk ? 'pill-ok' : 'pill-muted');
      G('core-pill-txt').textContent = coreOk ? 'Core active' : 'No Core';

      var pts = m.points;
      var hasData = running || (pts !== null && pts !== undefined);
      G('pts-val').textContent = hasData ? (pts !== null && pts !== undefined ? (pts >= 0 ? '+'+pts : ''+pts) : '+0') : '—';
      G('pts-val').style.color = hasData ? 'var(--gold)' : 'var(--muted)';
      G('pts-label').textContent = hasData ? 'collected this run' : 'start a run to see stats';

      var mc = G('mini-core');
      mc.textContent = coreOk ? 'Active' : (m.core === 'Inactive' ? 'Inactive' : running ? '...' : '—');
      mc.style.color = coreOk ? 'var(--green)' : 'var(--muted)';
      G('mini-coupons').textContent = m.coupons || (running ? '...' : '—');

      G('btn-run').disabled = running;
      G('btn-stop').disabled = !running;
      G('acc-list').innerHTML = renderAccounts(data.accounts, data.activeAccount);

      if (data.consoleLogs && data.consoleLogs.length) {
        var lines = data.consoleLogs.map(function(l) {
          return '[' + new Date(l.at).toLocaleTimeString() + '] ' + l.message;
        }).join('\\n');
        G('console-box').textContent = lines;
        if (view === 'console') { var b = G('console-box'); b.scrollTop = b.scrollHeight; }
      }

      var fdot = G('fdot');
      fdot.style.background = running ? 'var(--blue)' : s==='Complete' ? 'var(--green)' : s==='Attention' ? 'var(--gold)' : 'var(--muted)';
      G('ftxt').textContent = running ? 'Bot running' : 'Bot ' + s.toLowerCase();
      G('facc').textContent = data.activeAccount ? 'Account: ' + data.activeAccount : '';

      if (data.licensePrompt) {
        G('modal').classList.toggle('open', Boolean(data.licensePrompt.visible));
        if (data.licensePrompt.message) G('lic-msg').textContent = data.licensePrompt.message;
        if (data.licensePrompt.status === 'invalid') G('lic-input').focus();
      }
    }

    // ── Start/Stop ────────────────────────────
    async function startWithKey(key) {
      G('lic-msg').textContent = key ? 'Checking Core license...' : 'Starting without Core...';
      await fetch('/api/start', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({licenseKey:key||''})});
      G('modal').classList.remove('open');
      refresh();
    }

    // ── Accounts editor ───────────────────────
    var _raw = [];
    async function loadAccEditor() {
      try { _raw = await fetch('/api/accounts-raw').then(function(r){return r.json();}); }
      catch(e) { _raw = []; }
      renderAccEditor();
    }
    function renderAccEditor() {
      var list = G('acc-editor-list');
      if (!_raw.length) {
        list.innerHTML = '<div class="acc-empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.8-4 13.2-4 15 0"/></svg><p>No accounts yet. Click "+ Add account" to get started.</p></div>';
        return;
      }
      list.innerHTML = _raw.map(function(a, i) {
        var ini = String(a.email||'?').split('@')[0].slice(0,2).toUpperCase();
        var ena = a.enabled !== false;
        return '<div class="acc-editor-row">' +
          '<div class="acc-avatar">' + esc(ini) + '</div>' +
          '<div class="acc-info" style="flex:1;min-width:0">' +
            '<div class="acc-email">' + esc(a.email||'(no email)') + '</div>' +
            '<div class="acc-st">' + (ena ? 'Enabled' : 'Disabled') + '</div>' +
          '</div>' +
          '<div class="acc-actions-cell">' +
            '<button class="btn-icon" title="Toggle enabled" onclick="toggleAcc(' + i + ')">' +
              (ena
                ? '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
                : '<svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/></svg>') +
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
    async function saveRaw() {
      try { await fetch('/api/accounts-save', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(_raw)}); }
      catch(e) {}
    }
    function toggleAcc(i) { _raw[i].enabled = !(_raw[i].enabled !== false); saveRaw(); renderAccEditor(); }
    function deleteAcc(i) {
      if (!confirm('Delete ' + (_raw[i].email || 'this account') + '?')) return;
      _raw.splice(i, 1); saveRaw(); renderAccEditor();
    }
    function openAccAdd() {
      accEditIdx = -1;
      G('acc-modal-title').textContent = 'Add account';
      G('acc-email').value = ''; G('acc-password').value = ''; G('acc-totp').value = '';
      G('acc-modal-msg').textContent = '';
      G('acc-modal').classList.add('open'); G('acc-email').focus();
    }
    function openAccEdit(i) {
      accEditIdx = i;
      var a = _raw[i];
      G('acc-modal-title').textContent = 'Edit account';
      G('acc-email').value = a.email || ''; G('acc-password').value = a.password || ''; G('acc-totp').value = a.totpSecret || '';
      G('acc-modal-msg').textContent = '';
      G('acc-modal').classList.add('open'); G('acc-email').focus();
    }
    function saveAccModal() {
      var email = G('acc-email').value.trim();
      var pw = G('acc-password').value;
      var totp = G('acc-totp').value.trim();
      if (!email) { G('acc-modal-msg').textContent = 'Email is required.'; return; }
      if (accEditIdx === -1) {
        _raw.push({email:email,password:pw,totpSecret:totp,recoveryEmail:'',geoLocale:'auto',langCode:'en',
          proxy:{proxyAxios:false,url:'',port:0,username:'',password:''},
          saveFingerprint:{mobile:false,desktop:false},enabled:true});
      } else {
        _raw[accEditIdx].email = email; _raw[accEditIdx].password = pw; _raw[accEditIdx].totpSecret = totp;
      }
      saveRaw(); G('acc-modal').classList.remove('open'); renderAccEditor();
    }

    // ── Settings ──────────────────────────────
    async function loadSettings() {
      var s; try { s = await fetch('/api/settings').then(function(r){return r.json();}); } catch(e) { return; }
      var w = s.workers || {};
      ['doDailySet','doSpecialPromotions','doMorePromotions','doDesktopSearch','doMobileSearch',
       'doDailyCheckIn','doClaimPoints','doApplyCoupons','doDailyStreak','doReadToEarn'].forEach(function(id) {
        var el = G('tog-' + id); if (el) el.checked = w[id] !== false;
      });
      var h = G('tog-headless'); if (h) h.checked = s.headless === true;
      var rz = G('tog-runOnZero'); if (rz) rz.checked = s.runOnZeroPoints === true;
      var sc = s.scheduler || {};
      var schTog = G('tog-scheduler');
      if (schTog) { schTog.checked = !!sc.enabled; _updateSchFields(!!sc.enabled); }
      if (G('sch-startTime')) G('sch-startTime').value = sc.startTime || '08:00';
      if (G('sch-timezone')) { G('sch-timezone').value = sc.timezone || 'Europe/Paris'; }
      var rd = sc.randomDelay || {};
      if (G('sch-delayMin')) G('sch-delayMin').value = rd.min || '0min';
      if (G('sch-delayMax')) G('sch-delayMax').value = rd.max || '30min';
      var rus = G('tog-runOnStartup'); if (rus) rus.checked = sc.runOnStartup !== false;
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

    // ── Listeners ─────────────────────────────
    G('btn-run').addEventListener('click', async function() {
      var s = await fetch('/api/state').then(function(r){return r.json();}).catch(function(){return {};});
      if (s.hasLicenseCache) { startWithKey(''); }
      else { G('modal').classList.add('open'); G('lic-input').focus(); }
    });
    G('btn-stop').addEventListener('click', function() { fetch('/api/stop',{method:'POST'}).then(refresh); });
    G('lic-submit').addEventListener('click', function() { startWithKey(G('lic-input').value.trim()); });
    G('lic-skip').addEventListener('click', function() { startWithKey(''); });
    G('lic-input').addEventListener('keydown', function(e) { if (e.key==='Enter') startWithKey(G('lic-input').value.trim()); });
    G('btn-open-acc').addEventListener('click', function() { setView('accounts'); });
    G('btn-add-acc').addEventListener('click', openAccAdd);
    G('acc-modal-save').addEventListener('click', saveAccModal);
    G('acc-modal-cancel').addEventListener('click', function() { G('acc-modal').classList.remove('open'); });
    G('acc-email').addEventListener('keydown', function(e) { if (e.key==='Enter') G('acc-password').focus(); });
    G('acc-password').addEventListener('keydown', function(e) { if (e.key==='Enter') saveAccModal(); });
    G('acc-pw-toggle').addEventListener('click', function() {
      var i = G('acc-password'); i.type = i.type === 'password' ? 'text' : 'password';
    });
    G('discord-btn').addEventListener('click', function() { window.open('https://discord.gg/JWhCkhSYtg'); });
    G('nav-dash').addEventListener('click', function() { setView('dash'); });
    G('nav-accounts').addEventListener('click', function() { setView('accounts'); });
    G('nav-console').addEventListener('click', function() { setView('console'); });
    G('nav-settings').addEventListener('click', function() { setView('settings'); });
    G('console-back').addEventListener('click', function() { setView('dash'); });
    G('settings-back').addEventListener('click', function() { setView('dash'); });
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
    var TOGGLE_MAP = {
      'tog-doDailySet':'workers.doDailySet','tog-doSpecialPromotions':'workers.doSpecialPromotions',
      'tog-doMorePromotions':'workers.doMorePromotions','tog-doDesktopSearch':'workers.doDesktopSearch',
      'tog-doMobileSearch':'workers.doMobileSearch','tog-doDailyCheckIn':'workers.doDailyCheckIn',
      'tog-doClaimPoints':'workers.doClaimPoints','tog-doApplyCoupons':'workers.doApplyCoupons',
      'tog-doDailyStreak':'workers.doDailyStreak','tog-doReadToEarn':'workers.doReadToEarn',
      'tog-headless':'headless','tog-runOnZero':'runOnZeroPoints'
    };
    Object.keys(TOGGLE_MAP).forEach(function(id) {
      var el = G(id); if (!el) return;
      el.addEventListener('change', function() { saveSetting(TOGGLE_MAP[id], el.checked); });
    });
    window.addEventListener('beforeunload', function() { navigator.sendBeacon('/api/close'); });
    setInterval(refresh, 900);
    refresh();
  </script>
</body>
</html>`
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
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
                icons: [{ src: '/app-icon.png', sizes: '512x512', type: 'image/png' }]
            })
        )
        return
    }
    if (req.method === 'GET' && req.url === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state))
        return
    }
    if (req.method === 'POST' && req.url === '/api/input') {
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
            const parsed = parseJson(body, {})
            sendInput(parsed.value || '')
            res.writeHead(204)
            res.end()
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/start') {
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
            const parsed = parseJson(body, {})
            const started = startBot(parsed.licenseKey || '')
            res.writeHead(started ? 204 : 409)
            res.end()
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/stop') {
        const stopped = stopBot()
        res.writeHead(stopped ? 204 : 409)
        res.end()
        return
    }
    if (req.method === 'POST' && req.url === '/api/close') {
        scheduleShutdown()
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
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(readAccountsRaw()))
        return
    }
    if (req.method === 'POST' && req.url === '/api/accounts-save') {
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
            const accounts = parseJson(body, null)
            if (!Array.isArray(accounts)) { res.writeHead(400); res.end('Invalid'); return }
            try { writeAccountsRaw(accounts); res.writeHead(204); res.end() }
            catch (e) { res.writeHead(500); res.end(String(e.message)) }
        })
        return
    }
    if (req.method === 'GET' && req.url === '/api/settings') {
        const cfg = readConfigRaw()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
            workers: cfg.workers || {},
            headless: cfg.headless,
            runOnZeroPoints: cfg.runOnZeroPoints,
            terminal: cfg.terminal || { enabled: false },
            scheduler: cfg.scheduler || {}
        }))
        return
    }
    if (req.method === 'POST' && req.url === '/api/settings') {
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
            const patch = parseJson(body, null)
            if (!patch || typeof patch !== 'object') { res.writeHead(400); res.end(); return }
            try { writeConfigPatch(patch); res.writeHead(204); res.end() }
            catch (e) { res.writeHead(500); res.end(String(e.message)) }
        })
        return
    }
    if (req.method === 'POST' && req.url === '/api/open-discord') {
        openDiscord()
        res.writeHead(204)
        res.end()
        return
    }
    res.writeHead(404)
    res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address()
    const url = `http://127.0.0.1:${address.port}`
    if (process.env.MSRB_APP_NO_OPEN !== '1') openAppWindow(url)
    prepareInitialRun()
})

function openAppWindow(url) {
    const browser = resolveAppBrowser()
    if (browser) {
        const profileDir = path.join(os.tmpdir(), 'microsoft-rewards-bot-app')
        childProcess
            .spawn(
                browser.command,
                [
                    ...browser.args,
                    `--app=${url}`,
                    `--window-size=${APP_WINDOW_WIDTH},${APP_WINDOW_HEIGHT}`,
                    '--start-maximized',
                    '--no-first-run',
                    '--disable-extensions',
                    `--user-data-dir=${profileDir}`,
                    process.platform === 'linux' ? '--class=RewardsBot' : ''
                ].filter(Boolean),
                {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                }
            )
            .unref()
        return
    }

    openDefaultBrowser(url)
}

function resolveAppBrowser() {
    if (process.env.MSRB_APP_BROWSER) return { command: process.env.MSRB_APP_BROWSER, args: [] }

    const candidates =
        process.platform === 'win32'
            ? [
                  path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                  path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                  path.join(process.env.ProgramFiles || '', 'Chromium', 'Application', 'chrome.exe'),
                  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
              ]
            : process.platform === 'darwin'
              ? [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/Applications/Chromium.app/Contents/MacOS/Chromium',
                    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
                ]
              : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return { command: candidate, args: [] }
        if (!path.isAbsolute(candidate) && commandExists(candidate)) return { command: candidate, args: [] }
    }
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

function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where' : 'which'
    return childProcess.spawnSync(checker, [command], { stdio: 'ignore' }).status === 0
}

function openDefaultBrowser(url) {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    childProcess.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
    if (shuttingDown) return
    shuttingDown = true

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
    if (shutdownTimer) return
    shutdownTimer = setTimeout(shutdown, 500)
}

function closeServerAndExit() {
    const exitTimer = setTimeout(() => process.exit(0), 1200)
    exitTimer.unref()
    server.close(() => process.exit(0))
}
