import { CheerioAPI, load } from 'cheerio'
import { ClickOptions, createCursor } from 'ghost-cursor-playwright-port'
import { type BrowserContext, type Page } from 'patchright'

import type { MicrosoftRewardsBot } from '../index'
import { COOKIE_CONSENT } from './DashboardSelectors'

export default class AutomationUtils {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async tryDismissAllMessages(page: Page): Promise<void> {
        try {
            // -----------------------------------------------------------------
            // Buttons shared by BOTH legacy and new dashboard / Bing pages.
            // We keep legacy selectors as fallbacks since not all users have
            // been migrated yet, and Bing search pages still use the old UI.
            // -----------------------------------------------------------------
            const buttons = [
                // --- Legacy dashboard / Bing selectors (still needed on bing.com) ---
                { selector: '#acceptButton', label: 'AcceptButton' },
                { selector: '.ext-secondary.ext-button', label: '"Skip for now" Button' },
                { selector: '#iLandingViewAction', label: 'iLandingViewAction' },
                { selector: '#iShowSkip', label: 'iShowSkip' },
                { selector: '#iNext', label: 'iNext' },
                { selector: '#iLooksGood', label: 'iLooksGood' },
                { selector: '#idSIButton9', label: 'idSIButton9' },
                { selector: '.ms-Button.ms-Button--primary', label: 'Primary Button' },
                { selector: '.c-glyph.glyph-cancel', label: 'Mobile Welcome Button' },
                { selector: '.maybe-later', label: 'Mobile Rewards App Banner' },
                { selector: '#bnp_btn_accept', label: 'Bing Cookie Banner' },
                { selector: '#reward_pivot_earn', label: 'Reward Coupon Accept' },

                // --- WCP Cookie Consent Banner (shared by dashboard + bing.com) ---
                { selector: COOKIE_CONSENT.acceptButton, label: 'WCP Cookie Accept' }
            ]

            const checkVisible = await Promise.allSettled(
                buttons.map(async b => ({
                    ...b,
                    isVisible: await page
                        .locator(b.selector)
                        .first()
                        .isVisible()
                        .catch(() => false)
                }))
            )

            const visibleButtons = checkVisible
                .filter(r => r.status === 'fulfilled' && r.value.isVisible)
                .map(r => (r.status === 'fulfilled' ? r.value : null))
                .filter(Boolean)

            if (visibleButtons.length > 0) {
                await Promise.allSettled(
                    visibleButtons.map(async b => {
                        if (b) {
                            const clicked = await this.ghostClick(page, b.selector)
                            if (clicked) {
                                this.bot.logger.debug(
                                    this.bot.isMobile,
                                    'DISMISS-ALL-MESSAGES',
                                    `Dismissed: ${b.label}`
                                )
                            }
                        }
                    })
                )
                await this.bot.utils.wait(300)
            }

            // --- Legacy Bing overlay (still present on bing.com search pages) ---
            const overlay = await page.$('#bnp_overlay_wrapper')
            if (overlay) {
                const rejected = await this.ghostClick(page, '#bnp_btn_reject, button[aria-label*="Reject" i]')
                if (rejected) {
                    this.bot.logger.debug(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Bing Overlay Reject')
                } else {
                    const accepted = await this.ghostClick(page, '#bnp_btn_accept')
                    if (accepted) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'DISMISS-ALL-MESSAGES',
                            'Dismissed: Bing Overlay Accept'
                        )
                    }
                }
                await this.bot.utils.wait(250)
            }

