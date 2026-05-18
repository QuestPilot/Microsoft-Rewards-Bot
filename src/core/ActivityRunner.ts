import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'

// Core task imports (always available in open-source)
import { FindClippy } from './tasks/api/FindClippy'
import { Quiz } from './tasks/api/Quiz'
import { UrlReward } from './tasks/api/UrlReward'
import { Search } from './tasks/browser/Search'
import { SearchOnBing } from './tasks/browser/SearchOnBing'
import { StreakProtectionGate } from './tasks/browser/StreakProtectionGate'

// Types
import type { Promotion } from '../types/AppDashboardData'
import type { ConfigRedeemGoal } from '../types/Config'
import type { BasePromotion, DashboardData, FindClippyPromotion, PurplePromotionalItem } from '../types/DashboardData'
import type {
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
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for DoubleSearchPoints — skipping')
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        if (this.premiumTasks.doAppReward) {
            return this.premiumTasks.doAppReward(promotion)
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for AppReward — skipping')
    }

    doReadToEarn = async (): Promise<void> => {
        if (this.premiumTasks.doReadToEarn) {
            return this.premiumTasks.doReadToEarn()
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for ReadToEarn — skipping')
    }

    doDailyCheckIn = async (): Promise<void> => {
        if (this.premiumTasks.doDailyCheckIn) {
            return this.premiumTasks.doDailyCheckIn()
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for DailyCheckIn — skipping')
    }

    doDailyStreak = async (page: Page): Promise<DailyStreakInfo | null> => {
        if (this.premiumTasks.doDailyStreak) {
            return this.premiumTasks.doDailyStreak(page)
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for DailyStreak — skipping')
        return null
    }

    doRedeemGoal = async (page: Page, config: ConfigRedeemGoal): Promise<void> => {
        if (this.premiumTasks.doRedeemGoal) {
            return this.premiumTasks.doRedeemGoal(page, config)
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for RedeemGoal — skipping')
    }

    collectDashboardInfo = async (page: Page): Promise<DashboardInfo> => {
        if (this.premiumTasks.collectDashboardInfo) {
            return this.premiumTasks.collectDashboardInfo(page)
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for DashboardInfo — skipping')
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
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for ClaimPoints — skipping')
        return { claimed: false, pointsClaimed: 0, entries: [] }
    }

    doTemporaryPunchcards = async (page: Page): Promise<TemporaryPunchcardsResult> => {
        if (this.premiumTasks.doTemporaryPunchcards) {
            return this.premiumTasks.doTemporaryPunchcards(page)
        }
        this.bot.logger.warn('main', 'PLUGIN', 'Premium plugin required for TemporaryPunchcards — skipping')
        return { visited: 0, completedSteps: 0, skippedSteps: 0 }
    }

    syncStreakProtection = async (page: Page, desiredEnabled: boolean): Promise<StreakProtectionSyncResult> => {
        if (this.premiumTasks.syncStreakProtection) {
            return this.premiumTasks.syncStreakProtection(page, desiredEnabled)
        }

        const gate = new StreakProtectionGate(this.bot)
        return gate.sync(page, desiredEnabled)
    }
}
