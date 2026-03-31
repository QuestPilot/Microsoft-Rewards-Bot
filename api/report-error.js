const axios = require('axios')
const crypto = require('crypto')

// In-memory rate limiting for error reporting
const rateLimitMap = new Map()
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10

// In-memory deduplication cache for identical errors
const errorCache = new Map()
const ERROR_TTL_MS = 60 * 60 * 1000 // 1 hour dedupe window

function isRateLimited(ip) {
    const now = Date.now()
    const record = rateLimitMap.get(ip)

    if (!record || now > record.resetTime) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
        return false
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
        return true
    }

    record.count++
    return false
}

// Sanitize text to prevent Discord mention abuse
function sanitizeDiscordText(text) {
    if (!text) return ''
    return String(text)
        // Remove @everyone and @here mentions
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        // Remove user mentions <@123456>
        .replace(/<@!?(\d+)>/g, '@user')
        // Remove role mentions <@&123456>
        .replace(/<@&(\d+)>/g, '@role')
        // Remove channel mentions <#123456>
        .replace(/<#(\d+)>/g, '#channel')
        // Limit length
        .slice(0, 2000)
}

function normalizeForId(text) {
    if (!text) return ''
    let t = String(text)
    // Remove ISO timestamps
    t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, '')
    // Remove hex pointers
    t = t.replace(/0x[0-9a-fA-F]+/g, '')
    // Replace absolute paths
    t = t.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:]*)/g, '[PATH]')
    // Remove :line:col
    t = t.replace(/:\d+(?::\d+)?/g, '')
    // Collapse whitespace
    return t.replace(/\s+/g, ' ').trim()
}

function computeErrorId(payload) {
    const parts = []
    parts.push(normalizeForId(payload.error || ''))
    if (payload.stack) parts.push(normalizeForId(payload.stack))

    const ctx = payload.context || {}
    const ctxKeys = Object.keys(ctx).filter(k => k !== 'timestamp').sort()
    for (const k of ctxKeys) parts.push(`${k}=${String(ctx[k])}`)

    const add = payload.additionalContext || {}
    const addKeys = Object.keys(add).sort()
    for (const k of addKeys) parts.push(`${k}=${String(add[k])}`)

    const canonical = parts.join('|')
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

// Vercel serverless handler
module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end()
    }

    // Only POST allowed
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    try {
        // Rate limiting
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
        if (isRateLimited(ip)) {
            return res.status(429).json({ error: 'Rate limit exceeded' })
        }

        // Check Discord webhook URL
        const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL
        if (!webhookUrl) {
            console.error('[ErrorReporting] DISCORD_ERROR_WEBHOOK_URL not configured')
            return res.status(503).json({ error: 'Error reporting service unavailable' })
        }

        // Validate payload
        const payload = req.body
        if (!payload?.error) {
            return res.status(400).json({ error: 'Invalid payload: missing error field' })
        }

        // Sanitize all text fields to prevent Discord mention abuse
        const sanitizedError = sanitizeDiscordText(payload.error)
        const sanitizedStack = payload.stack ? sanitizeDiscordText(payload.stack) : null
        const sanitizedVersion = sanitizeDiscordText(payload.context?.version || 'unknown')
        const sanitizedPlatform = sanitizeDiscordText(payload.context?.platform || 'unknown')
        const sanitizedNode = sanitizeDiscordText(payload.context?.nodeVersion || 'unknown')

        // Compute deterministic error id and check dedupe cache
        const computedId = computeErrorId({ error: sanitizedError, stack: sanitizedStack, context: payload.context, additionalContext: payload.additionalContext })
        const now = Date.now()
        const existing = errorCache.get(computedId)
        if (existing && existing.expires > now) {
            existing.count = (existing.count || 0) + 1
            errorCache.set(computedId, existing)
            console.log(`[ErrorReporting] Duplicate error (id=${computedId}) suppressed; count=${existing.count}`)
            return res.json({ success: true, duplicate: true, id: computedId })
        }
        // Store in cache to prevent spam of same error within window
        errorCache.set(computedId, { expires: now + ERROR_TTL_MS, count: 1 })

        // Build Discord embed with Error ID included in footer
        const embed = {
            title: '🔴 Bot Error Report',
            description: `\`\`\`\n${sanitizedError.slice(0, 1900)}\n\`\`\``,
            color: 0xdc143c,
            fields: [
                { name: 'Version', value: sanitizedVersion, inline: true },
                { name: 'Platform', value: sanitizedPlatform, inline: true },
                { name: 'Node', value: sanitizedNode, inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: `Community Error Reporting — Error ID: ${computedId}` }
        }

        if (sanitizedStack) {
            const stackLines = sanitizedStack.split('\n').slice(0, 15).join('\n')
            embed.fields.push({
                name: 'Stack Trace',
                value: `\`\`\`\n${stackLines.slice(0, 1000)}\n\`\`\``,
                inline: false
            })
        }

        // Send to Discord
        await axios.post(webhookUrl, {
            username: 'Microsoft Rewards Bot',
            avatar_url: 'https://raw.githubusercontent.com/LightZirconite/Microsoft-Rewards-Bot/refs/heads/main/assets/logo.png',
            embeds: [embed]
        }, { timeout: 10000 })

        console.log(`[ErrorReporting] Report sent successfully (id=${computedId})`)
        return res.json({ success: true, message: 'Error report received', id: computedId })

    } catch (error) {
        console.error('[ErrorReporting] Failed:', error)
        return res.status(500).json({
            error: 'Failed to send error report',
            message: error.message || 'Unknown error'
        })
    }
}
