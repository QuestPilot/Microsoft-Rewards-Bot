import fs from 'fs'
import path from 'path'
import readline from 'readline'

import type { MicrosoftRewardsBot } from '../index'
import type { ConfigSafetyAdvisory } from '../types/Config'
import { writeJsonAtomic } from '../helpers/AtomicFile'

type AdvisoryStatus = 'ok' | 'blocked'
type AdvisorySeverity = 'info' | 'warning' | 'critical'

// Reuse a recent successful check instead of hitting the network every run. The
// remote endpoint reads straight from Turso now (no Redis in front of it, see
// Core-API's lib/safety-advisory.ts) specifically so it stays reliable, but a
// local cache still cuts steady-state request volume — every account run, every
// scheduled cycle, every restart no longer needs its own round trip. This trades
// a BOUNDED per-installation staleness window for that: a maintainer-flipped
// kill-switch can take up to CACHE_TTL_MS to be seen by an install that just
// checked, which is the same class of trade-off the old 5-minute Redis cache
// already made (see git history) — just per-install instead of shared, and
// slightly wider. A failed/unreachable check is never cached, so a real outage
// still gets retried (and fails open) on the very next run.
const CACHE_FILE = path.join('data', 'safety-advisory-cache.json')
const CACHE_TTL_MS = 10 * 60 * 1000

// Backed by Core-API + Turso (lib/safety-advisory.ts), toggled from the admin
// dashboard — no more hand-editing safety-advisory.json and pushing a commit to
// change it. That static file (served via raw.githubusercontent.com) stays in the
// repo unchanged as a fallback: its URL is baked into the compiled code of every
// already-deployed bot version older than this one, and can never be changed
// retroactively for them.
const DEFAULT_SAFETY_ADVISORY: ConfigSafetyAdvisory = {
    enabled: true,
    url: 'https://bot.lgtw.tf/api/safety-advisory',
    timeout: '10sec',
    blockedBehavior: 'prompt'
}

interface AdvisoryPayload {
    schemaVersion: 1
    status: AdvisoryStatus
    severity?: AdvisorySeverity
    message?: string
    updatedAt?: string
}

interface CachedAdvisory {
    checkedAt: number
    advisory: AdvisoryPayload
}

export async function checkSafetyAdvisory(bot: MicrosoftRewardsBot): Promise<boolean> {
    const config = bot.config.safetyAdvisory ?? DEFAULT_SAFETY_ADVISORY
    if (!config?.enabled) return true

    const cached = readCachedAdvisory()
    if (cached) {
        bot.logger.debug(
            'main',
            'SAFETY-ADVISORY',
            `Using cached advisory status from ${Math.round((Date.now() - cached.checkedAt) / 1000)}s ago`
        )
        return evaluateAdvisory(cached.advisory, config, bot)
    }

    try {
        const advisory = await fetchSafetyAdvisory(config, bot.utils.stringToNumber(config.timeout))
        await writeCachedAdvisory(advisory)
        return evaluateAdvisory(advisory, config, bot)
    } catch (error) {
        bot.logger.warn(
            'main',
            'SAFETY-ADVISORY',
            `Could not check advisory status: ${error instanceof Error ? error.message : String(error)}`
        )
        return true
    }
}

async function evaluateAdvisory(
    advisory: AdvisoryPayload,
    config: ConfigSafetyAdvisory,
    bot: MicrosoftRewardsBot
): Promise<boolean> {
    if (advisory.status !== 'blocked') return true

    const message =
        advisory.message ||
        'The maintainers have temporarily marked this bot run as risky. Continuing may put your accounts at risk.'

    bot.logger.warn('main', 'SAFETY-ADVISORY', 'A safety advisory is currently active.')
    bot.logger.warn('main', 'SAFETY-ADVISORY', message)
    if (advisory.updatedAt) {
        bot.logger.warn('main', 'SAFETY-ADVISORY', `Updated at: ${advisory.updatedAt}`)
    }

    return handleBlockedAdvisory(config, bot)
}

function readCachedAdvisory(): CachedAdvisory | null {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Partial<CachedAdvisory>
        if (typeof raw.checkedAt !== 'number' || !raw.advisory || raw.advisory.schemaVersion !== 1) return null
        if (Date.now() - raw.checkedAt >= CACHE_TTL_MS) return null
        return { checkedAt: raw.checkedAt, advisory: raw.advisory as AdvisoryPayload }
    } catch {
        return null
    }
}

// Best-effort: a failed cache write just means the next run re-checks over the
// network, same as today — never let it fail the safety check itself.
async function writeCachedAdvisory(advisory: AdvisoryPayload): Promise<void> {
    const entry: CachedAdvisory = { checkedAt: Date.now(), advisory }
    await writeJsonAtomic(CACHE_FILE, entry).catch(() => undefined)
}

async function fetchSafetyAdvisory(config: ConfigSafetyAdvisory, timeoutMs: number): Promise<AdvisoryPayload> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const response = await fetch(config.url, {
            headers: { 'user-agent': 'Microsoft-Rewards-Bot-SafetyCheck/1.0' },
            signal: controller.signal
        })

        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as unknown
        return parseAdvisory(payload)
    } finally {
        clearTimeout(timeout)
    }
}

function parseAdvisory(payload: unknown): AdvisoryPayload {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid advisory JSON')

    const value = payload as Record<string, unknown>
    if (value.schemaVersion !== 1) throw new Error('Unsupported advisory schema')
    if (value.status !== 'ok' && value.status !== 'blocked') throw new Error('Invalid advisory status')

    return {
        schemaVersion: 1,
        status: value.status,
        severity:
            value.severity === 'critical' || value.severity === 'warning' || value.severity === 'info'
                ? value.severity
                : undefined,
        message: typeof value.message === 'string' ? value.message : undefined,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined
    }
}

async function handleBlockedAdvisory(config: ConfigSafetyAdvisory, bot: MicrosoftRewardsBot): Promise<boolean> {
    if (config.blockedBehavior === 'continue') {
        bot.logger.warn('main', 'SAFETY-ADVISORY', 'Continuing because safety advisory behavior is "continue".')
        return true
    }

    if (config.blockedBehavior === 'stop') {
        bot.logger.error('main', 'SAFETY-ADVISORY', 'Run stopped by safety advisory.')
        return false
    }

    if (!process.stdin.isTTY) {
        bot.logger.error(
            'main',
            'SAFETY-ADVISORY',
            'Run stopped in non-interactive mode because a safety advisory is active.'
        )
        return false
    }

    await promptEnter(
        '\nA safety advisory is active. Press Enter to continue at your own risk, or press Ctrl+C to stop. '
    )
    bot.logger.warn('main', 'SAFETY-ADVISORY', 'User chose to continue at their own risk.')
    return true
}

function promptEnter(prompt: string): Promise<void> {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(prompt, () => {
            rl.close()
            resolve()
        })
    })
}
