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
    redeemGoal?: ConfigRedeemGoal
    plugins?: ConfigPlugins
    scheduler?: ConfigScheduler
    safetyAdvisory?: ConfigSafetyAdvisory
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

export interface ConfigRedeemGoal {
    enabled: boolean
    /** Full SKU URL, e.g. "https://rewards.bing.com/redeem/sku/000499012010" */
    skuUrl: string
    /** SKU option value to select in the dropdown, e.g. "000499012011" for 800 Robux */
    skuOptionValue?: string
    /** Redeem mode: "auto" = auto-redeem when enough points, "manual" = track goal only */
    redeemMode: 'auto' | 'manual'
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
    doRedeemGoal: boolean
    doDashboardInfo: boolean
    doClaimPoints: boolean
    enforceCoreStreakProtectionGate: boolean
}

// Webhooks
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
