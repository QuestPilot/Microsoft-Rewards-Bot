/**
 * AnalyticsService — anonymous usage telemetry for the bot maintainer.
 *
 * Design principles:
 *   - The PostHog write key lives ONLY in the Core-API Vercel environment. The bot
 *     never touches PostHog directly; it POSTs to our relay endpoint which validates,
 *     sanitises, and forwards server-side.
 *   - Instance ID is a random UUID generated on first run and persisted to
 *     data/msrb-analytics-id. It is never tied to an email or licence key.
 *   - PII is stripped client-side before sending (belt-and-suspenders: the relay
 *     also scrubs on the server side).
 *   - Fire-and-forget: `track()` never blocks or throws. If the relay is unreachable
 *     the events are dropped silently — analytics must never affect the run.
 *   - One retry on network failure, then silent drop.
 *   - Set DEBUG_ANALYTICS=1 to log events to console for local testing.
 */

import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { dataRoot } from '../helpers/DataManager'
import { getPackageMetadata } from '../helpers/PackageMetadata'

const ANALYTICS_ENDPOINT = 'https://bot.lgtw.tf/api/bot/inbox'
const INSTANCE_ID_FILE = 'msrb-analytics-id'
const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_QUEUE = 50

export type AnalyticsEvent =
    | 'run_started'
    | 'run_completed'
    | 'account_completed'
    | 'account_banned'
    | 'error_occurred'
    | 'search_completed'
    | 'worker_executed'
    | 'feature_toggled'
    | 'update_applied'
    | 'plugin_event'
    | 'scheduler_triggered'
    | 'desk_session_ended'
    | 'feedback_submitted'

interface QueuedEvent {
    event: AnalyticsEvent
    properties: Record<string, unknown>
}

export class AnalyticsService {
    private readonly enabled: boolean
    private readonly instanceId: string
    private readonly queue: QueuedEvent[] = []
    private flushing = false
    private flushScheduled = false
    private readonly debug = process.env.DEBUG_ANALYTICS === '1'

    constructor(enabled: boolean) {
        this.enabled = enabled
        // Disabled/ephemeral analytics must not create the persistent instance-id file.
        this.instanceId = enabled ? this.loadOrCreateInstanceId() : randomUUID()
    }

    /** Whether telemetry is on. Gates sibling maintainer channels (e.g. the Discord error relay). */
    get isEnabled(): boolean {
        return this.enabled
    }

    /**
     * Queue an analytics event. Fire-and-forget — never throws, never blocks.
     * If analytics is disabled this is a no-op.
     */
    track(event: AnalyticsEvent, properties: Record<string, unknown> = {}): void {
        if (!this.enabled) return
        if (this.queue.length >= MAX_QUEUE) return // drop oldest-first if queue full

        const clean = this.scrubProps(properties)
        if (this.debug) {
            // eslint-disable-next-line no-console
            console.log(`[DEBUG] [ANALYTICS] queued: ${event}`, clean)
        }
        this.queue.push({ event, properties: clean })

        if (!this.flushScheduled) {
            this.flushScheduled = true
            setImmediate(() => {
                void this.flush()
            })
        }
    }

    /**
     * Build a properties object with common bot context pre-filled.
     * Callers can pass additional event-specific properties which take precedence.
     */
    withContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
        try {
            const pkg = getPackageMetadata()
            return {
                bot_version: pkg.version,
                os: process.platform,
                arch: process.arch,
                node_version: process.version,
                ...extra
            }
        } catch {
            return extra
        }
    }

    /**
     * Flush all queued events to the relay endpoint.
     * Safe to await at run end / bot shutdown.
     */
    async flush(): Promise<void> {
        this.flushScheduled = false
        if (!this.enabled || this.flushing || this.queue.length === 0) return
        this.flushing = true
        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift()!
                await this.sendEvent(item)
            }
        } finally {
            this.flushing = false
        }
    }

    // ─── Private ──────────────────────────────────────────────────────────────

    private async sendEvent(item: QueuedEvent, isRetry = false): Promise<void> {
        try {
            await axios({
                method: 'POST',
                url: ANALYTICS_ENDPOINT,
                headers: { 'Content-Type': 'application/json' },
                data: {
                    type: 'analytics_event',
                    instanceId: this.instanceId,
                    event: item.event,
                    properties: item.properties
                },
                timeout: 8000
            })
            if (this.debug) {
                // eslint-disable-next-line no-console
                console.log(`[DEBUG] [ANALYTICS] sent: ${item.event}`)
            }
        } catch {
            if (!isRetry) {
                // One retry after a short back-off — then drop silently
                await new Promise<void>(r => setTimeout(r, 500))
                await this.sendEvent(item, true)
            }
            // Analytics must never affect the run — drop silently after retry
        }
    }

    private loadOrCreateInstanceId(): string {
        const filePath = path.join(dataRoot(), INSTANCE_ID_FILE)
        try {
            const existing = fs.readFileSync(filePath, 'utf8').trim()
            if (INSTANCE_ID_RE.test(existing)) return existing
        } catch {
            // File missing or invalid — generate a fresh ID below
        }
        const id = randomUUID()
        try {
            fs.mkdirSync(dataRoot(), { recursive: true })
            fs.writeFileSync(filePath, id, 'utf8')
        } catch {
            // Persist is best-effort: use a session-only ID if the data dir is not writable
        }
        return id
    }

    /**
     * Strip PII from property values before they leave the machine.
     * Server-side scrubbing is a second layer — this is belt-and-suspenders.
     */
    private scrubProps(props: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined) continue
            if (typeof value === 'string') {
                out[key] = this.scrubString(value)
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                out[key] = value
            } else if (Array.isArray(value)) {
                // Only allow flat arrays of primitives (e.g. workers_enabled list)
                out[key] = value
                    .filter(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                    .map(v => (typeof v === 'string' ? this.scrubString(v) : v))
                    .slice(0, 30)
            }
            // Objects beyond 1 level are dropped — could contain arbitrary data
        }
        return out
    }

    private scrubString(text: string): string {
        return (
            text
                // Email addresses
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
                // Core licence keys
                .replace(/MSRB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/gi, '[key]')
                // key=value credential pairs
                .replace(
                    /(token|password|secret|cookie|authorization|bearer|passwd|pwd)\s*[=:]\s*\S+/gi,
                    '$1=[redacted]'
                )
                // IPv4 addresses
                .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
                // URLs (could contain credentials or proxy info)
                .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
                // Windows and Unix absolute paths (expose OS username)
                .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
                .replace(/\/home\/[^\s"']+/g, '[path]')
                .replace(/\/Users\/[^\s"']+/g, '[path]')
                // Cap length
                .slice(0, 255)
        )
    }
}
