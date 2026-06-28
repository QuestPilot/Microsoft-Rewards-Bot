export interface Config {
    baseURL: string
    sessionPath: string
    headless: boolean
    runOnZeroPoints: boolean
    workers: ConfigWorkers
    searchOnBingLocalQueries: boolean
    globalTimeout: number | string
    searchSettings: ConfigSearchSettings
    debugLogs: boolean
    proxy: ConfigProxy
    consoleLogFilter: LogFilter
    webhook: ConfigWebhook
    /** Anonymous usage analytics. Default: enabled. Disabling removes ALL telemetry
     *  including error reporting — not recommended. */
    analytics?: ConfigAnalytics
    backgroundAgent?: ConfigBackgroundAgent
    terminal?: ConfigTerminal
    plugins?: ConfigPlugins
    scheduler?: ConfigScheduler
    core?: ConfigCore
    safetyAdvisory?: ConfigSafetyAdvisory
}

/**
 * Controls all anonymous telemetry sent to the bot maintainer:
 * run stats, errors, feature usage, plugin events. Never includes passwords,
 * emails, license keys, cookies, or tokens — only redacted diagnostics.
 * Enabled by default; disabling removes error reporting too, which means
 * silent bugs cannot be detected or fixed.
 */
export interface ConfigAnalytics {
    enabled: boolean
}

export interface ConfigTerminal {
    enabled: boolean
}

export interface ConfigBackgroundAgent {
    enabled: boolean
    allowDashboardAutostart: boolean
    openConsole: boolean
}

export interface ConfigScheduler {
    enabled: boolean
    runOnStartup: boolean
    timezone: string
    startTime: string
    randomDelay: ConfigDelay
}

/**
 * Per-feature gating for the proprietary Core plugin. Each flag enables or
 * disables one premium action — the compiled Core plugin reads these exactly
 * like the open-source bot reads `workers.*`. A feature only ever runs (and is
 * only ever counted) when a valid Core license is active AND its flag is not
 * `false`. Without a license / with Core inactive these flags are inert because
 * the premium tasks are never registered. Defaults are `true` (opt-out), except
 * `dailySetUnlimited` which defaults to `false`.
 *
 */
export interface ConfigCore {
    doubleSearchPoints?: boolean
    appReward?: boolean
    readToEarn?: boolean
    dailyCheckIn?: boolean
    dailyStreak?: boolean
    /** New (Next.js) dashboard only — no-op on classic (ASP) accounts. */
    setGoal?: boolean
    claimPoints?: boolean
    /** New (Next.js) dashboard only — no-op on classic (ASP) accounts. */
    applyCoupons?: boolean
    /** New (Next.js) dashboard only — no-op on classic (ASP) accounts. */
    temporaryPunchcards?: boolean
    collectDashboardInfo?: boolean
    /** Number of parallel account processes. Higher = faster but riskier. Default: 1. */
    clusters?: number
    /** Both dashboards: Next via the streak panel, legacy via the Core account API. */
    streakProtection?: boolean
    dashboardSync?: boolean
    /**
     * Core-only maintenance harvester. When `true`, the bot wipes and repopulates the
     * `Page/` folder with full-fidelity dashboard snapshots (HTML + RSC flight data +
     * screenshots) at the start of a run, for offline selector maintenance. Opt-in
     * (defaults `false`); Next.js-only; no-op without a Core license. */
    captureDashboardPages?: boolean
}

export interface ConfigSafetyAdvisory {
    enabled: boolean
    url: string
    timeout: number | string
    blockedBehavior: 'prompt' | 'continue' | 'stop'
}

export interface ConfigPlugins {
    core?: {
        enabled: boolean
    }
}

export type QueryEngine = 'google' | 'wikipedia' | 'reddit' | 'local'

export interface ConfigSearchSettings {
    scrollRandomResults: boolean
    clickRandomResults: boolean
    parallelSearching: boolean
    queryEngines: QueryEngine[]
    searchResultVisitTime: number | string
    searchDelay: ConfigDelay
    readDelay: ConfigDelay
    /** Account-safety pacing. Randomized pause between accounts in a multi-account run
     *  (default ~40sec–4min). Avoids hitting Microsoft back-to-back from one machine. */
    accountDelay?: ConfigDelay
    /** Randomize account processing order each run (default true) so the same account
     *  isn't always first/last — a more human, less predictable pattern. */
    shuffleAccounts?: boolean
    /** Opt-in extra-safe pacing: multiplies every randomized delay (default 1 = off).
     *  e.g. 2 = twice as slow/cautious. Useful for large account counts. */
    delayMultiplier?: number
}

export interface ConfigDelay {
    min: number | string
    max: number | string
}

export interface ConfigProxy {
    queryEngine: boolean
}

export interface ConfigWorkers {
    doDailySet: boolean
    doSpecialPromotions: boolean
    doMorePromotions: boolean
    doAppPromotions: boolean
    doDesktopSearch: boolean
    doMobileSearch: boolean
    doDailyCheckIn: boolean
    doReadToEarn: boolean
    doDailyStreak: boolean
    doDashboardInfo: boolean
    doClaimPoints: boolean
    doApplyCoupons: boolean
    /** Classic punch cards (`dashboard.punchCards`). Present on legacy; empty (no-op) on next. */
    doPunchCards: boolean
}

// Webhooks — user notification channels (Discord log lines, ntfy push)
export interface ConfigWebhook {
    discord?: WebhookDiscordConfig
    ntfy?: WebhookNtfyConfig
    webhookLogFilter: LogFilter
}

export interface LogFilter {
    enabled: boolean
    mode: 'whitelist' | 'blacklist'
    levels?: Array<'debug' | 'info' | 'warn' | 'error'>
    keywords?: string[]
    regexPatterns?: string[]
}

export interface WebhookDiscordConfig {
    enabled: boolean
    url: string
}

export interface WebhookNtfyConfig {
    enabled?: boolean
    url: string
    topic?: string
    token?: string
    title?: string
    tags?: string[]
    priority?: 1 | 2 | 3 | 4 | 5 // 5 highest (important)
}
