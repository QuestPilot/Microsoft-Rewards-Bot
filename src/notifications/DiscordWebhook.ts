import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { LogLevel } from './LogService'

const DISCORD_LIMIT = 2000
const BOT_AVATAR_URL = 'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/HEAD/assets/logo.png'
const BOT_USERNAME = 'Microsoft Rewards Bot'

export interface DiscordConfig {
    enabled?: boolean
    url: string
}

export interface DiscordEmbed {
    title?: string
    description?: string
    color?: number
    fields?: Array<{ name: string; value: string; inline?: boolean }>
    footer?: { text: string }
    timestamp?: string
}

const discordQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

function truncate(text: string) {
    return text.length <= DISCORD_LIMIT ? text : text.slice(0, DISCORD_LIMIT - 14) + ' …(truncated)'
}

// By default the payload is POSTed straight to the user's own Discord webhook.
// Setting MSRB_AUTOREPORT_RELAY=1 opts in to routing through the bot.lgtw.tf relay
// (which wraps the payload as { type: 'auto_report', webhookUrl, payload }).
function useAutoReportRelay(): boolean {
    return process.env.MSRB_AUTOREPORT_RELAY === '1'
}

function buildDiscordRequest(discordUrl: string, payload: Record<string, unknown>): AxiosRequestConfig {
    if (useAutoReportRelay()) {
        return {
            method: 'POST',
            url: 'https://bot.lgtw.tf/api/bot/inbox',
            headers: { 'Content-Type': 'application/json' },
            data: {
                type: 'auto_report',
                webhookUrl: discordUrl,
                payload
            },
            timeout: 10000
        }
    }

    return {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: 10000
    }
}

export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return

    await enqueueDiscordRequest(
        buildDiscordRequest(discordUrl, {
            content: truncate(content),
            username: BOT_USERNAME,
            avatar_url: BOT_AVATAR_URL,
            allowed_mentions: { parse: [] }
        }),
        'log'
    )
}

export async function sendDiscordEmbed(discordUrl: string, embed: DiscordEmbed): Promise<void> {
    if (!discordUrl) return
    await enqueueDiscordRequest(
        buildDiscordRequest(discordUrl, {
            embeds: [embed],
            username: BOT_USERNAME,
            avatar_url: BOT_AVATAR_URL,
            allowed_mentions: { parse: [] }
        }),
        'embed'
    )
}

export interface BotErrorReport {
    kind: string
    account?: string
    error?: string
    botVersion: string
    coreVersion?: string
    hasCore: boolean
    platform: string
    arch: string
    node: string
    durationSeconds?: number
}

/**
 * Send an anonymous failure report to the maintainer inbox. This uses the same
 * relay/channel mechanism as the in-app feedback (rating/comment) system — it is
 * NOT a user Discord webhook, so no `discordUrl` is required. Callers must redact
 * the payload before calling; the relay also rate-limits and re-validates.
 */
export async function sendBotErrorReport(report: BotErrorReport): Promise<void> {
    await enqueueDiscordRequest(
        {
            method: 'POST',
            url: 'https://bot.lgtw.tf/api/bot/inbox',
            headers: { 'Content-Type': 'application/json' },
            data: {
                type: 'error_report',
                report
            },
            timeout: 10000
        },
        'error'
    )
}

// Track delivery outages so a single unreachable-endpoint episode warns once instead
// of once per queued report, but the user still gets clear feedback that nothing was sent.
let deliveryOffline = false

async function enqueueDiscordRequest(request: AxiosRequestConfig, kind: string): Promise<void> {
    await discordQueue.add(async () => {
        try {
            await axios(request)
            if (deliveryOffline) {
                deliveryOffline = false
                // eslint-disable-next-line no-console
                console.log('[INFO ] [SYSTEM ] [AUTO-REPORT] Report delivery reachable again, delivery resumed')
            }
        } catch (err: any) {
            const status = err?.response?.status
            // 429 = rate limited; the queue already paces requests, so retry silently.
            if (status === 429) return

            // Previously EVERY non-429 failure was swallowed, so an unreachable
            // endpoint or an invalid webhook produced "nothing sent" with zero
            // feedback. Surface the reason once per outage. We use console directly
            // (not the bot logger) to avoid recursing back through the webhook log filter.
            const detail = status ? `HTTP ${status}` : err?.message || String(err)
            if (!deliveryOffline) {
                deliveryOffline = true
                // eslint-disable-next-line no-console
                console.warn(
                    `[WARN ] [SYSTEM ] [AUTO-REPORT] Could not deliver ${kind} report: ${detail}. ` +
                        'Check webhook.autoReport.discordUrl and that the delivery endpoint is reachable. Suppressing further notices until it recovers.'
                )
            }
        }
    })
}

export async function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await discordQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('discord flush timeout')), timeoutMs))
    ]).catch(() => {})
}
