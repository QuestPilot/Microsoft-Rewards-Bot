import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { AppDashboardData } from '../types/AppDashboardData'
import type {
    BasePromotion,
    DashboardData,
    FindClippyPromotion,
    PunchCard,
    PurplePromotionalItem
} from '../types/DashboardData'

export class TaskBase {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    protected getActiveTaskPage(): Page | null {
        const primary = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        const fallback = this.bot.isMobile ? this.bot.mainDesktopPage : this.bot.mainMobilePage
        const pages: Array<Page | undefined> = [primary, fallback]

        for (const page of pages) {
            if (page && !page.isClosed()) return page
        }

        return null
    }

    public async doDailySet(data: DashboardData, page: Page) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[todayKey]

        let activitiesUncompleted = todayData?.filter(x => !x.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        // Free tier limitation: max 2 Daily Set quests.
        // Only the verified official Core plugin can grant the premium entitlement.
        const maxQuests = this.bot.pluginManager.hasOfficialCoreEntitlement() ? Infinity : 2
        if (activitiesUncompleted.length > maxQuests) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Open-source mode: solving ${maxQuests} of ${activitiesUncompleted.length} Daily Set items. Core unlocks full Daily Set coverage.`
            )
            activitiesUncompleted = activitiesUncompleted.slice(0, maxQuests)
        }

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [...(data.morePromotions ?? []), ...(data.morePromotionsWithoutPromotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        const activitiesUncompleted: BasePromotion[] =
            morePromotions?.filter(x => {
                if (x.complete) return false
                if (x.pointProgressMax <= 0) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                return true
            }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotion" items have already been completed'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving ${activitiesUncompleted.length} "More Promotions" items`
        )

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    /**
     * Classic punch cards (`dashboard.punchCards`): a parent promotion with child
     * activities to complete. Present on the LEGACY dashboard; on the Next.js
     * dashboard `punchCards` is empty so this is a clean no-op. Ported from the
     * legacy reference bot. (Next.js "quest" punchcards are handled separately by
     * the Core premium `doTemporaryPunchcards`.)
     */
    public async doPunchCards(data: DashboardData, page: Page) {
        const punchCards =
            data.punchCards?.filter(
                x => !x.parentPromotion?.complete && (x.parentPromotion?.pointProgressMax ?? 0) > 0
            ) ?? []

        const punchCardActivities: BasePromotion[] = punchCards.flatMap(x => x.childPromotions)

        const activitiesUncompleted: BasePromotion[] = punchCardActivities.filter(x => {
            if (x.complete) return false
            if (x.exclusiveLockedFeatureStatus === 'locked') return false
            if (!x.promotionType) return false

            return true
        })

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have already been completed')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Started solving ${activitiesUncompleted.length} "Punch Card" items`
        )

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have been completed')
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type']) return false
            if (x.attributes['type'] !== 'sapphire') return false

