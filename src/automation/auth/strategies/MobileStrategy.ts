import { randomBytes } from 'crypto'
import type { Frame, Page, Request } from 'patchright'
import { URLSearchParams } from 'url'

import type { MicrosoftRewardsBot } from '../../../index'
import type { Account } from '../../../types/Account'
import { EmailStrategy } from './EmailStrategy'
import { TotpStrategy } from './TotpStrategy'

export class MobileStrategy {
    private clientId = '0000000040170455'
    private authUrl = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
    private maxTimeout = 420_000 // Slow proxies and Docker logins can take several minutes.

    // Selectors for handling Passkey prompt during OAuth
    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        otherWaysToSignIn: '[data-testid="viewFooter"] [role="button"]',
        passwordIcon: '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"])',
        passwordEntry: '[data-testid="passwordEntry"], input[type="password"]',
        totpInput: 'input[name="otc"], form[name="OneTimeCodeViewForm"]',
        passKeyError: '[data-testid="registrationImg"]',
        passKeyVideo: '[data-testid="biometricVideo"]'
    } as const

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page
    ) {}

    /**
     * Strip the query string (which on oauth20_desktop.srf carries the live OAuth
     * `code`) before logging a URL. The code is exchangeable for an MBI_SSL token
     * with only the public clientId, so it must never reach the logs/buffer.
     */
    private safeUrl(raw: string): string {
        try {
            const u = new URL(raw)
            return `${u.origin}${u.pathname}`
        } catch {
            return raw.split('?')[0] ?? raw
        }
    }

    private async checkSelector(selector: string): Promise<boolean> {
        return this.page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    private async handlePasskeyPrompt(): Promise<void> {
        try {
            // Handle Passkey prompt - click secondary button to skip
            const hasPasskeyError = await this.checkSelector(this.selectors.passKeyError)
            const hasPasskeyVideo = await this.checkSelector(this.selectors.passKeyVideo)
            if (hasPasskeyError || hasPasskeyVideo) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Found Passkey prompt on OAuth page, skipping')
                await this.bot.browser.utils.ghostClick(this.page, this.selectors.secondaryButton)
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }
        } catch {
            // Ignore errors in prompt handling
        }
    }

    private async handleInteractivePrompt(account?: Account): Promise<void> {
        try {
            const url = new URL(this.page.url())
            const isPasskeyInterrupt = url.hostname === 'account.live.com' && url.pathname.includes('/interrupt/passkey')

            if (isPasskeyInterrupt) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Passkey enrollment interrupt detected during mobile OAuth')
            }

            if (await this.checkSelector(this.selectors.passKeyError)) {
                await this.handlePasskeyPrompt()
                return
            }

            if (await this.checkSelector(this.selectors.passKeyVideo)) {
                await this.handlePasskeyPrompt()
                return
            }

            if (isPasskeyInterrupt && (await this.checkSelector(this.selectors.secondaryButton))) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Skipping passkey enrollment during mobile OAuth')
                await this.bot.browser.utils.ghostClick(this.page, this.selectors.secondaryButton)
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                await this.bot.utils.wait(2000)
                return
            }

            if (account?.totpSecret && (await this.checkSelector(this.selectors.totpInput))) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'TOTP prompt detected during mobile OAuth')
                await new TotpStrategy(this.bot).handle(this.page, account.totpSecret)
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                return
            }

            if (account?.password && (await this.checkSelector(this.selectors.passwordEntry))) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Password prompt detected during mobile OAuth')
                await new EmailStrategy(this.bot).enterPassword(this.page, account.password)
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                return
            }

            const passwordTile = this.page.locator(this.selectors.passwordIcon).first()
            if (account?.password && (await passwordTile.isVisible().catch(() => false))) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Selecting password method during mobile OAuth')
                await passwordTile.click().catch(async () => {
                    await this.bot.browser.utils.ghostClick(this.page, this.selectors.passwordIcon)
                })
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                return
            }

            const otherWaysButtons = this.page.locator(this.selectors.otherWaysToSignIn)
            const otherWaysCount = await otherWaysButtons.count().catch(() => 0)
            const otherWays = otherWaysCount > 0 ? otherWaysButtons.nth(otherWaysCount - 1) : otherWaysButtons.first()
            if (await otherWays.isVisible().catch(() => false)) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Selecting alternative sign-in methods during mobile OAuth')
                await otherWays.click().catch(async () => {
                    await this.bot.browser.utils.ghostClick(this.page, this.selectors.otherWaysToSignIn)
                })
                await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Interactive OAuth prompt handler skipped: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    async get(email: string, account?: Account): Promise<string> {
        try {
            const authorizeUrl = new URL(this.authUrl)
            authorizeUrl.searchParams.append('response_type', 'code')
            authorizeUrl.searchParams.append('client_id', this.clientId)
            authorizeUrl.searchParams.append('redirect_uri', this.redirectUrl)
            authorizeUrl.searchParams.append('scope', this.scope)
            authorizeUrl.searchParams.append('state', randomBytes(16).toString('hex'))
            authorizeUrl.searchParams.append('access_type', 'offline_access')
            authorizeUrl.searchParams.append('login_hint', email)

            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Auth URL constructed: ${authorizeUrl.origin}${authorizeUrl.pathname}`
            )

            await this.bot.browser.utils.disableFido(this.page)

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Navigating to OAuth authorize URL')

            // Capture the authorization code the instant the browser hits
            // oauth20_desktop.srf?code=..., BEFORE Microsoft's anti-phishing script
            // rewrites the visible URL to "?removed=true" and shows the "page not
            // normally shown / never ask you to copy this URL" notice. The 1s poll
            // below routinely misses that transient code URL, which left many users
            // stuck on the notice page until the 7-minute timeout. Navigation and
            // request events fire synchronously with the redirect, so they catch the
            // code even when the URL bar is scrubbed milliseconds later.
            let code = ''
            const tryCaptureCode = (rawUrl: string): void => {
                if (code) return
                try {
                    const u = new URL(rawUrl)
                    if (u.hostname === 'login.live.com' && u.pathname === '/oauth20_desktop.srf') {
                        const c = u.searchParams.get('code')
                        if (c) {
                            code = c
                            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'OAuth code captured from navigation event')
                        }
                    }
                } catch {
                    // Non-URL navigation target — ignore.
                }
            }
            const onFrameNavigated = (frame: Frame): void => {
                if (frame === this.page.mainFrame()) tryCaptureCode(frame.url())
            }
            const onRequest = (request: Request): void => tryCaptureCode(request.url())
            this.page.on('framenavigated', onFrameNavigated)
            this.page.on('request', onRequest)

            const start = Date.now()
            try {
                await this.page.goto(authorizeUrl.href).catch(err => {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN-APP',
                        `page.goto() failed: ${err instanceof Error ? err.message : String(err)}`
                    )
                })

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Waiting for mobile OAuth code...')

                let lastUrl = ''

                while (!code && Date.now() - start < this.maxTimeout) {
                    const currentUrl = this.page.url()

                    // Log only when URL changes (high signal, no spam). Never log the
                    // query string — it may carry the OAuth `code`.
                    if (currentUrl !== lastUrl) {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', `OAuth poll URL changed → ${this.safeUrl(currentUrl)}`)
                        lastUrl = currentUrl
                    }

                    try {
                        // Fallback: the visible URL may still carry the code on flows
                        // where the anti-phishing rewrite did not run.
                        tryCaptureCode(currentUrl)
                        if (code) break

                        await this.handleInteractivePrompt(account)
                    } catch (err) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            `Invalid URL while polling: ${this.safeUrl(String(currentUrl))}`
                        )
                    }

                    await this.bot.utils.wait(1000)
                }
            } finally {
                this.page.off('framenavigated', onFrameNavigated)
                this.page.off('request', onRequest)
            }

            if (!code) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Timed out waiting for OAuth code after ${Math.round((Date.now() - start) / 1000)}s`
                )

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', `Final page URL: ${this.safeUrl(this.page.url())}`)

                return ''
            }

            const data = new URLSearchParams()
            data.append('grant_type', 'authorization_code')
            data.append('client_id', this.clientId)
            data.append('code', code)
            data.append('redirect_uri', this.redirectUrl)

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Exchanging OAuth code for access token')

            const response = await this.bot.axios.request({
                url: this.tokenUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data.toString()
            })

            const token = (response?.data?.access_token as string) ?? ''

            if (!token) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-APP', 'No access_token in token response')
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Token response payload: ${JSON.stringify(response?.data)}`
                )
                return ''
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Mobile access token received')
            return token
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-APP',
                `MobileAccess error: ${error instanceof Error ? error.stack || error.message : String(error)}`
            )
            return ''
        } finally {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Returning to base URL')
            await this.page.goto(this.bot.config.baseURL, { timeout: 10000 }).catch(() => {})
        }
    }
}
