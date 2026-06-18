const fs = require('fs')
const path = require('path')
const { chromium } = require('patchright')
const { analyzeSavedPage } = require('./rewards-page-analyzer')

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard'
const EARN_URL = 'https://rewards.bing.com/earn'

// ── Hosts whose responses are candidates for the dashboard data API ──────────
// We watch these to settle the CSR-vs-RSC question: if the dashboard data
// (balance / userStatus / dailySetItems) arrives as a JSON network response
// rather than inline self.__next_f flight chunks, Microsoft moved to a
// client-side fetch and the bot must intercept the response, not parse HTML.
const DATA_HOST_RE = /(^|\.)rewards\.bing\.com$|(^|\.)rewardsplatform\.microsoft\.com$|(^|\.)bing\.com$/i

function markersFor(body) {
    return {
        balance: /"balance"/.test(body),
        availablePoints: /"availablePoints"/.test(body),
        userStatus: /"userStatus"/.test(body),
        levelInfo: /"levelInfo"/.test(body),
        counters: /"counters"|"pcSearch"|"mobileSearch"/.test(body),
        dailySetItems: /"dailySetItems"/.test(body),
        offerId: /"offerId"/.test(body),
        hash: /"hash"/.test(body),
        pointProgress: /"pointProgress"/.test(body),
        promotions: /"morePromotions"|"promotions"|"dailySetPromotions"/.test(body)
    }
}

function anyMarker(markers) {
    return markers ? Object.values(markers).some(Boolean) : false
}

// Attach network listeners that record JSON/data responses + interesting POSTs
// (Server Actions carry a `next-action` request header).
function attachNetworkCapture(page) {
    const responses = []
    const actionPosts = []

    page.on('response', async response => {
        try {
            const url = response.url()
            const host = new URL(url).host
            if (!DATA_HOST_RE.test(host)) return

            const headers = response.headers()
            const ct = headers['content-type'] || ''
            const looksData = /json/i.test(ct) || /\/api\/|\/dapi\/|getuserinfo|dashboard|reward|\/me\b|activity/i.test(url)
            if (!looksData) return

            const body = await response.text().catch(() => '')
            const markers = markersFor(body)
            // Only keep responses that look like real data, to avoid noise.
            if (!anyMarker(markers) && !/json/i.test(ct)) return

            responses.push({
                url: url.slice(0, 220),
                status: response.status(),
                contentType: ct.slice(0, 60),
                bodyLen: body.length,
                markers,
                hasData: anyMarker(markers)
            })
        } catch {
            /* opaque/redirect/streamed response — ignore */
        }
    })

    page.on('request', request => {
        try {
            if (request.method() !== 'POST') return
            const url = request.url()
            const host = new URL(url).host
            if (!DATA_HOST_RE.test(host)) return
            const headers = request.headers()
            const nextAction = headers['next-action']
            if (!nextAction && !/activity|report|api|dapi/i.test(url)) return
            actionPosts.push({
                url: url.slice(0, 220),
                nextAction: nextAction || null,
                hasNextRouterState: Boolean(headers['next-router-state-tree']),
                postDataLen: (request.postData() || '').length
            })
        } catch {
            /* ignore */
        }
    })

    return { responses, actionPosts }
}

