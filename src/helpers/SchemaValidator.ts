import semver from 'semver'
import { z } from 'zod'
import pkg from '../../package.json'

import { Account } from '../types/Account'
import { Config } from '../types/Config'

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

const RedeemGoalSchema = z.object({
    enabled: z.boolean(),
    skuUrl: z.string(),
    skuOptionValue: z.string().optional(),
    redeemMode: z.enum(['auto', 'manual'])
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

// Webhook
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
    clusters: z.number().int().nonnegative(),
    errorDiagnostics: z.boolean(),
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
        doRedeemGoal: z.boolean(),
        doDashboardInfo: z.boolean(),
        doClaimPoints: z.boolean(),
        enforceCoreStreakProtectionGate: z.boolean().default(true)
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
    redeemGoal: RedeemGoalSchema.optional(),
    scheduler: SchedulerSchema.optional(),
    safetyAdvisory: SafetyAdvisorySchema.optional()
})

// Account
export const AccountSchema = z.object({
    email: z.string(),
    password: z.string(),
    totpSecret: z.string().optional(),
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
    })
})

export function validateConfig(data: unknown): Config {
    return ConfigSchema.parse(data) as Config
}

export function validateAccounts(data: unknown): Account[] {
    return z.array(AccountSchema).parse(data)
}

export function checkNodeVersion(): void {
    try {
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