            // --- WCP Consent Banner (loads asynchronously via external script) ---
            await this.dismissWcpConsentBanner(page)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DISMISS-ALL-MESSAGES',
                `Handler error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Dismiss the WCP (Windows Cookie Platform) consent banner.
     *
     * The banner is injected asynchronously by an external Microsoft consent
     * SDK script, so it may not be in the DOM when the page first loads.
     * We wait up to 3 seconds for the container to appear, then click the
     * "Accepter" button (first button) to dismiss it.
     *
     * Structure:
     * ```
     * #wcpConsentBannerCtrl[role="alert"]
     *   div  (text + privacy links)
     *   div  (buttons: [Accepter] [Refuser] [Gérer les cookies])
     * ```
     */
    private async dismissWcpConsentBanner(page: Page): Promise<void> {
        try {
            // Wait for the banner container to appear (async script injection)
            const banner = await page
                .waitForSelector(COOKIE_CONSENT.banner, { state: 'attached', timeout: 3000 })
                .catch(() => null)

            if (!banner) return

            // Wait a bit for buttons to render inside the container
            await this.bot.utils.wait(500)

            // Strategy 1: ghost-cursor click on "Accepter" (first button)
            const accepted = await this.ghostClick(page, COOKIE_CONSENT.acceptButton)
            if (accepted) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'COOKIE-CONSENT',
                    'WCP consent banner dismissed (Accept via ghost-click)'
                )
                return
            }

            // Strategy 2: direct JS click fallback (some banners block programmatic interaction)
            const jsClicked = await page.evaluate(selector => {
                const btn = document.querySelector(selector) as HTMLButtonElement | null
                if (btn) {
                    btn.click()
                    return true
                }
                return false
            }, COOKIE_CONSENT.acceptButton)

            if (jsClicked) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'COOKIE-CONSENT',
                    'WCP consent banner dismissed (Accept via JS click)'
                )
                return
            }

            // Strategy 3: find any button with "Accepter" text inside the banner.
            // Uses IIFE string form so the obfuscator's string-array transform cannot
            // inject outer-scope wrapper references inside the evaluate callback.
            const textClicked = (await page.evaluate(
                `(function(){
                    var banner=document.getElementById('wcpConsentBannerCtrl');
                    if(!banner)return false;
                    var buttons=banner.querySelectorAll('button');
                    for(var i=0;i<buttons.length;i++){
                        var t=(buttons[i].textContent||'').trim().toLowerCase();
                        if(t.indexOf('accepter')!==-1||t.indexOf('accept')!==-1){
                            buttons[i].click();return true;
                        }
                    }
                    return false;
                })()`
            )) as boolean

            if (textClicked) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'COOKIE-CONSENT',
                    'WCP consent banner dismissed (Accept via text match)'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'COOKIE-CONSENT',
                    'WCP consent banner found but could not click Accept button'
                )
            }
        } catch {
            // Silently ignore – consent banner may not be present
        }
    }

    async getLatestTab(page: Page): Promise<Page> {
        try {
            const browser: BrowserContext = page.context()
            const pages = browser.pages()

            const newTab = pages[pages.length - 1]
            if (!newTab) {
                throw this.bot.logger.error(this.bot.isMobile, 'GET-NEW-TAB', 'No tabs could be found!')
            }

            return newTab
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-NEW-TAB',
                `Unable to get latest tab: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async reloadBadPage(page: Page): Promise<boolean> {
        try {
            const html = await page.content().catch(() => '')
            const $ = load(html)

            if ($('body.neterror').length) {
                this.bot.logger.info(this.bot.isMobile, 'RELOAD-BAD-PAGE', 'Bad page detected, reloading!')
                try {
                    await page.reload({ waitUntil: 'load' })
                } catch {
                    await page.reload().catch(() => {})
                }
                return true
            } else {
                return false
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'RELOAD-BAD-PAGE',
                `Reload check failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return true
        }
    }

    async closeTabs(page: Page, config = { minTabs: 1, maxTabs: 1 }): Promise<Page> {
        try {
            const browser = page.context()
            const tabs = browser.pages()

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-CLOSE-TABS',
                `Found ${tabs.length} tab(s) open (min: ${config.minTabs}, max: ${config.maxTabs})`
            )

            // Check if valid
            if (config.minTabs < 1 || config.maxTabs < config.minTabs) {
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'Invalid config, using defaults')
                config = { minTabs: 1, maxTabs: 1 }
            }

            // Close if more than max config
            if (tabs.length > config.maxTabs) {
                const tabsToClose = tabs.slice(config.maxTabs)

                const closeResults = await Promise.allSettled(tabsToClose.map(tab => tab.close()))

                const closedCount = closeResults.filter(r => r.status === 'fulfilled').length
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-CLOSE-TABS',
                    `Closed ${closedCount}/${tabsToClose.length} excess tab(s) to reach max of ${config.maxTabs}`
                )

                // Open more tabs
            } else if (tabs.length < config.minTabs) {
                const tabsNeeded = config.minTabs - tabs.length
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-CLOSE-TABS',
                    `Opening ${tabsNeeded} tab(s) to reach min of ${config.minTabs}`
                )

                const newTabPromises = Array.from({ length: tabsNeeded }, async () => {
                    try {
                        const newPage = await browser.newPage()
                        await newPage.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 })
                        return newPage
                    } catch (error) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SEARCH-CLOSE-TABS',
                            `Failed to create new tab: ${error instanceof Error ? error.message : String(error)}`
                        )
                        return null
                    }
                })

                await Promise.allSettled(newTabPromises)
            }

            const latestTab = await this.getLatestTab(page)
            return latestTab
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-CLOSE-TABS',
                `Error: ${error instanceof Error ? error.message : String(error)}`
            )
            return page
        }
    }

    async loadInCheerio(data: Page | string): Promise<CheerioAPI> {
        const html: string = typeof data === 'string' ? data : await data.content()
        const $ = load(html)
        return $
    }

    async ghostClick(page: Page, selector: string, options?: ClickOptions): Promise<boolean> {
        try {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GHOST-CLICK',
                `Trying to click selector: ${selector}, options: ${JSON.stringify(options)}`
            )

            // Wait for selector to exist before clicking
            await page.waitForSelector(selector, { timeout: 1000 }).catch(() => {})

            const cursor = createCursor(page as any)
            await cursor.click(selector, options)

            return true
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GHOST-CLICK',
                `Failed for ${selector}: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async disableFido(page: Page) {
        // ── Intercept GetCredentialType — declare isFidoSupported=false ──────
        // This prevents Microsoft login from offering passkey as a sign-in method.
        const credentialTypePattern = '**/GetCredentialType.srf*'
        await page.route(credentialTypePattern, route => {
            try {
                const request = route.request()
                const postData = request.postData()
                const body = postData ? JSON.parse(postData) : {}

                body.isFidoSupported = false

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DISABLE-FIDO',
                    `Modified GetCredentialType: isFidoSupported → false`
                )

                route.continue({
                    postData: JSON.stringify(body),
                    headers: {
                        ...request.headers(),
                        'Content-Type': 'application/json'
                    }
                })
            } catch (error) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DISABLE-FIDO',
                    `GetCredentialType intercept error: ${error instanceof Error ? error.message : String(error)}`
                )
                route.continue()
            }
        })

        // ── Intercept WebAuthn passkey creation/get requests — abort them ───
        // These endpoints are called when the browser tries to create or retrieve
        // a passkey through the platform authenticator (triggers Windows Security dialog).
        //
        // Do not block top-level document navigations such as
        // account.live.com/interrupt/passkey/enroll. Microsoft renders a regular
        // page there with a skip button; blocking that document leaves Chromium on
        // ERR_BLOCKED_BY_CLIENT and prevents the login state machine from recovering.
        const webauthnPatterns = [
            '**/webauthn/**',
            '**/passkey/**',
            '**GetAssertionFromPlatformAuthenticator**',
            '**CreateCredentialFromPlatformAuthenticator**'
        ]

        for (const pattern of webauthnPatterns) {
            await page.route(pattern, route => {
                const request = route.request()
                if (request.resourceType() === 'document') {
                    route.continue()
                    return
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DISABLE-FIDO',
                    `Blocked WebAuthn request: ${request.url()}`
                )
                route.abort('blockedbyclient')
            })
        }
    }
}
