export interface Config {
    baseURL: string
    sessionPath: string
    headless: boolean
    runOnZeroPoints: boolean
    clusters: number
    errorDiagnostics: boolean
    workers: ConfigWorkers
    searchOnBingLocalQueries: boolean
    globalTimeout: number | string
    searchSettings: ConfigSearchSettings
    debugLogs: boolean
    proxy: ConfigProxy
    consoleLogFilter: LogFilter
    webhook: ConfigWebhook
    backgroundAgent?: ConfigBackgroundAgent
    terminal?: ConfigTerminal
    plugins?: ConfigPlugins
    scheduler?: ConfigScheduler
    core?: ConfigCore
    safetyAdvisory?: ConfigSafetyAdvisory
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
    /** Both dashboards: Next via the streak panel, legacy via the Core account API. */
    streakProtection?: boolean
    dashboardSync?: boolean
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

// Webhooks
export interface ConfigWebhook {
    discord?: WebhookDiscordConfig
    ntfy?: WebhookNtfyConfig
    webhookLogFilter: LogFilter
    runSummary?: WebhookRunSummaryConfig
    autoReport?: AutoReportConfig
    errorReporting?: ErrorReportingConfig
}

/**
 * Anonymous failure reporting to the bot maintainer's inbox (same relay as the
 * in-app feedback/rating system — NOT a user Discord webhook). Enabled by
 * default; set `enabled: false` to opt out. Only redacted diagnostics are sent
 * (masked email, sanitized error text, bot/Core version, OS/Node) — never
 * passwords, cookies, tokens, or license keys.
 */
export interface ErrorReportingConfig {
    enabled?: boolean
}

export interface AutoReportConfig {
    enabled: boolean
    discordUrl: string
    /**
     * Optional Discord channel/thread id. When set, reports are routed to that
     * thread (via the webhook's `thread_id` parameter). The thread must live in
     * the same channel as the webhook (or be a forum-channel thread).
     */
    channelId?: string
    reportRunStart?: boolean
    reportAccountEnd?: boolean
    reportRunSummary?: boolean
    maskEmails?: boolean
}

export interface WebhookRunSummaryConfig {
    enabled: boolean
    discordUrl: string
    includeCoreComparison?: boolean
    /** Legacy name accepted during config migration. */
    includeCorePitch?: boolean
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
