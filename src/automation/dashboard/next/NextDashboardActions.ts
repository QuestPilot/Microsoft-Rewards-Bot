import type { Page } from 'patchright'

import type { MicrosoftRewardsBot } from '../../../index'
import type { DashboardActions, ReportActivityParams } from '../DashboardActions'

/**
 * NEXT (Next.js / React Server Components) dashboard report strategy.
 *
 * Wraps the fragile RSC report path (`PageController.reportActivityViaBrowser`:
 * webpack-chunk inspection + React Server Action) and the UrlReward-style
 * URL-navigation fallback. All Next/RSC fragility is isolated here so the rest of
 * the codebase never touches it directly.
 */
export class NextDashboardActions implements DashboardActions {
    public readonly variant = 'next' as const

    private readonly bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Ensure the page is on `/earn` so the inline RSC <script> tags carry flight
     * data for ALL activities (Daily Set + More Promotions). `/dashboard` only has
     * Daily Set hashes.
     */
    private async ensureOnEarn(page: Page): Promise<void> {
        if (!page.url().includes('rewards.bing.com/earn')) {
            await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded' }).catch(() => {})
            await this.bot.utils.wait(2000)
        }
    }

    async reportActivity(page: Page | null, params: ReportActivityParams): Promise<boolean> {
        if (!page || page.isClosed()) {
            this.bot.logger.warn(this.bot.isMobile, 'NEXT-REPORT-ACTIVITY', 'Browser page not available, skipping')
            return false
        }

        try {
            await this.ensureOnEarn(page)

            const ok = await this.bot.browser.func.reportActivityViaBrowser(page, {
                offerId: params.offerId,
                hash: params.hash,
                type: params.type,
                destinationUrl: params.destinationUrl
            })

            if (ok) return true

            // Fallback (UrlReward-style): visit the destination URL like a real user.
            // Microsoft credits the activity when the destination is visited.
            if (params.allowUrlNavFallback && params.destinationUrl) {
                // Interactive AI tools (bing.com/tools/ai/*) require genuine user input
                // (clicks, form submissions) to grant credit — silent navigation never works.
                // Skip the fallback for these to avoid wasting ~15s per item.
                try {
                    const destUrl = new URL(params.destinationUrl)
                    if (
                        destUrl.hostname.endsWith('bing.com') &&
                        destUrl.pathname.startsWith('/tools/ai')
                    ) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'NEXT-REPORT-ACTIVITY',
                            `Skipping URL fallback — interactive AI tool requires user input | offerId=${params.offerId} | destination=${params.destinationUrl.slice(0, 80)}…`
                        )
                        return false
                    }
                } catch {
                    /* URL parse failed — proceed with fallback */
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'NEXT-REPORT-ACTIVITY',
                    `Server Action failed, falling back to URL navigation | offerId=${params.offerId} | destination=${params.destinationUrl.slice(0, 80)}…`
                )
                try {
                    await page.goto(params.destinationUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
                    await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 6000))
                    await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 15_000 })
                    await this.bot.utils.wait(2000)
                    return true
                } catch (navError) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'NEXT-REPORT-ACTIVITY',
                        `URL navigation fallback failed | offerId=${params.offerId} | error=${navError instanceof Error ? navError.message : String(navError)}`
                    )
                    return false
                }
            }

            return false
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'NEXT-REPORT-ACTIVITY',
                `Error reporting activity | offerId=${params.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async reportQuizOnce(page: Page | null, params: ReportActivityParams): Promise<boolean> {
        if (!page || page.isClosed()) {
            this.bot.logger.warn(this.bot.isMobile, 'NEXT-REPORT-QUIZ', 'Browser page not available, skipping')
            return false
        }

        try {
            await this.ensureOnEarn(page)
            return await this.bot.browser.func.reportActivityViaBrowser(page, {
                offerId: params.offerId,
                hash: params.hash,
                type: params.type,
                destinationUrl: params.destinationUrl
            })
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'NEXT-REPORT-QUIZ',
                `Error reporting quiz | offerId=${params.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }
}
