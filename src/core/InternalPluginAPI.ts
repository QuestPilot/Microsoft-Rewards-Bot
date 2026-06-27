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
import type { PurplePromotionalItem } from '../types/DashboardData'
import type { IPlugin, PluginLifecycleContext, PublicPluginContext } from '../plugin-api'

export type { AccountResult, IPlugin, PluginConfigEntry, PluginLogger } from '../plugin-api'

export interface OfficialCorePlugin extends Omit<
    IPlugin,
    'register' | 'onBotInitialized' | 'onAccountStart' | 'onAccountEnd'
> {
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
    doSetGoal: (page: Page) => Promise<void>
    collectDashboardInfo: (page: Page) => Promise<DashboardInfo>
    doClaimPoints: (page: Page) => Promise<ClaimPointsResult>
    doApplyCoupons: (page: Page) => Promise<ApplyCouponsResult>
    doTemporaryPunchcards: (page: Page) => Promise<TemporaryPunchcardsResult>
    syncStreakProtection: (page: Page, desiredEnabled: boolean) => Promise<StreakProtectionSyncResult>
    doCaptureDashboardPages: (page: Page) => Promise<DashboardCaptureResult>
}

/**
 * Result of the Core-only dashboard page harvester (selector/RSC maintenance tool).
 * The open-source bot ships a no-op stub; the real implementation lives in Core.
 */
export interface DashboardCaptureResult {
    /** Number of routes successfully captured. */
    captured: number
    /** Route names that were captured (e.g. "dashboard", "earn"). */
    routes: string[]
    /** Output directory the snapshots were written to, relative to the run cwd. */
    outputDir: string | null
    /** Aggregated analyzer problems across every captured route (selector drift hints). */
    problems: string[]
    /** Detailed in-memory analysis used by the terminal-only harvester report. */
    analyses?: DashboardHarvesterPageAnalysis[]
    /** Routes that could not be analyzed at all. */
    failures?: DashboardHarvesterFailure[]
    /** End-to-end analysis duration. */
    durationMs?: number
}

export interface DashboardHarvesterSelectorCheck {
    group: string
    key: string
    selector: string
    /** Maximum match count observed across the initial and expanded DOM states. */
    matches: number
    /** Match count before the harvester opens disclosures and side panels. */
    matchesInitial?: number
    /** Match count after the harvester opens disclosures and side panels. */
    matchesExpanded?: number
    valid: boolean
    required: boolean
    error?: string
}

export interface DashboardHarvesterPageAnalysis {
    name: string
    /** Requested route URL. */
    url: string
    /** Final URL after redirects. */
    finalUrl?: string
    /** Main-document HTTP status when Patchright exposed a response. */
    httpStatus?: number
    /** Non-fatal navigation error when a timed-out page still produced usable DOM/RSC data. */
    navigationError?: string
    title: string
    domBytes?: number
    elementCount?: number
    classTokenCount?: number
    stableIdCount?: number
    /** Per-route structured DOM inventory written next to the HTML/RSC artifacts. */
    inventoryFile?: string
    /** Deterministic SHA-256 of stable DOM signals for drift comparisons. */
    domFingerprint?: string
    flightBytes: number
    offerIds: number
    actionIds: number
    modelTypes: string[]
    hasPointClaim: boolean
    hasDailySet: boolean
    switches: number
    disclosures: number
    dialogs: number
    selectorChecks: DashboardHarvesterSelectorCheck[]
    problems: string[]
}

export interface DashboardHarvesterFailure {
    name: string
    url: string
    error: string
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
