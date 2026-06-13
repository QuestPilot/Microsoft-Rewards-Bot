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
    // Strip any attempt to include @everyone / @here / role/user pings inside field content.
    // The webhook already sends `allowed_mentions: { parse: [] }` which prevents Discord
    // from resolving them, but we clean the raw text too for extra clarity.
    return value
        .replace(/@everyone/gi, '@ everyone')
        .replace(/@here/gi, '@ here')
        .replace(/<@[!&]?\d+>/g, '[mention]')
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

export async function sendAutoReportRunStart(
    config: AutoReportConfig,
    accountCount: number
): Promise<void> {
    if (!config.enabled || !config.discordUrl || config.reportRunStart === false) return

    const pkg = getPackageMetadata()

    await sendDiscordEmbed(config.discordUrl, {
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

    if (stats.success) {
        await sendDiscordEmbed(config.discordUrl, {
            title: 'Account Completed',
            color: COLOR_SUCCESS,
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
        await sendDiscordEmbed(config.discordUrl, {
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

    if (failed.length > 0) {
        const failedList = failed
            .slice(0, 5)
            .map(a => `• ${sanitize(maskEmail(a.email, config.maskEmails !== false))}: ${sanitize(String(a.error || 'Unknown').slice(0, 100))}`)
            .join('\n')
        fields.push({
            name: `Failed Accounts (${failed.length})`,
            value: failedList.slice(0, 1024),
            inline: false
        })
    }

    await sendDiscordEmbed(config.discordUrl, {
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
