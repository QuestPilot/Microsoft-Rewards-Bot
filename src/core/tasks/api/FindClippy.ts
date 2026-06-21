import type { FindClippyPromotion } from '../../../types/DashboardData'
import { TaskBase } from '../../TaskBase'

/**
 * "Find Clippy" activity. Reporting is delegated to the variant-agnostic seam
 * `bot.dashboard`; this task only orchestrates and verifies the balance.
 */
export class FindClippy extends TaskBase {
    private gainedPoints = 0

    private oldBalance = this.bot.userData.currentPoints

    public async doFindClippy(promotion: FindClippyPromotion) {
        const offerId = promotion.offerId
        const activityType = promotion.activityType
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'FIND-CLIPPY',
            `Starting Find Clippy | offerId=${offerId} | variant=${this.bot.dashboardVariant} | activityType=${activityType} | oldBalance=${this.oldBalance}`
        )

        try {
            const page = this.getActiveTaskPage()

            const reported = await this.bot.dashboard.reportActivity(page, {
                offerId,
                hash: promotion.hash,
                type: activityType,
                destinationUrl: promotion.destinationUrl
            })

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'FIND-CLIPPY',
                    `Found Clippy | offerId=${offerId} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'FIND-CLIPPY',
                    `Found Clippy but no points were gained | offerId=${offerId} | reported=${reported} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'FIND-CLIPPY',
                `Error in doFindClippy | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
