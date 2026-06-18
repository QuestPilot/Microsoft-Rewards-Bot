import { sendDiscordEmbed } from './DiscordWebhook'
import { getPackageMetadata } from '../helpers/PackageMetadata'
import type { AutoReportConfig } from '../types/Config'

const COLOR_SUCCESS = 0x2fd27d
const COLOR_ERROR = 0xed4245
const COLOR_INFO = 0x5865f2
const COLOR_WARNING = 0xf7c85c

export interface AutoReportAccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

function maskEmail(email: string, mask: boolean): string {
    if (!mask) return email
    const atIdx = email.indexOf('@')
    if (atIdx < 0) return email
    const user = email.slice(0, atIdx)
    const domain = email.slice(atIdx)
    const visible = Math.min(2, user.length)
    return `${user.slice(0, visible)}${'\\*'.repeat(Math.max(0, user.length - visible))}${domain}`
}

function sanitize(value: string): string {
    return value
        // Discord ping protection
        .replace(/@everyone/gi, '@ everyone')
        .replace(/@here/gi, '@ here')
        .replace(/<@[!&]?\d+>/g, '[mention]')
        // Redact IPv4 addresses (could be a user's home IP or proxy IP)
        .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
        // Redact IPv6 addresses
        .replace(/([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}/g, '[ip]')
        // Redact URLs that could contain credentials or proxy addresses
        .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
        // Redact Windows/Unix absolute paths that could expose usernames
        .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
        .replace(/\/home\/[^\s"']+/g, '[path]')
        .replace(/\/Users\/[^\s"']+/g, '[path]')
}

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds.toFixed(0)}s`
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function footerText(version: string): string {
    return `Microsoft Rewards Bot v${version} • Auto Report`
}

/**
 * Returns the webhook URL with the configured channel/thread id appended as a
 * `thread_id` query parameter so Discord delivers the report into that thread.
 * Without a channelId the plain webhook URL is used unchanged.
 */
function resolveReportUrl(config: AutoReportConfig): string {
    const channelId = config.channelId?.trim()
    if (!channelId) return config.discordUrl
    const separator = config.discordUrl.includes('?') ? '&' : '?'
    return `${config.discordUrl}${separator}thread_id=${encodeURIComponent(channelId)}`
}

export async function sendAutoReportRunStart(
    config: AutoReportConfig,
    accountCount: number
): Promise<void> {
    if (!config.enabled || !config.discordUrl || config.reportRunStart === false) return

    const pkg = getPackageMetadata()

    await sendDiscordEmbed(resolveReportUrl(config), {
        title: 'Run Started',
        description: 'A new Microsoft Rewards run has been initiated.',
        color: COLOR_INFO,
        fields: [
            { name: 'Accounts', value: String(accountCount), inline: true },
            { name: 'Bot Version', value: `v${pkg.version}`, inline: true },
            { name: 'Node.js', value: process.version, inline: true }
        ],
        footer: { text: footerText(pkg.version) },
        timestamp: new Date().toISOString()
    })
}

export async function sendAutoReportAccountEnd(
    config: AutoReportConfig,
    stats: AutoReportAccountStats
): Promise<void> {
    if (!config.enabled || !config.discordUrl || config.reportAccountEnd === false) return

    const pkg = getPackageMetadata()
    const email = sanitize(maskEmail(stats.email, config.maskEmails !== false))

    const reportUrl = resolveReportUrl(config)

    if (stats.success) {
        // A run that finishes without throwing but collects 0 points is the exact
        // signature of the "logged into rewards but Bing search session is anonymous"
        // failure. Surface it as a warning instead of a green success so it is not
        // silently mistaken for a healthy run.
        const collectedNothing = stats.collectedPoints <= 0

        await sendDiscordEmbed(reportUrl, {
            title: collectedNothing ? 'Account Completed — no points collected' : 'Account Completed',
            description: collectedNothing
                ? 'The run finished but earned 0 points. If points were expected, the Bing search session may not have been signed in.'
                : undefined,
            color: collectedNothing ? COLOR_WARNING : COLOR_SUCCESS,
            fields: [
                { name: 'Account', value: email, inline: false },
                { name: 'Points Collected', value: `+${stats.collectedPoints.toLocaleString()}`, inline: true },
                { name: 'Balance', value: `${stats.initialPoints.toLocaleString()} → ${stats.finalPoints.toLocaleString()}`, inline: true },
                { name: 'Duration', value: formatDuration(stats.duration), inline: true }
            ],
            footer: { text: footerText(pkg.version) },
            timestamp: new Date().toISOString()
        })
    } else {
        await sendDiscordEmbed(reportUrl, {
            title: 'Account Failed',
            color: COLOR_ERROR,
            fields: [
                { name: 'Account', value: email, inline: false },
                { name: 'Error', value: sanitize(String(stats.error || 'Unknown error').slice(0, 1024)), inline: false },
                { name: 'Duration', value: formatDuration(stats.duration), inline: true }
            ],
            footer: { text: footerText(pkg.version) },
            timestamp: new Date().toISOString()
        })
    }
}

export async function sendAutoReportRunSummary(
    config: AutoReportConfig,
    accounts: AutoReportAccountStats[],
    runStartTime: number
): Promise<void> {
    if (!config.enabled || !config.discordUrl || config.reportRunSummary === false) return

    const pkg = getPackageMetadata()
    const successful = accounts.filter(a => a.success)
    const failed = accounts.filter(a => !a.success)
    const totalCollected = accounts.reduce((sum, a) => sum + a.collectedPoints, 0)
    const totalInitial = accounts.reduce((sum, a) => sum + a.initialPoints, 0)
    const totalFinal = accounts.reduce((sum, a) => sum + a.finalPoints, 0)
    const runtimeSeconds = (Date.now() - runStartTime) / 1000

    const hasFailures = failed.length > 0
    const color = hasFailures ? COLOR_WARNING : COLOR_SUCCESS

    const avgCollected = successful.length > 0 ? Math.round(totalCollected / successful.length) : 0
    const bestEarner = successful.reduce<AutoReportAccountStats | null>(
        (best, a) => (best === null || a.collectedPoints > best.collectedPoints ? a : best),
        null
    )

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        {
            name: 'Results',
            value: `${successful.length}/${accounts.length} accounts succeeded`,
            inline: true
        },
        {
            name: 'Points Collected',
            value: `+${totalCollected.toLocaleString()}`,
            inline: true
        },
        {
            name: 'Avg / Account',
            value: `+${avgCollected.toLocaleString()}`,
            inline: true
        },
        {
            name: 'Total Balance',
            value: `${totalInitial.toLocaleString()} → ${totalFinal.toLocaleString()}`,
            inline: true
        },
        {
            name: 'Runtime',
            value: formatDuration(runtimeSeconds),
            inline: true
        },
        {
            name: 'Bot Version',
            value: `v${pkg.version}`,
            inline: true
        }
    ]

    if (bestEarner && bestEarner.collectedPoints > 0) {
        fields.push({
            name: 'Top Account',
            value: `${sanitize(maskEmail(bestEarner.email, config.maskEmails !== false))} (+${bestEarner.collectedPoints.toLocaleString()})`,
            inline: false
        })
    }

    // Per-account breakdown — successes AND failures, so healthy accounts are
    // visible too (not just errors). Capped to fit Discord's 1024-char field.
    if (accounts.length > 0) {
        const lines: string[] = []
        const maxLines = 15
        for (const a of accounts.slice(0, maxLines)) {
            const name = sanitize(maskEmail(a.email, config.maskEmails !== false))
            lines.push(
                a.success
                    ? `✅ ${name}: +${a.collectedPoints.toLocaleString()} • ${formatDuration(a.duration)}`
                    : `❌ ${name}: ${sanitize(String(a.error || 'Unknown').slice(0, 60))}`
            )
        }
        if (accounts.length > maxLines) lines.push(`…and ${accounts.length - maxLines} more`)
        fields.push({
            name: `Per-Account (${accounts.length})`,
            value: lines.join('\n').slice(0, 1024),
            inline: false
        })
    }

    await sendDiscordEmbed(resolveReportUrl(config), {
        title: hasFailures ? 'Run Completed with Warnings' : 'Run Completed',
        description: hasFailures
            ? `${failed.length} account(s) encountered errors.`
            : 'All accounts finished successfully.',
        color,
        fields,
        footer: { text: footerText(pkg.version) },
        timestamp: new Date().toISOString()
    })
}
