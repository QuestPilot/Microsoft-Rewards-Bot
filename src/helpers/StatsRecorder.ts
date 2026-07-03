import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { dataPath, todayDateString } from './DataManager'
import { writeJsonAtomic } from './AtomicFile'

// ─── File types ────────────────────────────────────────────────────────────────

interface GlobalStats {
    version: 1
    updatedAt: string
    firstRunAt: string
    lastRunAt: string
    totalRuns: number
    totalAccountRuns: number
    totalSuccessfulAccountRuns: number
    totalFailedAccountRuns: number
    totalPointsCollected: number
    totalClaimedPoints: number
    totalCouponsApplied: number
    totalCouponPointsSaved: number
}

interface DailyAccountEntry {
    maskedEmail: string
    collectedPoints: number
    finalPoints: number
    success: boolean
    durationSeconds: number
}

interface DailyStats {
    date: string
    runs: number
    accountRuns: number
    successfulAccountRuns: number
    failedAccountRuns: number
    totalPointsCollected: number
    totalDurationSeconds: number
    claimedPoints: number
    couponsApplied: number
    couponPointsSaved: number
    accounts: DailyAccountEntry[]
}

interface AccountHistoryEntry {
    runAt: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    durationSeconds: number
    success: boolean
    error?: string
    claimedPoints: number
    couponsApplied: number
    couponPointsSaved: number
    starBonus?: {
        activeLevelName: string
        monthlyProgress: number
        monthlyMax: number
        levelBonusProgress: number
        levelBonusMax: number
    }
}

interface AccountFile {
    version: 1
    emailKey: string
    maskedEmail: string
    firstSeenAt: string
    lastSeenAt: string
    totalRuns: number
    totalSuccessfulRuns: number
    totalFailedRuns: number
    totalPointsCollected: number
    totalClaimedPoints: number
    totalCouponsApplied: number
    lastKnownPoints: number
    banned?: boolean
    bannedAt?: string
    banReason?: string
    history: AccountHistoryEntry[]
}

// ─── Path helpers ──────────────────────────────────────────────────────────────

function statsRoot(): string { return dataPath('stats') }
function globalStatsPath(): string { return path.join(statsRoot(), 'global.json') }
function dailyStatsPath(date: string): string { return path.join(statsRoot(), 'daily', `${date}.json`) }
function accountFilePath(key: string): string { return path.join(statsRoot(), 'accounts', `${key}.json`) }
function searchesPath(date: string): string { return path.join(statsRoot(), 'searches', `${date}.jsonl`) }
function bansPath(date: string): string { return path.join(statsRoot(), 'bans', `${date}.jsonl`) }

function toEmailKey(email: string): string {
    return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 16)
}

function maskEmail(email: string): string {
    const [name, domain] = String(email || '').split('@')
    if (!name || !domain) return String(email || '')
    return `${name.slice(0, 2)}***@${domain}`
}

// ─── Public input types ────────────────────────────────────────────────────────

export interface AccountRunInput {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    durationSeconds: number
    success: boolean
    error?: string
    coreStats?: {
        claimPoints: number
        couponsApplied: number
        couponPointsDiscount: number
    }
    starBonus?: {
        activeLevelName: string
        monthlyProgress: number
        monthlyMax: number
        levelBonusProgress: number
        levelBonusMax: number
    }
}

