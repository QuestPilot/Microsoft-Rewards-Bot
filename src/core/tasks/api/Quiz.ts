import type { AxiosRequestConfig } from 'axios'
import type { BasePromotion } from '../../../types/DashboardData'
import { TaskBase } from '../../TaskBase'

export class Quiz extends TaskBase {
    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    async doQuiz(promotion: BasePromotion) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        const startBalance = this.oldBalance

        this.bot.logger.info(
            this.bot.isMobile,
            'QUIZ',
            `Starting quiz | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax} | currentPoints=${startBalance}`
        )

        try {
            // If no request token (new Next.js dashboard), use browser-based reportActivity
            if (!this.bot.requestToken) {
                return this.doQuizViaBrowser(promotion)
            }

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
                'QUIZ',
                `Prepared quiz headers | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            // 8-question quiz — not supported in the legacy API path
            if (promotion.activityProgressMax === 80) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Detected 8-question quiz (activityProgressMax=80), skipping (not supported) | offerId=${offerId}`
                )
                return
            }

            //Standard points quizzes (20/30/40/50 max)
            if ([20, 30, 40, 50].includes(promotion.pointProgressMax)) {
                let oldBalance = startBalance
                let gainedPoints = 0
                const maxAttempts = 20
                let totalGained = 0
                let attempts = 0

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUIZ',
                    `Starting ReportActivity loop | offerId=${offerId} | maxAttempts=${maxAttempts} | startingBalance=${oldBalance}`
                )

                for (let i = 0; i < maxAttempts; i++) {
                    try {
                        const jsonData = {
                            UserId: null,
                            TimeZoneOffset: -60,
                            OfferId: offerId,
                            ActivityCount: 1,
                            QuestionIndex: '-1'
                        }

                        const request: AxiosRequestConfig = {
                            url: 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                cookie: this.cookieHeader,
                                ...this.fingerprintHeader
                            },
                            data: JSON.stringify(jsonData)
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Sending ReportActivity request | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | url=${request.url}`
                        )

                        const response = await this.bot.axios.request(request)

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Received ReportActivity response | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | status=${response.status}`
                        )

                        const newBalance = await this.bot.browser.func.getCurrentPoints()
                        gainedPoints = newBalance - oldBalance

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Balance delta after ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | oldBalance=${oldBalance} | newBalance=${newBalance} | gainedPoints=${gainedPoints}`
                        )

                        attempts = i + 1

                        if (gainedPoints > 0) {
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                            oldBalance = newBalance
                            totalGained += gainedPoints
                            this.gainedPoints += gainedPoints

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity ${i + 1} → ${response.status} | offerId=${offerId} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity ${i + 1} | offerId=${offerId} | no more points gained, ending quiz | lastBalance=${newBalance}`
                            )
                            break
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'QUIZ',
                            `Waiting between ReportActivity attempts | attempt=${i + 1}/${maxAttempts} | offerId=${offerId}`
                        )

                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
                    } catch (error) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'QUIZ',
                            `Error during ReportActivity | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
                        )
                        break
                    }
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed the quiz successfully | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Unsupported quiz configuration | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUIZ',
                `Error in doQuiz | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Browser-based fallback for the new Next.js dashboard where
     * `__RequestVerificationToken` is no longer embedded in the HTML.
     *
     * For Polls (pointProgressMax=10): single reportActivity call.
     * For Standard quizzes (20/30/40/50): loop reportActivity calls
     * until no more points are gained, like the legacy API path.
     */
    private async doQuizViaBrowser(promotion: BasePromotion): Promise<void> {
        const offerId = promotion.offerId
        const startBalance = this.oldBalance

        this.bot.logger.info(
            this.bot.isMobile,
            'QUIZ',
            `Starting quiz (browser mode) | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | currentPoints=${startBalance}`
        )

        try {
            const page = this.getActiveTaskPage()
            if (!page || page.isClosed()) {
                this.bot.logger.warn(this.bot.isMobile, 'QUIZ', 'Browser page not available, skipping quiz')
                return
            }

            // Ensure we are on the /earn page so <script> tags contain all activity RSC data
            if (!page.url().includes('rewards.bing.com/earn')) {
                await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded' }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            // 8-question quiz — not supported
            if (promotion.activityProgressMax === 80) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Detected 8-question quiz (activityProgressMax=80), skipping | offerId=${offerId}`
                )
                return
            }

            // Poll (pointProgressMax=10) — single call
            if (promotion.pointProgressMax === 10) {
                const ok = await this.bot.browser.func.reportActivityViaBrowser(page, {
                    offerId,
                    hash: promotion.hash,
                    type: promotion.promotionType,
                    destinationUrl: promotion.destinationUrl
                })

                if (ok) {
                    const newBalance = await this.bot.browser.func.getCurrentPoints()
                    const gained = newBalance - startBalance

                    if (gained > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                        this.gainedPoints += gained
                    }

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'QUIZ',
                        `Completed Poll (browser) | offerId=${offerId} | gainedPoints=${gained} | newBalance=${newBalance}`,
                        'green'
                    )
                } else {
                    this.bot.logger.warn(this.bot.isMobile, 'QUIZ', `Poll (browser) failed | offerId=${offerId}`)
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
                return
            }

            // Standard quizzes (20/30/40/50 max) — loop until no more points gained
            if ([20, 30, 40, 50].includes(promotion.pointProgressMax)) {
                let oldBalance = startBalance
                let totalGained = 0
                const maxAttempts = 20
                let attempts = 0

                for (let i = 0; i < maxAttempts; i++) {
                    try {
                        const ok = await this.bot.browser.func.reportActivityViaBrowser(page, {
                            offerId,
                            hash: promotion.hash,
                            type: promotion.promotionType,
                            destinationUrl: promotion.destinationUrl
                        })

                        if (!ok) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity (browser) ${i + 1} failed | offerId=${offerId}`
                            )
                            break
                        }

                        const newBalance = await this.bot.browser.func.getCurrentPoints()
                        const gainedPoints = newBalance - oldBalance
                        attempts = i + 1

                        if (gainedPoints > 0) {
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                            oldBalance = newBalance
                            totalGained += gainedPoints
                            this.gainedPoints += gainedPoints

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity (browser) ${i + 1} | offerId=${offerId} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'QUIZ',
                                `ReportActivity (browser) ${i + 1} | offerId=${offerId} | no more points gained, ending quiz | lastBalance=${newBalance}`
                            )
                            break
                        }

                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
                    } catch (error) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'QUIZ',
                            `Error during ReportActivity (browser) | attempt=${i + 1}/${maxAttempts} | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
                        )
                        break
                    }
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed quiz (browser) | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Unsupported quiz configuration (browser) | offerId=${offerId} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUIZ',
                `Error in doQuizViaBrowser | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
