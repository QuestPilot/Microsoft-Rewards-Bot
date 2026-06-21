import type { BasePromotion } from '../../../types/DashboardData'
import { TaskBase } from '../../TaskBase'

/**
 * UrlReward / "click" activity. The actual report (legacy axios POST vs Next
 * Server Action + URL-navigation fallback) is delegated to the variant-agnostic
 * seam `bot.dashboard`; this task only orchestrates and verifies the balance.
 */
export class UrlReward extends TaskBase {
    private gainedPoints = 0

    private oldBalance = this.bot.userData.currentPoints

    public async doUrlReward(promotion: BasePromotion) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | variant=${this.bot.dashboardVariant} | geo=${this.bot.userData.geoLocale} | oldBalance=${this.oldBalance}`
        )

        try {
            const page = this.getActiveTaskPage()

            const reported = await this.bot.dashboard.reportActivity(page, {
                offerId,
                hash: promotion.hash,
                destinationUrl: promotion.destinationUrl,
                allowUrlNavFallback: true
            })

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward gained no points | offerId=${offerId} | reported=${reported} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