// Snapshot of RSC / Server-Action markers present in the *live* DOM (page.content()
// includes the <script> tags that SingleFile captures strip out).
async function readRscPresence(page) {
    const html = await page.content()
    return {
        htmlLen: html.length,
        next_f: html.includes('self.__next_f'),
        next_s: html.includes('self.__next_s'),
        webpackChunk: html.includes('webpackChunk_N_E'),
        createServerReference: /createServerReference/.test(html),
        reportActivity: /reportActivity/.test(html),
        nextScriptTags: (html.match(/<script[^>]+src=["'][^"']*\/_next\//gi) || []).length,
        inlineScriptTags: (html.match(/<script(?![^>]+src)/gi) || []).length
    }
}

async function readDomSignals(page) {
    return page.evaluate(() => {
        const panels = Array.from(
            document.querySelectorAll('[role="dialog"], .react-aria-DisclosurePanel:not([hidden])')
        ).filter(el => {
            const rect = el.getBoundingClientRect()
            const style = window.getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        })

        return {
            url: location.href,
            title: document.title,
            loggedInLikely: !/signin|login|oauth|\/welcome/i.test(location.href),
            dashboardReady:
                location.pathname === '/dashboard' &&
                Boolean(document.querySelector('section#snapshot, section#dailyset')),
            welcomePage: /\/welcome/i.test(location.pathname),
            snapshotSection: Boolean(document.querySelector('section#snapshot')),
            dailySetSection: Boolean(document.querySelector('section#dailyset')),
            switches: Array.from(document.querySelectorAll('input[role="switch"], button[role="switch"]')).map(el => ({
                tag: el.tagName.toLowerCase(),
                checked:
                    typeof el.checked === 'boolean'
                        ? el.checked
                        : el.getAttribute('aria-checked') === 'true'
                          ? true
                          : el.getAttribute('aria-checked') === 'false'
                            ? false
                            : null,
                disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
                ariaLabel: el.getAttribute('aria-label')
            })),
            disclosureTriggers: document.querySelectorAll('button[aria-expanded]').length,
            visiblePanels: panels.length,
            progressBars: document.querySelectorAll('[role="progressbar"]').length
        }
    })
}

// Dump the REAL structure the streak selectors depend on, so we can replace the
// fragile img[src*="Fire"] / input[role="switch"] assumptions with evidence.
async function probeStreakSelectors(page) {
    return page.evaluate(() => {
        const snap = document.querySelector('section#snapshot')
        const root = snap || document
        const imgs = Array.from(root.querySelectorAll('img')).slice(0, 20).map(img => ({
            alt: img.getAttribute('alt'),
            src: (img.getAttribute('src') || '').slice(0, 90),
            srcset: (img.getAttribute('srcset') || '').slice(0, 90)
        }))
        // Any switch/toggle-like control, regardless of the exact pattern used.
        const toggles = Array.from(
            document.querySelectorAll('[role="switch"], input[type="checkbox"], label.react-aria-Checkbox, [data-rac][aria-checked]')
        ).slice(0, 20).map(el => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            type: el.getAttribute('type'),
            ariaChecked: el.getAttribute('aria-checked'),
            ariaLabel: el.getAttribute('aria-label'),
            dataRac: el.hasAttribute('data-rac'),
            checked: typeof el.checked === 'boolean' ? el.checked : null
        }))
        const snapshotButtons = Array.from(root.querySelectorAll('button[aria-expanded]')).slice(0, 12).map(b => ({
            ariaLabel: b.getAttribute('aria-label'),
            ariaExpanded: b.getAttribute('aria-expanded'),
            slot: b.getAttribute('slot'),
            hasImg: Boolean(b.querySelector('img'))
        }))
        return { snapshotPresent: Boolean(snap), imgs, toggles, snapshotButtons }
    })
}

// Best-effort: expand the snapshot section then open the first inner card, so the
// streak side panel (and its real toggle) is in the DOM when we probe again.
async function openStreakPanel(page) {
    return page.evaluate(() => {
        const isVisible = el => {
            const rect = el.getBoundingClientRect()
            const style = window.getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        }
        const snapshot = document.querySelector('section#snapshot')
        if (!snapshot) return { expanded: false, opened: false }

        const trigger = snapshot.querySelector('button[slot="trigger"][aria-expanded="false"]')
        if (trigger) trigger.click()

        // Try the legacy 'Fire' image token first, then fall back to the first
        // pressable card inside the snapshot section (token-agnostic).
        const images = Array.from(snapshot.querySelectorAll('img[src], img[srcset], img[alt]'))
        const fire = images.find(img => {
            const src = img.getAttribute('src') ?? ''
            const srcset = img.getAttribute('srcset') ?? ''
            const alt = img.getAttribute('alt') ?? ''
            return src.includes('Fire') || srcset.includes('Fire') || /fire|streak/i.test(alt)
        })
        let card = fire?.closest('button[aria-expanded], button[data-rac], a[data-rac]')
        if (!card) {
            card =
                Array.from(
                    snapshot.querySelectorAll('button[data-rac][aria-expanded]:not([slot="trigger"])')
                ).find(isVisible) || null
        }
        if (!card || !isVisible(card)) return { expanded: Boolean(trigger), opened: false, usedFireToken: Boolean(fire) }
        card.click()
        return { expanded: Boolean(trigger), opened: true, usedFireToken: Boolean(fire) }
    })
}

async function gotoQuiet(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await page.waitForTimeout(3500)
}

// Reuse the bot's saved session (same accounts as `npm start`) so NO manual login
// is needed. Sessions live under sessions/<email>/ as patchright cookie dumps.
// Microsoft auth cookies are domain-scoped (live.com / bing.com), so the mobile
// cookie jar authenticates a desktop context to rewards.bing.com just fine.
// Override the chosen account with MSRB_DIAG_EMAIL=<email>.
function loadCookieSession() {
    const sessionsRoot = path.join(process.cwd(), 'sessions')
    const wanted = process.env.MSRB_DIAG_EMAIL
    const readJson = file => {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
            return null
        }
    }

    let dirs = []
    try {
        dirs = fs
            .readdirSync(sessionsRoot, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name !== 'dashboard-live-diagnostics')
            .map(d => d.name)
    } catch {
        return null
    }
    if (wanted) dirs = dirs.filter(d => d === wanted)

    // Rank candidates so a REAL, enrolled account wins over placeholders like
    // "email_1": prefer a folder whose name is an email AND that has a saved
    // localStorage dump (only real, used accounts accumulate one), then by
    // cookie count. A desktop jar slightly outranks a mobile one.
    const candidates = []
    for (const email of dirs) {
        const dir = path.join(sessionsRoot, email)
        for (const variant of ['desktop', 'mobile']) {
            const cookieFile = path.join(dir, `session_${variant}.json`)
            if (!fs.existsSync(cookieFile)) continue
            const cookies = readJson(cookieFile)
            if (!Array.isArray(cookies) || cookies.length === 0) continue
            const storageFile = path.join(dir, `session_storage_${variant}.json`)
            const storage = fs.existsSync(storageFile) ? readJson(storageFile) : null
            const hasStorage = Array.isArray(storage) && storage.length > 0
            const score =
                (email.includes('@') ? 1_000_000 : 0) +
                (hasStorage ? 100_000 : 0) +
                cookies.length +
                (variant === 'desktop' ? 50 : 0)
            candidates.push({ email, variant, cookies, storage: hasStorage ? storage : [], score })
        }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.score - a.score)
    return candidates[0]
}

