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
    enforceCoreStreakProtectionGate: boolean
}

// Webhooks
export interface ConfigWebhook {
    discord?: WebhookDiscordConfig
    ntfy?: WebhookNtfyConfig
    webhookLogFilter: LogFilter
    runSummary?: WebhookRunSummaryConfig
}

export interface WebhookRunSummaryConfig {
    enabled: boolean
    includeCorePitch: boolean
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