export interface RunCompleteInput {
    accountStats: AccountRunInput[]
    runStartTime: number
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Records stats for one account after it finishes.
 * Safe to call from cluster workers — only touches per-account files.
 */
export async function recordAccountRun(input: AccountRunInput): Promise<void> {
    try {
        const key = toEmailKey(input.email)
        const filePath = accountFilePath(key)
        await fs.mkdir(path.dirname(filePath), { recursive: true })

        let account: AccountFile
        try {
            const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as AccountFile
            account = raw.version === 1 ? raw : makeEmptyAccountFile(key, input.email)
        } catch {
            account = makeEmptyAccountFile(key, input.email)
        }

        const now = new Date().toISOString()
        const entry: AccountHistoryEntry = {
            runAt: now,
            initialPoints: input.initialPoints,
            finalPoints: input.finalPoints,
            collectedPoints: input.collectedPoints,
            durationSeconds: input.durationSeconds,
            success: input.success,
            claimedPoints: input.coreStats?.claimPoints ?? 0,
            couponsApplied: input.coreStats?.couponsApplied ?? 0,
            couponPointsSaved: input.coreStats?.couponPointsDiscount ?? 0,
            ...(input.error ? { error: input.error } : {}),
            ...(input.starBonus ? {
                starBonus: {
                    activeLevelName: input.starBonus.activeLevelName,
                    monthlyProgress: input.starBonus.monthlyProgress,
                    monthlyMax: input.starBonus.monthlyMax,
                    levelBonusProgress: input.starBonus.levelBonusProgress,
                    levelBonusMax: input.starBonus.levelBonusMax
                }
            } : {})
        }

        account.lastSeenAt = now
        account.totalRuns += 1
        account.totalSuccessfulRuns += input.success ? 1 : 0
        account.totalFailedRuns += input.success ? 0 : 1
        account.totalPointsCollected += input.collectedPoints
        account.totalClaimedPoints += input.coreStats?.claimPoints ?? 0
        account.totalCouponsApplied += input.coreStats?.couponsApplied ?? 0
        if (input.success && input.finalPoints > 0) {
            account.lastKnownPoints = input.finalPoints
        }

        account.history.push(entry)
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
        account.history = account.history.filter(e => new Date(e.runAt).getTime() >= cutoff)

        await writeJsonAtomic(filePath, account)
    } catch {
        // non-critical
    }
}

/**
 * Records aggregated stats for a completed full run.
 * Must only be called from the primary process (not cluster workers).
 */
export async function recordRunComplete(input: RunCompleteInput): Promise<void> {
    try {
        await Promise.all([
            updateGlobalStats(input),
            updateDailyStats(input)
        ])
    } catch {
        // non-critical
    }
}

/**
 * Appends one search query to today's search log.
 * Fire-and-forget — never awaited in hot paths.
 */
export async function recordSearchQuery(
    query: string,
    isMobile: boolean,
    pointsGained: number,
    accountUser: string
): Promise<void> {
    try {
        const date = todayDateString()
        const filePath = searchesPath(date)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const line = JSON.stringify({
            searchedAt: new Date().toISOString(),
            query,
            isMobile,
            pointsGained,
            // Store an opaque key, never the cleartext account identifier — matches the
            // emailKey approach used by the account/ban logs.
            emailKey: toEmailKey(accountUser)
        })
        await fs.appendFile(filePath, `${line}\n`, 'utf8')
    } catch {
        // non-critical
    }
}

export interface AccountBanInput {
    email: string
    /** Detection reason, e.g. 'service_abuse'. */
    reason: string
    isMobile: boolean
    hasProxy: boolean
    hasCore: boolean
    /** Optional redacted extra detail (never raw secrets). */
    detail?: string
}

/**
 * Records an account ban/lock: appends to today's ban log and marks the
 * per-account file as banned. Fire-and-forget — never throws.
 */
export async function recordAccountBan(input: AccountBanInput): Promise<void> {
    try {
        const date = todayDateString()
        const filePath = bansPath(date)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const key = toEmailKey(input.email)
        const line = JSON.stringify({
            bannedAt: new Date().toISOString(),
            emailKey: key,
            maskedEmail: maskEmail(input.email),
            reason: input.reason,
            device: input.isMobile ? 'mobile' : 'desktop',
            hasProxy: input.hasProxy,
            hasCore: input.hasCore,
            ...(input.detail ? { detail: input.detail } : {})
        })
        await fs.appendFile(filePath, `${line}\n`, 'utf8')
        await markAccountBanned(key, input.reason)
    } catch {
        // non-critical
    }
}

export interface AccountStatsSummary {
    totalRuns: number
    totalSuccessfulRuns: number
    totalFailedRuns: number
    firstSeenAt: string
    lastKnownPoints: number
    banned: boolean
}

/**
 * Reads the persisted summary for one account (run history depth, lifetime
 * outcomes, last balance). Returns null when no history exists yet. Used to
 * enrich ban/error telemetry with "how long this account had been running".
 */
export async function readAccountSummary(email: string): Promise<AccountStatsSummary | null> {
    try {
        const raw = JSON.parse(await fs.readFile(accountFilePath(toEmailKey(email)), 'utf8')) as AccountFile
        if (raw.version !== 1) return null
        return {
            totalRuns: raw.totalRuns,
            totalSuccessfulRuns: raw.totalSuccessfulRuns,
            totalFailedRuns: raw.totalFailedRuns,
            firstSeenAt: raw.firstSeenAt,
            lastKnownPoints: raw.lastKnownPoints,
            banned: raw.banned === true
        }
    } catch {
        return null
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function markAccountBanned(key: string, reason: string): Promise<void> {
    try {
        const filePath = accountFilePath(key)
        const account = JSON.parse(await fs.readFile(filePath, 'utf8')) as AccountFile
        if (account.version !== 1) return
        account.banned = true
        account.bannedAt = new Date().toISOString()
        account.banReason = reason
        await writeJsonAtomic(filePath, account)
    } catch {
        // Account file may not exist yet (ban on first run) — the ban log still captured it.
    }
}

function makeEmptyAccountFile(key: string, email: string): AccountFile {
    const now = new Date().toISOString()
    return {
        version: 1,
        emailKey: key,
        maskedEmail: maskEmail(email),
        firstSeenAt: now,
        lastSeenAt: now,
        totalRuns: 0,
        totalSuccessfulRuns: 0,
        totalFailedRuns: 0,
        totalPointsCollected: 0,
        totalClaimedPoints: 0,
        totalCouponsApplied: 0,
        lastKnownPoints: 0,
        history: []
    }
}

function makeEmptyGlobalStats(): GlobalStats {
    return {
        version: 1,
        updatedAt: '',
        firstRunAt: '',
        lastRunAt: '',
        totalRuns: 0,
        totalAccountRuns: 0,
        totalSuccessfulAccountRuns: 0,
        totalFailedAccountRuns: 0,
        totalPointsCollected: 0,
        totalClaimedPoints: 0,
        totalCouponsApplied: 0,
        totalCouponPointsSaved: 0
    }
}

function makeEmptyDailyStats(date: string): DailyStats {
    return {
        date,
        runs: 0,
        accountRuns: 0,
        successfulAccountRuns: 0,
        failedAccountRuns: 0,
        totalPointsCollected: 0,
        totalDurationSeconds: 0,
        claimedPoints: 0,
        couponsApplied: 0,
        couponPointsSaved: 0,
        accounts: []
    }
}

async function updateGlobalStats(input: RunCompleteInput): Promise<void> {
    const filePath = globalStatsPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    let global: GlobalStats
    try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as GlobalStats
        global = raw.version === 1 ? raw : makeEmptyGlobalStats()
    } catch {
        global = makeEmptyGlobalStats()
    }

    const now = new Date().toISOString()
    if (!global.firstRunAt) global.firstRunAt = now
    global.updatedAt = now
    global.lastRunAt = now
    global.totalRuns += 1

    for (const acc of input.accountStats) {
        global.totalAccountRuns += 1
        global.totalSuccessfulAccountRuns += acc.success ? 1 : 0
        global.totalFailedAccountRuns += acc.success ? 0 : 1
        global.totalPointsCollected += acc.collectedPoints
        global.totalClaimedPoints += acc.coreStats?.claimPoints ?? 0
        global.totalCouponsApplied += acc.coreStats?.couponsApplied ?? 0
        global.totalCouponPointsSaved += acc.coreStats?.couponPointsDiscount ?? 0
    }

    await writeJsonAtomic(filePath, global)
}

async function updateDailyStats(input: RunCompleteInput): Promise<void> {
    const date = todayDateString()
    const filePath = dailyStatsPath(date)
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    let daily: DailyStats
    try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as DailyStats
        // Mirror the global reader's reset-on-invalid guard. DailyStats has no `version`
        // field, so validate structurally: a corrupt-but-parseable file (e.g. `{}`/`[]`)
        // would otherwise throw on `daily.accounts.push(...)` and lose the whole run.
        daily = raw && typeof raw === 'object' && Array.isArray(raw.accounts) ? raw : makeEmptyDailyStats(date)
    } catch {
        daily = makeEmptyDailyStats(date)
    }

    daily.runs += 1

    for (const acc of input.accountStats) {
        daily.accountRuns += 1
        daily.successfulAccountRuns += acc.success ? 1 : 0
        daily.failedAccountRuns += acc.success ? 0 : 1
        daily.totalPointsCollected += acc.collectedPoints
        daily.totalDurationSeconds += acc.durationSeconds
        daily.claimedPoints += acc.coreStats?.claimPoints ?? 0
        daily.couponsApplied += acc.coreStats?.couponsApplied ?? 0
        daily.couponPointsSaved += acc.coreStats?.couponPointsDiscount ?? 0
        daily.accounts.push({
            maskedEmail: maskEmail(acc.email),
            collectedPoints: acc.collectedPoints,
            finalPoints: acc.finalPoints,
            success: acc.success,
            durationSeconds: acc.durationSeconds
        })
    }

    await writeJsonAtomic(filePath, daily)
}