async function restoreLocalStorage(context, storage) {
    for (const origin of storage || []) {
        if (!origin || !origin.origin || !Array.isArray(origin.localStorage) || origin.localStorage.length === 0) {
            continue
        }
        const page = await context.newPage()
        try {
            await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
            await page.evaluate(items => {
                for (const it of items) {
                    try {
                        localStorage.setItem(it.name, it.value)
                    } catch {}
                }
            }, origin.localStorage)
        } finally {
            await page.close().catch(() => {})
        }
    }
}

async function main() {
    if (process.env.MSRB_LIVE_DASHBOARD !== '1') {
        console.error('Refusing to run live diagnostics. Set MSRB_LIVE_DASHBOARD=1 first.')
        process.exit(1)
    }

    const writeEnabled = process.env.MSRB_LIVE_DASHBOARD_WRITE === '1'
    const headless = process.env.MSRB_LIVE_DASHBOARD_HEADLESS === '1'
    const session = loadCookieSession()

    let browser = null
    let context
    if (session) {
        console.error(
            `[diag] Reusing saved ${session.variant} session for ${session.email} ` +
                `(${session.cookies.length} cookies) — no manual login needed.`
        )
        browser = await chromium.launch({ headless, args: ['--no-sandbox'] })
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        try {
            await context.addCookies(session.cookies)
        } catch (err) {
            // A single malformed cookie rejects the whole batch — retry per-cookie.
            console.error('[diag] bulk addCookies failed, retrying per-cookie:', err.message)
            let ok = 0
            for (const c of session.cookies) {
                try {
                    await context.addCookies([c])
                    ok++
                } catch {}
            }
            console.error(`[diag] added ${ok}/${session.cookies.length} cookies individually`)
        }
        await restoreLocalStorage(context, session.storage)
    } else {
        console.error(
            '[diag] No saved session under sessions/. Falling back to manual-login persistent profile ' +
                '(set MSRB_LIVE_DASHBOARD_INTERACTIVE=1 and log in within the opened browser).'
        )
        const userDataDir = path.join(process.cwd(), 'sessions', 'dashboard-live-diagnostics')
        fs.mkdirSync(userDataDir, { recursive: true })
        context = await chromium.launchPersistentContext(userDataDir, {
            headless,
            viewport: { width: 1280, height: 900 }
        })
    }

    try {
        const page = context.pages()[0] ?? (await context.newPage())
        const capture = attachNetworkCapture(page)

        await gotoQuiet(page, DASHBOARD_URL)

        let before = await readDomSignals(page)
        if (!before.dashboardReady && process.env.MSRB_LIVE_DASHBOARD_INTERACTIVE === '1') {
            console.error(
                'Dashboard is not ready yet. Finish login/welcome in the opened browser; diagnostics will retry in 120 seconds.'
            )
            await page.waitForTimeout(120000)
            await gotoQuiet(page, DASHBOARD_URL)
            before = await readDomSignals(page)
        }

        // Settle the CSR-vs-RSC question on the dashboard first.
        const dashboardRsc = await readRscPresence(page)
        const html = await page.content()
        const rsc = analyzeSavedPage(html)
        const streakBeforeOpen = await probeStreakSelectors(page)
        const openedStreakPanel = await openStreakPanel(page)
        await page.waitForTimeout(1500)
        const afterOpen = await readDomSignals(page)
        const streakAfterOpen = await probeStreakSelectors(page)

        // Visit /earn too: it carries the full activity set (daily set + more
        // activities) and is where reportActivity data must come from.
        await gotoQuiet(page, EARN_URL)
        const earnRsc = await readRscPresence(page)
        const earnSignals = await readDomSignals(page)

        // Give late XHR/fetch calls a moment to land in the capture buffer.
        await page.waitForTimeout(2500)

        const dataResponses = capture.responses.filter(r => r.hasData)
        const verdict = dashboardRsc.next_f || earnRsc.next_f
            ? 'RSC-INLINE: self.__next_f present in live DOM — HTML/flight parsing should work; investigate why prod parse fails (auth? selector of userStatus?).'
            : dataResponses.length > 0
              ? 'CSR-NETWORK: no inline flight data, but dashboard data arrives via JSON network response(s) — bot should INTERCEPT these endpoints instead of parsing HTML.'
              : 'INCONCLUSIVE: neither inline flight data nor an obvious JSON data endpoint captured — rerun logged-in, or widen capture.'

        console.log(
            JSON.stringify(
                {
                    verdict,
                    writeEnabled,
                    before,
                    dashboardRsc,
                    earnRsc,
                    earnSignals: {
                        url: earnSignals.url,
                        dashboardReady: earnSignals.dashboardReady,
                        disclosureTriggers: earnSignals.disclosureTriggers
                    },
                    rscAnalyzer: {
                        kind: rsc.kind,
                        route: rsc.route,
                        modelTypes: rsc.modelTypes,
                        activityCount: rsc.activities?.length,
                        diagnostics: rsc.diagnostics,
                        problems: rsc.problems
                    },
                    network: {
                        capturedCount: capture.responses.length,
                        dataResponses,
                        actionPosts: capture.actionPosts
                    },
                    streak: {
                        beforeOpen: streakBeforeOpen,
                        openedStreakPanel,
                        afterOpen: streakAfterOpen
                    },
                    nextAction: before.welcomePage
                        ? 'Finish the Microsoft Rewards welcome/onboarding page in the opened browser, then rerun.'
                        : before.dashboardReady
                          ? 'Dashboard detected — see verdict above.'
                          : 'Dashboard not detected. Ensure this session is logged in to https://rewards.bing.com/dashboard.',
                    afterOpen
                },
                null,
                2
            )
        )
    } finally {
        await context.close().catch(() => {})
        if (browser) await browser.close().catch(() => {})
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
