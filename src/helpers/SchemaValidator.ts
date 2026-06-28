import semver from 'semver'
import { z } from 'zod'

import { Account } from '../types/Account'
import { Config } from '../types/Config'
import { getPackageMetadata } from './PackageMetadata'

const NumberOrString = z.union([z.number(), z.string()])

const LogFilterSchema = z.object({
    enabled: z.boolean(),
    mode: z.enum(['whitelist', 'blacklist']),
    levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
    keywords: z.array(z.string()).optional(),
    regexPatterns: z.array(z.string()).optional()
})

const DelaySchema = z.object({
    min: NumberOrString,
    max: NumberOrString
})

const QueryEngineSchema = z.enum(['google', 'wikipedia', 'reddit', 'local'])

const TotpSecretSchema = z.preprocess(
    value => {
        if (typeof value !== 'string') return value
        const normalized = value
            .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
            .replace(/=+$/, '')
            .toUpperCase()
        return normalized || undefined
    },
    z
        .string()
        .min(16, 'totpSecret appears invalid: expected a base32 string (A-Z, 2-7) of at least 16 characters')
        .regex(/^[A-Z2-7]+$/, 'totpSecret appears invalid: expected a base32 string (A-Z, 2-7) of at least 16 characters')
        .optional()
)

const BackgroundAgentSchema = z.object({
    enabled: z.boolean().default(true),
    allowDashboardAutostart: z.boolean().default(true),
    openConsole: z.boolean().default(true)
})

const TerminalSchema = z.object({
    enabled: z.boolean().default(true)
})

const SchedulerSchema = z.object({
    enabled: z.boolean().default(false),
    runOnStartup: z.boolean().default(true),
    timezone: z.string().default('Europe/Paris'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    randomDelay: DelaySchema
})

const SafetyAdvisorySchema = z.object({
    enabled: z.boolean().default(true),
    url: z.string(),
    timeout: NumberOrString.default('10sec'),
    blockedBehavior: z.enum(['prompt', 'continue', 'stop']).default('prompt')
})

// Webhook — user notification channels only (Discord log lines, ntfy push)
const WebhookSchema = z.object({
    discord: z
        .object({
            enabled: z.boolean(),
            url: z.string()
        })
        .optional(),
    ntfy: z
        .object({
            enabled: z.boolean().optional(),
            url: z.string(),
            topic: z.string().optional(),
            token: z.string().optional(),
            title: z.string().optional(),
            tags: z.array(z.string()).optional(),
            priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional()
        })
        .optional(),
    webhookLogFilter: LogFilterSchema
})

// Config
export const ConfigSchema = z.object({
    baseURL: z.string(),
    sessionPath: z.string(),
    headless: z.boolean(),
    runOnZeroPoints: z.boolean(),
    workers: z.object({
        doDailySet: z.boolean(),
        doSpecialPromotions: z.boolean(),
        doMorePromotions: z.boolean(),
        doAppPromotions: z.boolean(),
        doDesktopSearch: z.boolean(),
        doMobileSearch: z.boolean(),
        doDailyCheckIn: z.boolean(),
        doReadToEarn: z.boolean(),
        doDailyStreak: z.boolean(),
        doDashboardInfo: z.boolean(),
        doClaimPoints: z.boolean(),
        doApplyCoupons: z.boolean().default(true),
        doPunchCards: z.boolean().default(true)
    }),
    searchOnBingLocalQueries: z.boolean(),
    globalTimeout: NumberOrString,
    searchSettings: z.object({
        scrollRandomResults: z.boolean(),
        clickRandomResults: z.boolean(),
        parallelSearching: z.boolean(),
        queryEngines: z.array(QueryEngineSchema),
        searchResultVisitTime: NumberOrString,
        searchDelay: DelaySchema,
        readDelay: DelaySchema
    }),
    debugLogs: z.boolean(),
    proxy: z.object({
        queryEngine: z.boolean()
    }),
    consoleLogFilter: LogFilterSchema,
    webhook: WebhookSchema,
    /** All anonymous telemetry. Default on; disabling also disables error reporting. */
    analytics: z.object({
        enabled: z.boolean().default(true)
    }).default({ enabled: true }),
    backgroundAgent: BackgroundAgentSchema.optional(),
    terminal: TerminalSchema.optional(),
    /** Rewards Desk (local control UI) settings. `lanAccess` (opt-in, default off) lets
     *  other devices on the home network reach the Desk at http://<this-pc-ip>:<port>;
     *  the same-machine Nexus embed works on loopback without it. */
    desk: z.object({
        lanAccess: z.boolean().default(false),
        /** Run the Desk as a headless service (no window) — for servers/Docker with no
         *  GUI, so the bot stays reachable/controllable from Nexus. Opt-in, default off. */
        headless: z.boolean().default(false),
        port: NumberOrString.optional()
    }).optional(),
    scheduler: SchedulerSchema.optional(),
    core: z.object({
        doubleSearchPoints: z.boolean().optional(),
        appReward: z.boolean().optional(),
        readToEarn: z.boolean().optional(),
        dailyCheckIn: z.boolean().optional(),
        dailyStreak: z.boolean().optional(),
        setGoal: z.boolean().optional(),
        claimPoints: z.boolean().optional(),
        applyCoupons: z.boolean().optional(),
        temporaryPunchcards: z.boolean().optional(),
        collectDashboardInfo: z.boolean().optional(),
        clusters: z.number().int().nonnegative().optional(),
        streakProtection: z.boolean().optional(),
        dashboardSync: z.boolean().optional(),
        captureDashboardPages: z.boolean().optional()
    }).optional(),
    safetyAdvisory: SafetyAdvisorySchema.optional()
})

// Account
export const AccountSchema = z.object({
    email: z.string(),
    enabled: z.boolean().optional(),
    password: z.string(),
    totpSecret: TotpSecretSchema,
    recoveryEmail: z.string(),
    geoLocale: z.string(),
    langCode: z.string(),
    proxy: z.object({
        proxyAxios: z.boolean(),
        url: z.string(),
        port: z.number(),
        password: z.string(),
        username: z.string()
    }),
    saveFingerprint: z.object({
        mobile: z.boolean(),
        desktop: z.boolean()
    }),
    // Optional per-account dashboard variant override (legacy support — removable).
    dashboardMode: z.enum(['auto', 'next', 'legacy']).optional()
})

export function validateConfig(data: unknown): Config {
    return ConfigSchema.parse(data) as Config
}

export function validateAccounts(data: unknown): Account[] {
    return z.array(AccountSchema).parse(data) as Account[]
}

export function checkNodeVersion(): void {
    try {
        const pkg = getPackageMetadata()
        const requiredVersion = pkg.engines?.node

        if (!requiredVersion) {
            console.warn('No Node.js version requirement found in package.json "engines" field.')
            return
        }

        if (!semver.satisfies(process.version, requiredVersion)) {
            console.error(`Current Node.js version ${process.version} does not satisfy requirement: ${requiredVersion}`)
            process.exit(1)
        }
    } catch (error) {
        console.error('Failed to validate Node.js version:', error)
        process.exit(1)
    }
}
