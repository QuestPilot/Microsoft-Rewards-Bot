/**
 * Internal plugin API for the official Core plugin.
 *
 * Do not document this file as the public plugin contract. Third-party plugins
 * should import from `microsoft-rewards-bot/plugin-api`.
 */

import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { StreakProtectionSyncResult } from './tasks/browser/StreakProtectionGate'
import type { Promotion } from '../types/AppDashboardData'
import type { ConfigRedeemGoal } from '../types/Config'
import type { PurplePromotionalItem } from '../types/DashboardData'
import type {
    IPlugin,
    PluginLifecycleContext,
    PublicPluginContext
} from '../plugin-api'

export type { AccountResult, IPlugin, PluginConfigEntry, PluginLogger } from '../plugin-api'

export interface OfficialCorePlugin extends Omit<IPlugin, 'register' | 'onBotInitialized' | 'onAccountStart' | 'onAccountEnd'> {
    register(context: OfficialCoreContext): void | Promise<void>
    onBotInitialized?(context: OfficialCoreLifecycleContext): void | Promise<void>
    onAccountStart?(context: OfficialCoreAccountLifecycleContext): void | Promise<void>
    onAccountEnd?(context: OfficialCoreAccountEndLifecycleContext): void | Promise<void>
}

export interface OfficialCoreContext extends PublicPluginContext {
    readonly bot: MicrosoftRewardsBot
    registerPremiumTasks(tasks: Partial<PremiumTaskMap>): void
    grantOfficialCoreEntitlement(): void
}

export interface OfficialCoreLifecycleContext extends PluginLifecycleContext {
    readonly bot: MicrosoftRewardsBot
}

export interface OfficialCoreAccountLifecycleContext extends OfficialCoreLifecycleContext {
    readonly email: string
}

export interface OfficialCoreAccountEndLifecycleContext extends OfficialCoreAccountLifecycleContext {
    readonly result: import('../plugin-api').AccountResult
}

export interface PremiumTaskMap {
    doDoubleSearchPoints: (promotion: PurplePromotionalItem) => Promise<void>
    doAppReward: (promotion: Promotion) => Promise<void>
    doReadToEarn: () => Promise<void>
    doDailyCheckIn: () => Promise<void>
    doDailyStreak: (page: Page) => Promise<DailyStreakInfo | null>
    doRedeemGoal: (page: Page, config: ConfigRedeemGoal) => Promise<void>
    collectDashboardInfo: (page: Page) => Promise<DashboardInfo>
    doClaimPoints: (page: Page) => Promise<ClaimPointsResult>
    doApplyCoupons: (page: Page) => Promise<ApplyCouponsResult>
    doTemporaryPunchcards: (page: Page) => Promise<TemporaryPunchcardsResult>
    syncStreakProtection: (page: Page, desiredEnabled: boolean) => Promise<StreakProtectionSyncResult>
}

export interface ClaimEntry {
    category: string
    date: string
    expiryDate: string
    points: number
}

export interface ClaimPointsResult {
    claimed: boolean
    pointsClaimed: number
    entries: ClaimEntry[]
}

export interface AppliedCoupon {
    title: string | null
    pointsDiscount: number | null
    expiresText: string | null
}

export interface ApplyCouponsResult {
    available: number
    applied: number
    totalPointsDiscount: number
    coupons: AppliedCoupon[]
}

export interface TemporaryPunchcardsResult {
    visited: number
    completedSteps: number
    skippedSteps: number
}

export interface DashboardInfo {
    userName: string | null
    level: string | null
    availablePoints: number | null
    readyToClaimPoints: number
    claimEntries: ClaimEntry[]
    hasClaimEntryExpiringSoon: boolean
    todayPoints: number | null
    streakDays: number | null
}

export interface DailyStreakInfo {
    streakDays: number
    streakProtectionEnabled: boolean | null
    bonusText: string | null
    bonusStarsFilled: number
    bonusStarsTotal: number
}
