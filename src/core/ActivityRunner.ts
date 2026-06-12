import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'

// Core task imports (always available in the public edition)
import { FindClippy } from './tasks/api/FindClippy'
import { Quiz } from './tasks/api/Quiz'
import { UrlReward } from './tasks/api/UrlReward'
import { Search } from './tasks/browser/Search'
import { SearchOnBing } from './tasks/browser/SearchOnBing'
import { StreakProtectionGate } from './tasks/browser/StreakProtectionGate'

// Types
import type { Promotion } from '../types/AppDashboardData'
import type { BasePromotion, DashboardData, FindClippyPromotion, PurplePromotionalItem } from '../types/DashboardData'
import type {
    ApplyCouponsResult,
    ClaimPointsResult,
    DailyStreakInfo,
    DashboardInfo,
    PremiumTaskMap,
    TemporaryPunchcardsResult
} from './InternalPluginAPI'
import type { StreakProtectionSyncResult } from './tasks/browser/StreakProtectionGate'

export default class ActivityRunner {
    private bot: MicrosoftRewardsBot
    private premiumTasks: Partial<PremiumTaskMap> = {}
    private premiumHintsShown = new Set<string>()

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Install premium task implementations provided by a plugin.
     * Called by PluginManager after plugins have registered their tasks.
     */
    installPremiumTasks(tasks: Partial<PremiumTaskMap>): void {
        this.premiumTasks = { ...this.premiumTasks, ...tasks }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE TASKS (always available)
    // ═══════════════════════════════════════════════════════════════════════

    doSearch = async (data: DashboardData, page: Page, isMobile: boolean): Promise<number> => {
        const search = new Search(this.bot)
        return await search.doSearch(data, page, isMobile)
    }

    doSearchOnBing = async (promotion: BasePromotion, page: Page): Promise<void> => {
        const searchOnBing = new SearchOnBing(this.bot)
        await searchOnBing.doSearchOnBing(promotion, page)
    }

    doUrlReward = async (promotion: BasePromotion): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(promotion)
    }

    doQuiz = async (promotion: BasePromotion): Promise<void> => {
        const quiz = new Quiz(this.bot)
        await quiz.doQuiz(promotion)
    }

    doFindClippy = async (promotion: FindClippyPromotion): Promise<void> => {
        const findClippy = new FindClippy(this.bot)
        await findClippy.doFindClippy(promotion)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PREMIUM TASKS (no-op stubs — replaced by plugin if installed)
    // ═══════════════════════════════════════════════════════════════════════

    doDoubleSearchPoints = async (promotion: PurplePromotionalItem): Promise<void> => {
        if (this.premiumTasks.doDoubleSearchPoints) {
            return this.premiumTasks.doDoubleSearchPoints(promotion)
        }
        this.coreHint('Double Search Points', 'Core can activate eligible double-search promotions when Microsoft offers them.')
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        if (this.premiumTasks.doAppReward) {
            return this.premiumTasks.doAppReward(promotion)
        }
        this.coreHint('App Rewards', 'Core adds mobile app rewards such as Daily Check-In and Read to Earn.')
    }

    doReadToEarn = async (): Promise<void> => {
        if (this.premiumTasks.doReadToEarn) {
            return this.premiumTasks.doReadToEarn()
        }
        this.coreHint('Read to Earn', 'Core can complete supported app-only reading rewards.')
    }

    doDailyCheckIn = async (): Promise<void> => {
        if (this.premiumTasks.doDailyCheckIn) {
            return this.premiumTasks.doDailyCheckIn()
        }
        this.coreHint('Daily Check-In', 'Core can handle supported app-only daily check-ins.')
    }

    doDailyStreak = async (page: Page): Promise<DailyStreakInfo | null> => {
        if (this.premiumTasks.doDailyStreak) {
            return this.premiumTasks.doDailyStreak(page)
        }
        this.coreHint('Daily Streak', 'Core can read streak details and sync streak protection from the Rewards dashboard.')
        return null
    }

    doSetGoal = async (page: Page): Promise<void> => {
        if (this.premiumTasks.doSetGoal) {
            return this.premiumTasks.doSetGoal(page)
        }
        this.coreHint('Set Goal', 'Core can automatically find and set a Rewards goal when none is active.')
    }

    collectDashboardInfo = async (page: Page): Promise<DashboardInfo> => {
        if (this.premiumTasks.collectDashboardInfo) {
            return this.premiumTasks.collectDashboardInfo(page)
        }
        this.coreHint('Dashboard Info', 'Core adds richer dashboard snapshots, ready-to-claim cards, streak details, and remote dashboard data.')
        return {
            userName: null,
            level: null,
            availablePoints: null,
            readyToClaimPoints: 0,
            claimEntries: [],
            hasClaimEntryExpiringSoon: false,
            todayPoints: null,
            streakDays: null
        }
    }

    doClaimPoints = async (page: Page): Promise<ClaimPointsResult> => {
        if (this.premiumTasks.doClaimPoints) {
            return this.premiumTasks.doClaimPoints(page)
        }
        this.coreHint('Claim Points', 'Core can claim supported ready-to-claim point cards automatically.')
        return { claimed: false, pointsClaimed: 0, entries: [] }
    }

    doApplyCoupons = async (page: Page): Promise<ApplyCouponsResult> => {
        if (this.premiumTasks.doApplyCoupons) {
            return this.premiumTasks.doApplyCoupons(page)
        }
        this.coreHint('Coupons', 'Core can detect and apply supported Rewards dashboard coupons automatically.')
        return { available: 0, applied: 0, totalPointsDiscount: 0, coupons: [] }
    }

    doTemporaryPunchcards = async (page: Page): Promise<TemporaryPunchcardsResult> => {
        if (this.premiumTasks.doTemporaryPunchcards) {
            return this.premiumTasks.doTemporaryPunchcards(page)
        }
        this.coreHint('Temporary Punchcards', 'Core can attempt supported temporary dashboard punchcards when they appear.')
        return { visited: 0, completedSteps: 0, skippedSteps: 0 }
    }

    syncStreakProtection = async (page: Page, desiredEnabled: boolean): Promise<StreakProtectionSyncResult> => {
        if (this.premiumTasks.syncStreakProtection) {
            return this.premiumTasks.syncStreakProtection(page, desiredEnabled)
        }

        const gate = new StreakProtectionGate(this.bot)
        return gate.sync(page, desiredEnabled)
    }

    private coreHint(feature: string, detail: string): void {
        if (this.premiumHintsShown.has(feature)) {
            this.bot.logger.warn('main', 'CORE-OPTIONAL', `${feature} requires Core — skipping.`)
            return
        }

        this.premiumHintsShown.add(feature)
        this.bot.logger.warn(
            'main',
            'CORE-OPTIONAL',
            `${feature} requires Core — skipping. ${detail} Learn more: https://github.com/QuestPilot/Microsoft-Rewards-Bot/blob/HEAD/docs/core-plugin.md`
        )
    }
}