            return true
        })

        if (!appRewards.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        for (const reward of appRewards) {
            await this.bot.activities.doAppReward(reward)
            // A delay between completing each activity
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
    }

    public async doSpecialPromotions(data: DashboardData) {
        const specialPromotions: PurplePromotionalItem[] = [
            ...new Map(
                [...(data.promotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as PurplePromotionalItem] as const)
            ).values()
        ]

        const supportedPromotions = ['ww_banner_optin_2x']

        const specialPromotionsUncompleted: PurplePromotionalItem[] =
            specialPromotions?.filter(x => {
                if (x.complete) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                const offerId = (x.offerId ?? '').toLowerCase()
                return supportedPromotions.some(s => offerId.includes(s))
            }) ?? []

        for (const activity of specialPromotionsUncompleted) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as PurplePromotionalItem).offerId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}"`
                )

                switch (type) {
                    // UrlReward
                    case 'urlreward': {
                        // Special "Double Search Points" activation
                        if (name.includes('ww_banner_optin_2x')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Double Search Points" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doDoubleSearchPoints(activity)
                        }
                        break
                    }

                    // Unsupported types
                    default: {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'SPECIAL-ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'SPECIAL-ACTIVITY', 'All "Special Activites" items have been completed')
    }

    private async solveActivities(activities: BasePromotion[], page: Page, punchCard?: PunchCard) {
        for (const activity of activities) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const offerId = (activity as BasePromotion).offerId
                const destinationUrl = activity.destinationUrl?.toLowerCase() ?? ''

                this.bot.logger.info(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}`
                )

                // Wrap each activity in a timeout to prevent indefinite hangs
                const activityTimeout = 120_000 // 2 minutes max per activity
                const activityPromise = (async () => {
                    switch (type) {
                        // Quiz-like activities (Poll / regular quiz variants)
                        case 'quiz': {
                            const basePromotion = activity as BasePromotion

                            // Poll (usually 10 points, pollscenarioid in URL)
                            if (activity.pointProgressMax === 10 && destinationUrl.includes('pollscenarioid')) {
                                // The legacy ASP dashboard does not credit pollscenarioid polls —
                                // the bingqa endpoint returns HTTP 400. The reference bot skips
                                // polls entirely on legacy; mirror it. Only NEXT handles polls.
                                if (this.bot.dashboardVariant === 'legacy') {
                                    this.bot.logger.info(
                                        this.bot.isMobile,
                                        'ACTIVITY',
                                        `Skipped Poll on legacy dashboard (not creditable) | title="${activity.title}" | offerId=${offerId}`
                                    )
                                    break
                                }

                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Found activity type "Poll" | title="${activity.title}" | offerId=${offerId}`
                                )

                                // Poll is handled via Quiz API (same underlying mechanism)
                                await this.bot.activities.doQuiz(basePromotion)
                                break
                            }

                            // All other quizzes handled via Quiz API
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Quiz" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doQuiz(basePromotion)
                            break
                        }

                        // UrlReward
                        case 'urlreward': {
                            const basePromotion = activity as BasePromotion

                            // Some daily-set quiz activities arrive typed as urlreward but are
                            // only credited through the quiz flow on the NEXT.js dashboard — its
                            // report-activity server action returns actionResult=false and a bare
                            // URL visit earns nothing (e.g. "Westeros Intrigue?", form=dsetqu /
                            // IsConversation). Route those to the quiz handler instead of doUrlReward.
                            // LEGACY must NOT take this reroute: on the ASP dashboard these offers
                            // are credited by the normal reportactivity POST (doUrlReward → HTTP 200),
                            // whereas the bingqa quiz endpoint rejects them with HTTP 400 (0 points).
                            if (
                                this.bot.dashboardVariant !== 'legacy' &&
                                /form=dsetqu|pollscenarioid|filters=isconversation/.test(destinationUrl)
                            ) {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Found activity type "Quiz" (daily-set quiz routed from urlreward) | title="${activity.title}" | offerId=${offerId}`
                                )

                                await this.bot.activities.doQuiz(basePromotion)
                            } else if (this.isSearchOnBingPromotion(activity)) {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`
                                )

                                await this.bot.activities.doSearchOnBing(basePromotion, page)
                            } else {
                                this.bot.logger.info(
                                    this.bot.isMobile,
                                    'ACTIVITY',
                                    `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`
                                )

                                await this.bot.activities.doUrlReward(basePromotion)
                            }
                            break
                        }

                        // Find Clippy specific promotion type
                        case 'findclippy': {
                            const clippyPromotion = activity as unknown as FindClippyPromotion

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "FindClippy" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doFindClippy(clippyPromotion)
                            break
                        }

                        // Unsupported types
                        default: {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                            )
                            break
                        }
                    }
                })()

                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error(`Activity timed out after ${activityTimeout / 1000}s`)),
                        activityTimeout
                    )
                )

                await Promise.race([activityPromise, timeoutPromise])

                // Cooldown
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    private isSearchOnBingPromotion(activity: BasePromotion): boolean {
        const destinationUrl = activity.destinationUrl ?? ''
        const fields = [
            activity.name,
            activity.offerId,
            activity.promotionSubtype,
            activity.title,
            activity.description,
            activity.linkText,
            destinationUrl
        ]
            .filter((value): value is string => typeof value === 'string')
            .join(' ')
            .toLowerCase()

        if (fields.includes('exploreonbing') || fields.includes('searchonbing')) return true

        // Punchcard children whose type is urlreward must be processed as UrlReward,
        // NOT as SearchOnBing. Their credit comes from navigating to the specific
        // tracked destination URL (OCID parameter), not from a generic Bing search.
        // A generic search without the OCID tracking never credits the punchcard.
        // (Genuine punchcard SearchOnBing items would have matched the string check above.)
        if ((activity.offerId ?? '').toLowerCase().includes('punchcard')) return false

        try {
            const destination = new URL(destinationUrl)
            const hostname = destination.hostname.toLowerCase()
            if (hostname !== 'bing.com' && !hostname.endsWith('.bing.com')) return false

            const pathname = destination.pathname.toLowerCase()
            const isBingLanding = pathname === '' || pathname === '/'
            const isBingSearch = pathname === '/search'
            if (!isBingLanding && !isBingSearch) return false

            const params = destination.searchParams
            const features = params.get('features')?.toLowerCase() ?? ''
            const form = params.get('form')?.toLowerCase() ?? ''
            const ocid = params.get('ocid')?.toLowerCase() ?? ''

            if (features.includes('vstooltip')) return true
            if ((form.startsWith('ml2x') || ocid.startsWith('ml2x')) && !params.has('filters')) return true
        } catch {
            return false
        }

        return false
    }
}
