import type { AxiosRequestConfig } from 'axios'
import { URLS } from '../../../automation/DashboardSelectors'
import type { BasePromotion } from '../../../types/DashboardData'
import { TaskBase } from '../../TaskBase'

export class UrlReward extends TaskBase {
    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doUrlReward(promotion: BasePromotion) {
        const offerId = promotion.offerId

        // If no request token (new dashboard), use browser-based reportActivity
        if (!this.bot.requestToken) {
            return this.doUrlRewardViaBrowser(promotion)
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | oldBalance=${this.oldBalance}`
        )

        try {
            this.cookieHeader = this.bot.browser.func.buildCookieHeader(
                this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
                ['bing.com', 'live.com', 'microsoftonline.com']
            )

            const fingerprintHeaders = { ...this.bot.fingerprint.headers }
            delete fingerprintHeaders['Cookie']
            delete fingerprintHeaders['cookie']
            this.fingerprintHeader = fingerprintHeaders

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward headers | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            const formData = new URLSearchParams({
                id: offerId,
                hash: promotion.hash,
                timeZone: '60',
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: '',
                __RequestVerificationToken: this.bot.requestToken
            })

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward form data | offerId=${offerId} | hash=${promotion.hash} | timeZone=60 | activityAmount=1`
            )

            const request: AxiosRequestConfig = {
                url: URLS.reportActivity,
                method: 'POST',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                },
                data: formData
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Sending UrlReward request | offerId=${offerId} | url=${request.url}`
            )

            const response = await this.bot.axios.request(request)

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Received UrlReward response | offerId=${offerId} | status=${response.status}`
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Balance delta after UrlReward | offerId=${offerId} | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | status=${response.status} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Failed UrlReward with no points | offerId=${offerId} | status=${response.status} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD', `Waiting after UrlReward | offerId=${offerId}`)

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Browser-based fallback for the new Next.js dashboard where
     * `__RequestVerificationToken` is no longer embedded in the HTML.
     * Executes `fetch()` inside the Playwright page so session cookies
     * are attached automatically.
     */
    private async doUrlRewardViaBrowser(promotion: BasePromotion): Promise<void> {
        const offerId = promotion.offerId

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward (browser mode) | offerId=${offerId} | oldBalance=${this.oldBalance}`
        )

        try {
            const page = this.getActiveTaskPage()
            if (!page || page.isClosed()) {
                this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', 'Browser page not available, skipping')
                return
            }

            // Ensure we are on the /earn page so <script> tags contain RSC
            // flight data for ALL activities (Daily Set + More Promotions).
            // The /dashboard page only has Daily Set hashes, while /earn has everything.
            if (!page.url().includes('rewards.bing.com/earn')) {
                await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded' }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            const ok = await this.bot.browser.func.reportActivityViaBrowser(page, {
                offerId,
                hash: promotion.hash,
                destinationUrl: promotion.destinationUrl
            })

            if (ok) {
                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.gainedPoints = newBalance - this.oldBalance

                if (this.gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward (browser) | offerId=${offerId} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                // ── Fallback: navigate to destination URL (natural user flow) ──
                // When the Server Action fails, simulate the real user action:
                // click the daily set link → visit the destination → return to dashboard.
                // Microsoft credits the activity when the destination URL is visited.
                if (promotion.destinationUrl) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'URL-REWARD',
                        `Server Action failed, falling back to URL navigation | offerId=${offerId} | destination=${promotion.destinationUrl.slice(0, 80)}…`
                    )

                    try {
                        await page.goto(promotion.destinationUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 15_000
                        })
                        // Simulate reading the page (3-6 seconds)
                        await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 6000))

                        // Navigate back to /earn (has all RSC activity data)
                        await page.goto('https://rewards.bing.com/earn', {
                            waitUntil: 'domcontentloaded',
                            timeout: 15_000
                        })
                        await this.bot.utils.wait(2000)

                        const newBalance = await this.bot.browser.func.getCurrentPoints()
                        this.gainedPoints = newBalance - this.oldBalance

                        if (this.gainedPoints > 0) {
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `Completed UrlReward (URL navigation) | offerId=${offerId} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `UrlReward (URL navigation) no points gained | offerId=${offerId} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                            )
                        }
                    } catch (navError) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'URL-REWARD',
                            `URL navigation fallback failed | offerId=${offerId} | error=${navError instanceof Error ? navError.message : String(navError)}`
                        )
                    }
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'URL-REWARD',
                        `UrlReward (browser) failed, no destinationUrl for fallback | offerId=${offerId}`
                    )
                }
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlRewardViaBrowser | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
