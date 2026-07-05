const fs = require('fs')
const path = require('path')
const { chromium } = require('patchright')

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard'

const CLAIM_CARD_SELECTOR = [
    'div.cursor-pointer:has(img[src*="CoinsTransparent"])',
    'button[data-rac][aria-expanded]:has(img[src*="CoinsTransparent"])',
    'div.cursor-pointer:has(img[src*="Coins"])',
    'button[data-rac][aria-expanded]:has(img[src*="Coins"])',
    'div.cursor-pointer:has(img[alt*="claim" i])',
    'button[data-rac][aria-expanded]:has(img[alt*="claim" i])',
    'div.cursor-pointer:has(img[alt*="réclamer" i])',
    'button[data-rac][aria-expanded]:has(img[alt*="réclamer" i])',
    'div.cursor-pointer:has(img[alt*="récupérer" i])',
    'button[data-rac][aria-expanded]:has(img[alt*="récupérer" i])'
].join(', ')

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function loadCookieSession() {
    const sessionsRoot = path.join(process.cwd(), 'sessions')
    const wanted = process.env.MSRB_DIAG_EMAIL
    let dirs = []

    try {
        dirs = fs
            .readdirSync(sessionsRoot, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.includes('@'))
            .map(d => d.name)
    } catch {
        return null
    }

    if (wanted) dirs = dirs.filter(d => d === wanted)

    const candidates = []
    for (const email of dirs) {
        const dir = path.join(sessionsRoot, email)
        for (const variant of ['mobile', 'desktop']) {
            const cookieFile = path.join(dir, `session_${variant}.json`)
            const cookies = readJson(cookieFile)
            if (!Array.isArray(cookies) || cookies.length === 0) continue

            const storageFile = path.join(dir, `session_storage_${variant}.json`)
            const storage = readJson(storageFile)
            candidates.push({
                email,
                variant,
                cookies,
                storage: Array.isArray(storage) ? storage : [],
                score:
                    (email.includes('@') ? 1_000_000 : 0) +
                    (Array.isArray(storage) && storage.length > 0 ? 100_000 : 0) +
                    cookies.length +
                    (variant === 'mobile' ? 50 : 0)
            })
        }
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates[0] ?? null
}

async function restoreLocalStorage(context, storage) {
    for (const origin of storage || []) {
        if (!origin?.origin || !Array.isArray(origin.localStorage) || origin.localStorage.length === 0) continue
        const page = await context.newPage()
        try {
            await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
            await page.evaluate(items => {
                for (const item of items) {
                    try {
                        localStorage.setItem(item.name, item.value)
                    } catch {}
                }
            }, origin.localStorage)
        } finally {
            await page.close().catch(() => {})
        }
    }
}

async function snapshotClaimUi(page) {
    return page.evaluate(selector => {
        const visible = el => {
            const rect = el.getBoundingClientRect()
            const style = window.getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        }
        const simplify = el => {
            const rect = el.getBoundingClientRect()
            return {
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                ariaLabel: el.getAttribute('aria-label'),
                ariaExpanded: el.getAttribute('aria-expanded'),
                dataRac: el.hasAttribute('data-rac'),
                pressable: el.getAttribute('data-react-aria-pressable'),
                slot: el.getAttribute('slot'),
                role: el.getAttribute('role'),
                className: String(el.getAttribute('class') || '').slice(0, 140),
                href: el.getAttribute('href'),
                rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            }
        }

        const claimCards = Array.from(document.querySelectorAll(selector)).filter(visible).map(simplify)
        const panels = Array.from(
            document.querySelectorAll('[role="dialog"], .react-aria-DisclosurePanel:not([hidden])')
        ).filter(visible)
        const panelButtons = panels.flatMap(panel =>
            Array.from(panel.querySelectorAll('button, a, [data-react-aria-pressable="true"]')).filter(visible).map(simplify)
        )
        const allVisibleButtons = Array.from(document.querySelectorAll('button, a, [data-react-aria-pressable="true"]'))
            .filter(visible)
            .slice(0, 80)
            .map(simplify)
        const images = Array.from(document.querySelectorAll('img'))
            .filter(visible)
            .slice(0, 40)
            .map(img => ({
                alt: img.getAttribute('alt'),
                src: (img.getAttribute('src') || '').slice(0, 120),
                srcset: (img.getAttribute('srcset') || '').slice(0, 120),
                nearestButtonText: (img.closest('button,a,[data-react-aria-pressable="true"]')?.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 100)
            }))

        return {
            url: location.href,
            title: document.title,
            dashboardReady: Boolean(document.querySelector('section#snapshot, section#dailyset')),
            claimCards,
            panels: panels.map(simplify),
            panelButtons,
            allVisibleButtons,
            images
        }
    }, CLAIM_CARD_SELECTOR)
}

async function main() {
    if (process.env.MSRB_LIVE_CLAIM_DIAG !== '1') {
        console.error('Refusing to run live claim diagnostics. Set MSRB_LIVE_CLAIM_DIAG=1 first.')
        process.exit(1)
    }

    const session = loadCookieSession()
    if (!session) {
        console.error('No saved session found under sessions/.')
        process.exit(1)
    }

    console.error(`[claim-diag] Reusing saved ${session.variant} session for ${session.email}`)

    const browser = await chromium.launch({
        headless: process.env.MSRB_LIVE_CLAIM_DIAG_HEADLESS !== '0',
        args: ['--no-sandbox']
    })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })

    try {
        await context.addCookies(session.cookies)
        await restoreLocalStorage(context, session.storage)
        const page = await context.newPage()

        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined)
        await page.waitForTimeout(4000)

        const before = await snapshotClaimUi(page)

        const clickedCard = await page.evaluate(selector => {
            const visible = el => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
            }
            const matches = Array.from(document.querySelectorAll(selector)).filter(visible)
            const direct =
                matches.find(el => el.tagName.toLowerCase() === 'button' && el.getAttribute('aria-expanded') !== null) ??
                matches.find(el => el.tagName.toLowerCase() === 'button') ??
                matches[0]
            const fallback = Array.from(document.querySelectorAll('button[data-rac][aria-expanded], div.cursor-pointer'))
                .filter(visible)
                .find(el => /claim|réclamer|récupérer|ready/i.test(el.textContent || ''))
            const card = direct || fallback
            if (!card) return { clicked: false, reason: 'no claim card candidate' }
            card.click()
            return {
                clicked: true,
                reason: direct ? 'premium selector matched' : 'text fallback matched',
                text: (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
                ariaExpanded: card.getAttribute('aria-expanded')
            }
        }, CLAIM_CARD_SELECTOR)

        await page.waitForTimeout(2500)
        const after = await snapshotClaimUi(page)

        console.log(JSON.stringify({ session: { email: session.email, variant: session.variant }, clickedCard, before, after }, null, 2))
    } finally {
        await context.close().catch(() => {})
        await browser.close().catch(() => {})
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
