import type { BasePromotion } from '../../../types/DashboardData'
import { TaskBase } from '../../TaskBase'

/**
 * Quiz / Poll activity. Each report iteration is delegated to the variant-agnostic
 * seam `bot.dashboard.reportQuizOnce` (legacy `bingqa` POST vs Next Server Action);
 * the retry loop and balance accounting stay here so both variants share them.
 */
export class Quiz extends TaskBase {
    private gainedPoints = 0

    private oldBalance = this.bot.userData.currentPoints

    async doQuiz(promotion: BasePromotion) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        const startBalance = this.oldBalance

        this.bot.logger.info(
            this.bot.isMobile,
            'QUIZ',
            `Starting quiz | offerId=${offerId} | variant=${this.bot.dashboardVariant} | pointProgressMax=${promotion.pointProgressMax} | activityProgressMax=${promotion.activityProgressMax} | currentPoints=${startBalance}`
        )

        try {
            const page = this.getActiveTaskPage()

            // 8-question quiz — not supported by either report path.
            if (promotion.activityProgressMax === 80) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUIZ',
                    `Detected 8-question quiz (activityProgressMax=80), skipping (not supported) | offerId=${offerId}`
                )
                return
            }

            const reportParams = {
                offerId,
                hash: promotion.hash,
                type: promotion.promotionType,
                destinationUrl: promotion.destinationUrl
            }

            // Poll (pointProgressMax=10) — single report.
            if (promotion.pointProgressMax === 10) {
                const ok = await this.bot.dashboard.reportQuizOnce(page, reportParams)
                const newBalance = await this.bot.browser.func.getCurrentPoints()
                const gained = newBalance - startBalance

                if (gained > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                    this.gainedPoints += gained

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'QUIZ',
                        `Completed Poll | offerId=${offerId} | gainedPoints=${gained} | newBalance=${newBalance}`,
                        'green'
                    )
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'QUIZ',
                        `Poll gained no points | offerId=${offerId} | reported=${ok} | lastBalance=${newBalance}`
                    )
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
                return
            }

            // Standard quizzes (20/30/40/50 max) — loop until no more points gained.
            if ([20, 30, 40, 50].includes(promotion.pointProgressMax)) {
                let oldBalance = startBalance
                let totalGained = 0
                const maxAttempts = 20
                let attempts = 0

                for (let i = 0; i < maxAttempts; i++) {
                    const ok = await this.bot.dashboard.reportQuizOnce(page, reportParams)

                    if (!ok) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'QUIZ',
                            `ReportActivity ${i + 1} failed | offerId=${offerId}`
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
                            `ReportActivity ${i + 1} | offerId=${offerId} | gainedPoints=${gainedPoints} | newBalance=${newBalance}`,
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

                    await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUIZ',
                    `Completed quiz | offerId=${offerId} | attempts=${attempts} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${this.bot.userData.currentPoints}`
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
}
