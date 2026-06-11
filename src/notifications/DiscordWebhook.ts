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

export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return

    await enqueueDiscordRequest({
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: {
            content: truncate(content),
            username: BOT_USERNAME,
            avatar_url: BOT_AVATAR_URL,
            allowed_mentions: { parse: [] }
        },
        timeout: 10000
    })
}

export async function sendDiscordEmbed(discordUrl: string, embed: DiscordEmbed): Promise<void> {
    if (!discordUrl) return
    await enqueueDiscordRequest({
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: {
            embeds: [embed],
            username: BOT_USERNAME,
            avatar_url: BOT_AVATAR_URL,
            allowed_mentions: { parse: [] }
        },
        timeout: 10000
    })
}

async function enqueueDiscordRequest(request: AxiosRequestConfig): Promise<void> {
    await discordQueue.add(async () => {
        try {
            await axios(request)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) return
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
