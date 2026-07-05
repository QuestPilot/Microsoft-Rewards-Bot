import readline from 'readline'

import type { MicrosoftRewardsBot } from '../index'
import type { ConfigSafetyAdvisory } from '../types/Config'

type AdvisoryStatus = 'ok' | 'blocked'
type AdvisorySeverity = 'info' | 'warning' | 'critical'

// Backed by Core-API + Redis (lib/safety-advisory.ts), toggled from the admin
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

export async function checkSafetyAdvisory(bot: MicrosoftRewardsBot): Promise<boolean> {
    const config = bot.config.safetyAdvisory ?? DEFAULT_SAFETY_ADVISORY
    if (!config?.enabled) return true

    try {
        const advisory = await fetchSafetyAdvisory(config, bot.utils.stringToNumber(config.timeout))
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
    } catch (error) {
        bot.logger.warn(
            'main',
            'SAFETY-ADVISORY',
            `Could not check advisory status: ${error instanceof Error ? error.message : String(error)}`
        )
        return true
    }
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
