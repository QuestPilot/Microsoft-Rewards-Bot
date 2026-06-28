/*
 * Full Rewards page capture for selector/data maintenance.
 *
 * Plain "Save page as" only writes the static shell, so it loses the
 * authenticated RSC data and may save the wrong route/locale. This script
 * reuses the diagnostics session, walks every Rewards route, safely expands
 * every disclosure/side-panel (only `aria-expanded` buttons — never links,
 * logout, or redeem actions), and saves three layers for offline analysis:
 *
 *   diagnostics/capture/<route>.html         full rendered DOM (post-hydration)
 *   diagnostics/capture/<route>.flight.txt   unescaped RSC flight (data models)
 *   diagnostics/capture/<route>.png          screenshot (sanity check)
 *   diagnostics/capture/network.har          every XHR/fetch + response body
 *   diagnostics/capture/summary.json         per-page signals + analyzer output
 *
 * Read-only: it never toggles switches or submits anything.
 *
 * Usage (login is interactive, in the locale you want captured — English):
 *   $env:MSRB_LIVE_DASHBOARD="1"; npm run capture:pages
 * If the dashboard is not ready (login/welcome), it waits 120s for you to
 * finish in the opened browser, then continues.
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('patchright')
const { analyzeSavedPage, extractNextFlightTextFromHtml } = require('./rewards-page-analyzer')

const BASE = 'https://rewards.bing.com'

// Captured in order. Keep to first-party Rewards routes; the HAR records the
// data-bearing API/server-action calls regardless of which page triggers them.
const ROUTES = [
    { name: 'dashboard', url: `${BASE}/dashboard` },
    { name: 'earn', url: `${BASE}/earn` },
    { name: 'redeem', url: `${BASE}/redeem` },
    { name: 'about', url: `${BASE}/about` },
    { name: 'refer', url: `${BASE}/refer` }
]

function outDir() {
    const dir = path.join(process.cwd(), 'diagnostics', 'capture')
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

async function waitForNetworkIdle(page) {
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}

/**
 * Reveal all collapsed content without navigating away: expand every
 * `aria-expanded="false"` button and advance the offers carousel. Several
 * passes catch panels that only mount once their parent expands.
 */
async function expandEverything(page) {
    for (let pass = 0; pass < 4; pass++) {
        const expandedCount = await page
            .evaluate(() => {
                const isVisible = el => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                }
                let clicked = 0
                // Disclosure triggers + streak/claim cards are all buttons with aria-expanded.
                for (const btn of document.querySelectorAll('button[aria-expanded="false"]')) {
                    if (isVisible(btn)) {
                        btn.click()
                        clicked++
                    }
                }
                // Advance carousel slides so every banner card mounts.
                for (const btn of document.querySelectorAll('button[aria-label*="lide"], [role="radiogroup"] button[aria-pressed="false"]')) {
                    if (isVisible(btn)) btn.click()
                }
                return clicked
            })
            .catch(() => 0)

        await page.mouse.wheel(0, 4000).catch(() => {})
        await page.waitForTimeout(900)
        if (!expandedCount) break
    }
    // Scroll back to top so the screenshot is meaningful.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})
    await page.waitForTimeout(400)
}

async function domSignals(page) {
    return page
        .evaluate(() => ({
            url: location.href,
            route: location.pathname,
            title: document.title,
            lang: document.documentElement.getAttribute('lang'),
            disclosureTriggers: document.querySelectorAll('button[aria-expanded]').length,
            expandedPanels: document.querySelectorAll('.react-aria-DisclosurePanel:not([hidden])').length,
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            switches: document.querySelectorAll('input[role="switch"]').length,
            progressBars: document.querySelectorAll('[role="progressbar"]').length,
            sections: Array.from(document.querySelectorAll('section[id]')).map(s => s.id)
        }))
        .catch(() => ({}))
}

async function capturePage(page, route, dir) {
    await page.goto(route.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await waitForNetworkIdle(page)
    await page.waitForTimeout(1500)
    await expandEverything(page)

    const html = await page.content()
    const flight = extractNextFlightTextFromHtml(html)
    const analysis = analyzeSavedPage(html)
    const signals = await domSignals(page)

    fs.writeFileSync(path.join(dir, `${route.name}.html`), html, 'utf8')
    fs.writeFileSync(path.join(dir, `${route.name}.flight.txt`), flight, 'utf8')
    await page.screenshot({ path: path.join(dir, `${route.name}.png`), fullPage: true }).catch(() => {})

    return {
        name: route.name,
        signals,
        analysis: {
            kind: analysis.kind,
            route: analysis.route,
            modelTypes: analysis.modelTypes,
            actionIds: analysis.actionIds,
            activityCount: analysis.activities?.length ?? 0,
            diagnostics: analysis.diagnostics,
            problems: analysis.problems
        }
    }
}

async function main() {
    if (process.env.MSRB_LIVE_DASHBOARD !== '1') {
        console.error('Refusing to run. Set MSRB_LIVE_DASHBOARD=1 first.')
        process.exit(1)
    }

    const dir = outDir()
    const harPath = path.join(dir, 'network.har')
    const userDataDir = path.join(process.cwd(), 'sessions', 'dashboard-live-diagnostics')
    fs.mkdirSync(userDataDir, { recursive: true })

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 1600 },
        recordHar: { path: harPath, content: 'embed' }
    })

    try {
        const page = context.pages()[0] ?? (await context.newPage())

        // Make sure we are actually on the dashboard (logged in) before crawling.
        await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
        await waitForNetworkIdle(page)
        let ready = await page.evaluate(() => Boolean(document.querySelector('section#snapshot, section#dailyset'))).catch(() => false)

        if (!ready) {
            console.error('Dashboard not ready (login/welcome). Finish it in the opened browser — retrying in 120s.')
            await page.waitForTimeout(120_000)
            await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
            await waitForNetworkIdle(page)
            ready = await page.evaluate(() => Boolean(document.querySelector('section#snapshot, section#dailyset'))).catch(() => false)
        }

        const pages = []
        for (const route of ROUTES) {
            console.error(`Capturing ${route.name} ...`)
            pages.push(await capturePage(page, route, dir))
        }

        const summary = {
            generatedAt: new Date().toISOString(),
            dashboardReady: ready,
            outputDir: path.relative(process.cwd(), dir),
            harFile: path.relative(process.cwd(), harPath),
            pages
        }
        fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
        console.log(JSON.stringify(summary, null, 2))
    } finally {
        // Closing the context flushes the HAR to disk.
        await context.close()
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
