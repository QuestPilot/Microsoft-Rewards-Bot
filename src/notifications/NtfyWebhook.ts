import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { WebhookNtfyConfig } from '../types/Config'
import type { LogLevel } from './LogService'

const BOT_ICON_URL = 'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/HEAD/assets/logo.png'

const ntfyQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendNtfy(config: WebhookNtfyConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.url) return

    // Compute the per-message priority LOCALLY. `config` is the cached bot.config
    // singleton, so mutating `config.priority` here would permanently bump EVERY
    // later notification to error/warn priority after the first error/warn.
    let priority = config.priority
    switch (level) {
        case 'error':
            priority = 5 // Highest
            break

        case 'warn':
            priority = 4
            break

        default:
            break
    }

    const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
    if (config.title) headers['Title'] = config.title
    if (config.tags?.length) headers['Tags'] = config.tags.join(',')
    if (priority) headers['Priority'] = String(priority)
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`
    headers['Icon'] = BOT_ICON_URL

    const url = config.topic ? `${config.url}/${config.topic}` : config.url

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: url,
        headers,
        data: content,
        timeout: 10000
    }

    await ntfyQueue.add(async () => {
        try {
            await axios(request)
        } catch (err: unknown) {
            if (axios.isAxiosError(err) && err.response?.status === 429) return
        }
    })
}

export async function flushNtfyQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await ntfyQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('ntfy flush timeout')), timeoutMs))
    ]).catch(() => {})
}
