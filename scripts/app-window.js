const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number.parseInt(process.env.MSRB_APP_PORT || '0', 10)
const APP_TITLE = 'Rewards Bot'

const state = {
    status: 'Starting',
    detail: 'Preparing the run',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    isRunning: false,
    accounts: readAccounts(),
    activeAccount: null,
    logs: [],
    metrics: {
        core: 'Checking',
        points: null,
        coupons: null,
        progress: 6
    }
}

let botProcess = null
let shutdownTimer = null
let stopRequested = false
let shuttingDown = false

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
    if (state.logs.length > 160) state.logs.splice(0, state.logs.length - 160)
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
        state.metrics.progress = Math.max(state.metrics.progress, 20)
    } else if (/Core inactive|requires Core|Background agent requires Core/i.test(line)) {
        state.metrics.core = 'Inactive'
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

function startBot() {
    if (botProcess) return false
    stopRequested = false
    state.status = 'Starting'
    state.detail = 'Preparing the run'
    state.startedAt = new Date().toISOString()
    state.finishedAt = null
    state.exitCode = null
    state.isRunning = true
    state.metrics.progress = Math.max(state.metrics.progress, 6)
    pushLog('info', 'Starting Rewards Bot run.')

    botProcess = childProcess.spawn(process.execPath, ['./dist/index.js', '--ui-child'], {
        cwd: ROOT,
        env: { ...process.env, MSRB_UI_CHILD: '1', MSRB_TERMINAL_MODE: '0' },
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

function html() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_TITLE}</title>
  <style>
    :root {
      --night: #040912;
      --panel: #071425;
      --panel-2: #0b1b30;
      --line: #18395f;
      --line-soft: rgba(92, 154, 219, .25);
      --text: #eef7ff;
      --muted: #93a8c7;
      --blue: #1e9bff;
      --cyan: #2ee8ff;
      --green: #2fd27d;
      --gold: #f7c85c;
      --rose: #ff6b8a;
      --shadow: 0 24px 80px rgba(0, 0, 0, .46);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "Segoe UI", "Aptos", system-ui, sans-serif;
      background:
        radial-gradient(circle at 82% 12%, rgba(30, 155, 255, .28), transparent 32%),
        radial-gradient(circle at 8% 18%, rgba(47, 210, 125, .12), transparent 24%),
        linear-gradient(135deg, #030712 0%, #071425 52%, #030712 100%);
      overflow: hidden;
    }
    button, input { font: inherit; }
    .shell {
      display: grid;
      grid-template-columns: 220px 1fr;
      width: min(1360px, calc(100vw - 48px));
      height: min(820px, calc(100vh - 48px));
      margin: 24px auto;
      border: 1px solid rgba(93, 153, 219, .36);
      border-radius: 18px;
      background: rgba(4, 11, 22, .84);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    aside {
      border-right: 1px solid var(--line-soft);
      padding: 26px 18px;
      background: linear-gradient(180deg, rgba(7, 20, 37, .92), rgba(4, 9, 18, .9));
      position: relative;
    }
    .brand {
      display: grid;
      gap: 12px;
      justify-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--line-soft);
      text-align: center;
    }
    .bot-mark {
      width: 64px;
      height: 64px;
      border-radius: 20px;
      background: linear-gradient(145deg, var(--cyan), var(--blue));
      display: grid;
      place-items: center;
      box-shadow: 0 0 36px rgba(30, 155, 255, .42);
      position: relative;
    }
    .bot-mark:before {
      content: "";
      width: 34px;
      height: 24px;
      border: 3px solid #dff8ff;
      border-radius: 12px;
      box-shadow: inset 0 -8px 16px rgba(0, 0, 0, .18);
    }
    .bot-mark:after {
      content: "";
      position: absolute;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #dff8ff;
      box-shadow: 16px 0 0 #dff8ff;
    }
    .brand h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    .brand p { margin: 0; color: var(--muted); font-size: 13px; }
    nav { display: grid; gap: 8px; margin-top: 24px; }
    nav div {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 13px;
      border-radius: 10px;
      color: #c9dcf7;
      border: 1px solid transparent;
    }
    nav div.active {
      color: white;
      border-color: rgba(46, 232, 255, .38);
      background: linear-gradient(90deg, rgba(30, 155, 255, .28), rgba(30, 155, 255, .08));
    }
    .dot { width: 8px; height: 8px; border-radius: 99px; background: var(--blue); }
    .side-card {
      margin-top: auto;
      position: absolute;
      bottom: 26px;
      left: 18px;
      right: 18px;
      padding: 14px;
      border: 1px solid var(--line-soft);
      border-radius: 12px;
      background: rgba(8, 24, 42, .72);
    }
    .side-card strong { display: block; font-size: 13px; margin-bottom: 8px; }
    .side-card span { color: var(--green); font-size: 12px; }
    main { padding: 24px; overflow: auto; }
    .hero {
      min-height: 210px;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 34px 36px;
      background:
        radial-gradient(circle at 76% 48%, rgba(46, 232, 255, .22), transparent 28%),
        linear-gradient(135deg, rgba(12, 32, 58, .92), rgba(4, 10, 21, .94));
      position: relative;
      overflow: hidden;
    }
    .hero:after {
      content: "";
      position: absolute;
      right: 56px;
      top: 34px;
      width: 220px;
      height: 150px;
      border-radius: 50%;
      border: 18px solid rgba(30, 155, 255, .2);
      box-shadow: inset 0 0 0 20px rgba(46, 232, 255, .08), 0 0 60px rgba(30, 155, 255, .26);
      transform: rotate(-18deg);
    }
    .hero h2 { position: relative; margin: 0; font-size: 42px; line-height: 1.06; letter-spacing: 0; max-width: 520px; }
    .hero h2 span { color: var(--cyan); }
    .hero p { position: relative; color: #c4d6ef; max-width: 470px; margin: 16px 0 0; line-height: 1.6; }
    .chips { display: flex; gap: 10px; margin-top: 22px; position: relative; }
    .chip { border: 1px solid var(--line-soft); border-radius: 999px; padding: 8px 12px; color: #dbeafe; background: rgba(5, 16, 30, .65); font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1.05fr 1.25fr 1fr; gap: 14px; margin-top: 14px; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(9, 24, 43, .92), rgba(5, 13, 26, .92));
      padding: 18px;
      min-height: 172px;
    }
    .panel h3 { margin: 0 0 14px; font-size: 16px; }
    .status-ring {
      width: 88px;
      height: 88px;
      margin: 8px auto 12px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: conic-gradient(var(--blue) calc(var(--progress) * 1%), rgba(30, 155, 255, .16) 0);
      position: relative;
    }
    .status-ring:after { content: ""; width: 62px; height: 62px; background: var(--panel); border-radius: 50%; }
    .status-ring i { position: absolute; width: 22px; height: 22px; background: var(--blue); border-radius: 6px; z-index: 1; }
    .center { text-align: center; }
    .muted { color: var(--muted); }
    .progress-list { display: grid; gap: 12px; }
    .row { display: grid; grid-template-columns: 120px 1fr auto; gap: 12px; align-items: center; color: #dceaff; font-size: 14px; }
    .bar { height: 7px; background: rgba(148, 163, 184, .18); border-radius: 99px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-radius: inherit; }
    .points { display: grid; place-items: center; text-align: center; min-height: 130px; }
    .points strong { font-size: 34px; }
    .points span { color: var(--muted); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
    .account { display: flex; align-items: center; gap: 14px; }
    .avatar { width: 54px; height: 54px; border-radius: 18px; display: grid; place-items: center; background: linear-gradient(145deg, #1d4ed8, #2ee8ff); font-weight: 800; }
    .actions { display: grid; gap: 10px; }
    .action {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 14px;
      border: 1px solid var(--line-soft);
      border-radius: 10px;
      background: rgba(14, 31, 54, .78);
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr 132px;
      gap: 10px;
      margin-top: 18px;
    }
    .secondary {
      border: 1px solid var(--line-soft);
      background: rgba(14, 31, 54, .72);
      color: #cfe4ff;
    }
    button:disabled {
      cursor: default;
      opacity: .48;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(47, 210, 125, .3);
      border-radius: 999px;
      padding: 7px 10px;
      color: #bdf8d8;
      background: rgba(47, 210, 125, .1);
      font-size: 13px;
    }
    .activity { display: grid; gap: 9px; max-height: 180px; overflow: auto; padding-right: 4px; }
    .log { color: #cfe4ff; font-size: 13px; border-left: 2px solid rgba(46, 232, 255, .45); padding: 3px 0 3px 10px; }
    form { display: flex; gap: 10px; margin-top: 12px; }
    input { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: rgba(2, 8, 18, .68); color: white; }
    button { border: 0; border-radius: 10px; background: linear-gradient(135deg, var(--blue), #4f7cff); color: white; padding: 12px 14px; font-weight: 800; cursor: pointer; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; height: auto; min-height: calc(100vh - 32px); }
      aside { display: none; }
      .grid, .two { grid-template-columns: 1fr; }
      .hero h2 { font-size: 34px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand"><div class="bot-mark"></div><div><h1>Rewards Bot</h1><p>with Core Plugin</p></div></div>
      <nav><div class="active"><span class="dot"></span>Dashboard</div><div><span class="dot"></span>Accounts</div><div><span class="dot"></span>Activity</div><div><span class="dot"></span>Settings</div></nav>
      <div class="side-card"><strong>Core Plugin</strong><span id="side-core">Checking</span></div>
    </aside>
    <main>
      <section class="hero">
        <h2>Automate more.<br><span>Earn more.</span></h2>
        <p>The open-source Microsoft Rewards bot, presented as a clean desktop experience for everyday users.</p>
        <div class="chips"><div class="chip">Open Source</div><div class="chip">Powered by Core</div><div class="chip" id="hero-status">Starting</div></div>
      </section>
      <section class="grid">
        <div class="panel center"><h3>Bot Status</h3><div class="status-ring" id="ring" style="--progress:6"><i></i></div><strong id="status">Starting</strong><p class="muted" id="detail">Preparing the run</p><span class="pill" id="run-pill">Launching</span></div>
        <div class="panel"><h3>Today's Progress</h3><div class="progress-list"><div class="row"><span>Search points</span><div class="bar"><span id="search-bar" style="width:40%"></span></div><b id="points">-</b></div><div class="row"><span>Daily set</span><div class="bar"><span style="width:100%"></span></div><b>Ready</b></div><div class="row"><span>Coupons</span><div class="bar"><span id="coupon-bar" style="width:15%"></span></div><b id="coupons">-</b></div></div></div>
        <div class="panel points"><div><strong id="core">Checking</strong><br><span>Core status</span><div class="controls"><button id="start-run">Start Run</button><button class="secondary" id="stop-run">Stop</button></div></div></div>
      </section>
      <section class="two">
        <div class="panel"><h3>Active Account</h3><div class="account"><div class="avatar" id="avatar">A1</div><div><strong id="account">No account loaded</strong><p class="muted" id="account-state">Waiting</p></div></div><form id="input-form"><input id="input" autocomplete="off" placeholder="License key or empty response"><button>Continue</button></form></div>
        <div class="panel"><h3>Recent Activity</h3><div class="activity" id="logs"></div></div>
      </section>
    </main>
  </div>
  <script>
    const byId = id => document.getElementById(id);
    const ui = {
      status: byId('status'),
      detail: byId('detail'),
      ring: byId('ring'),
      runPill: byId('run-pill'),
      core: byId('core'),
      points: byId('points'),
      coupons: byId('coupons'),
      account: byId('account'),
      avatar: byId('avatar'),
      input: byId('input'),
      logs: byId('logs'),
      heroStatus: byId('hero-status'),
      sideCore: byId('side-core'),
      searchBar: byId('search-bar'),
      couponBar: byId('coupon-bar'),
      accountState: byId('account-state'),
      startRun: byId('start-run'),
      stopRun: byId('stop-run')
    };
    async function refresh(){
      try {
        const data = await fetch('/api/state').then(r=>r.json());
        ui.status.textContent = data.status;
        ui.heroStatus.textContent = data.status;
        ui.detail.textContent = data.detail;
        ui.core.textContent = data.metrics.core || '-';
        ui.sideCore.textContent = data.metrics.core || '-';
        ui.points.textContent = data.metrics.points === null ? '-' : '+' + data.metrics.points;
        ui.coupons.textContent = data.metrics.coupons || '-';
        ui.ring.style.setProperty('--progress', data.metrics.progress || 6);
        ui.searchBar.style.width = Math.min(100, Math.max(12, data.metrics.progress || 6)) + '%';
        ui.couponBar.style.width = data.metrics.coupons ? '100%' : '15%';
        ui.runPill.textContent = data.isRunning ? 'Running' : 'Ready';
        ui.startRun.disabled = data.isRunning;
        ui.stopRun.disabled = !data.isRunning;
        const active = data.activeAccount || (data.accounts[0] && data.accounts[0].email) || 'No account loaded';
        ui.account.textContent = active;
        ui.accountState.textContent = data.status === 'Complete' ? 'Finished' : data.detail;
        ui.avatar.textContent = initials(active);
        ui.logs.innerHTML = data.logs.slice(-14).reverse().map(l=>'<div class="log">'+escapeHtml(l.message)+'</div>').join('');
      } catch {
        ui.status.textContent = 'Disconnected';
        ui.detail.textContent = 'The local app service is not reachable';
        ui.runPill.textContent = 'Closed';
      }
    }
    function initials(value){ const name=String(value).split('@')[0] || 'A1'; return name.slice(0,2).toUpperCase(); }
    function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    document.getElementById('input-form').addEventListener('submit', async event => {
      event.preventDefault();
      await fetch('/api/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:ui.input.value})});
      ui.input.value='';
    });
    ui.startRun.addEventListener('click', async () => { await fetch('/api/start', { method: 'POST' }); refresh(); });
    ui.stopRun.addEventListener('click', async () => { await fetch('/api/stop', { method: 'POST' }); refresh(); });
    window.addEventListener('beforeunload', () => navigator.sendBeacon('/api/close'));
    setInterval(refresh, 900); refresh();
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
        const started = startBot()
        res.writeHead(started ? 204 : 409)
        res.end()
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
    res.writeHead(404)
    res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address()
    const url = `http://127.0.0.1:${address.port}`
    openAppWindow(url)
    startBot()
})

function openAppWindow(url) {
    const browser = resolveAppBrowser()
    if (browser) {
        childProcess
            .spawn(browser.command, [...browser.args, `--app=${url}`, '--window-size=1360,860'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            })
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
                  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                  path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                  path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
              ]
            : process.platform === 'darwin'
              ? [
                    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/Applications/Chromium.app/Contents/MacOS/Chromium'
                ]
              : ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return { command: candidate, args: [] }
        if (!path.isAbsolute(candidate) && commandExists(candidate)) return { command: candidate, args: [] }
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
