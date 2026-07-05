// Desk-side anonymous telemetry, mirroring the bot's AnalyticsService contract:
// events are POSTed to the Core-API relay (never to PostHog directly), identified
// by the SAME anonymous instance id file the bot uses (data/msrb-analytics-id), and
// gated by the same config flag (analytics.enabled). Fire-and-forget: a failed or
// slow send can never affect the Desk.
//
// Only event names already whitelisted by the relay are used here:
// `desk_session_ended` and `feature_toggled`.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ANALYTICS_ENDPOINT = 'https://bot.lgtw.tf/api/bot/inbox'
const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEND_TIMEOUT_MS = 5000

function createDeskAnalytics({ root, readConfigRaw, version }) {
    const sessionStartedAt = Date.now()
    const instanceIdFile = path.join(root, 'data', 'msrb-analytics-id')
    let cachedInstanceId = null

    function enabled() {
        try {
            const cfg = readConfigRaw()
            return !cfg.analytics || cfg.analytics.enabled !== false
        } catch {
            return true
        }
    }

    // Same file and format as the bot's AnalyticsService, so the Desk and the bot
    // count as ONE anonymous instance (and stay within the relay's per-IP id cap).
    function instanceId() {
        if (cachedInstanceId) return cachedInstanceId
        try {
            const existing = fs.readFileSync(instanceIdFile, 'utf8').trim()
            if (INSTANCE_ID_RE.test(existing)) {
                cachedInstanceId = existing
                return cachedInstanceId
            }
        } catch { /* missing or unreadable — create below */ }
        cachedInstanceId = crypto.randomUUID()
        try {
            fs.mkdirSync(path.dirname(instanceIdFile), { recursive: true })
            fs.writeFileSync(instanceIdFile, cachedInstanceId, 'utf8')
        } catch { /* best-effort: session-only id */ }
        return cachedInstanceId
    }

    function track(event, properties = {}) {
        if (!enabled()) return
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
            fetch(ANALYTICS_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    type: 'analytics_event',
                    instanceId: instanceId(),
                    event,
                    properties: {
                        surface: 'desk',
                        bot_version: version,
                        os: process.platform,
                        arch: process.arch,
                        node_version: process.version,
                        ...properties
                    }
                })
            }).catch(() => undefined).finally(() => clearTimeout(timer))
        } catch { /* telemetry must never throw into the Desk */ }
    }

    // One `feature_toggled` per leaf of a settings patch. Only booleans and finite
    // numbers are reported — string values (webhook URLs, ntfy topics, tokens…) are
    // dropped so nothing user-identifying can leave the machine.
    function trackSettingsPatch(patch) {
        const leaves = []
        const walk = (node, prefix) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return
            for (const [key, value] of Object.entries(node)) {
                const dotPath = prefix ? `${prefix}.${key}` : key
                if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, dotPath)
                else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
                    leaves.push({ key: dotPath, value })
                }
            }
        }
        walk(patch, '')
        // If this very patch turns analytics off, honour the new preference and skip.
        if (leaves.some(leaf => leaf.key === 'analytics.enabled' && leaf.value === false)) return
        for (const leaf of leaves.slice(0, 10)) {
            track('feature_toggled', { key: leaf.key, value: leaf.value })
        }
    }

    function trackSessionEnd(extra = {}) {
        track('desk_session_ended', {
            duration_s: Math.round((Date.now() - sessionStartedAt) / 1000),
            ...extra
        })
    }

    return { track, trackSettingsPatch, trackSessionEnd }
}

module.exports = { createDeskAnalytics }
