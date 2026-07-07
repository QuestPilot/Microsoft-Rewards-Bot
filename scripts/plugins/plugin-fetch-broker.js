'use strict'

// Host-side broker for the ELEVATED `net:<host>` capability. The V8 isolate has no
// network of its own; a plugin's ctx.fetch is bridged to this broker, which performs
// the request on the host and returns a plain-JSON response back across the boundary.
//
// The broker is the security boundary for plugin network access:
//   - https only (no http, file, data, etc.);
//   - the target host must be in the plugin's GRANTED allowlist (declared as
//     `net:<host>` in the manifest AND consented to by the user in the Desk);
//   - IP-literal, loopback and *.local/*.internal targets are refused outright, which
//     blocks SSRF to link-local metadata endpoints and private ranges;
//   - redirects are refused (a 3xx to an un-allowlisted host cannot smuggle through);
//   - request headers are limited to a safe allowlist; response body is size- and
//     time-capped so a hostile endpoint cannot exhaust memory or hang the run.

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_BYTES = 512 * 1024
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'content-type', 'authorization', 'x-api-key'])

function isDangerousHost(host) {
    if (!host) return true
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true // IPv4 literal (covers 127.*, 10.*, 169.254.*, …)
    if (host.includes(':')) return true // IPv6 literal (URL strips the [brackets])
    return false
}

function validateUrl(rawUrl, allow) {
    let u
    try {
        u = new URL(String(rawUrl))
    } catch {
        throw new Error('invalid URL')
    }
    if (u.protocol !== 'https:') throw new Error('only https:// URLs are allowed')
    const host = u.hostname.toLowerCase()
    if (isDangerousHost(host)) throw new Error('this host is not allowed')
    if (!allow.has(host)) throw new Error(`host "${host}" is not in the plugin's granted network permissions`)
    return u
}

function sanitizeHeaders(headers) {
    const out = {}
    if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
            const k = String(key).toLowerCase()
            if (ALLOWED_REQUEST_HEADERS.has(k) && (typeof value === 'string' || typeof value === 'number')) {
                out[k] = String(value).slice(0, 4096)
            }
        }
    }
    return out
}

async function readCapped(res, maxBytes) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text()
        return text.length > maxBytes ? text.slice(0, maxBytes) : text
    }
    const reader = res.body.getReader()
    const chunks = []
    let received = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (received > maxBytes) {
            try { await reader.cancel() } catch {}
            throw new Error('response exceeds the size cap')
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {object} opts
 * @param {string[]} opts.allowedHosts  Granted hostnames (declared ∩ consented).
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 * @param {(url:string, init:object)=>Promise<Response>} [opts.fetchImpl]  Injectable for tests.
 */
function createFetchBroker(opts = {}) {
    const allow = new Set((opts.allowedHosts || []).map(h => String(h).toLowerCase()))
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch

    async function doFetch(url, options = {}) {
        if (allow.size === 0) throw new Error('this plugin has no granted network permissions')
        if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this runtime')
        const target = validateUrl(url, allow)
        const method = String((options && options.method) || 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'POST') throw new Error('only GET and POST are allowed')
        const headers = sanitizeHeaders(options && options.headers)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const res = await fetchImpl(target.href, {
                method,
                headers,
                body: method === 'POST' && options && options.body != null ? String(options.body) : undefined,
                redirect: 'manual',
                signal: controller.signal,
            })
            if (res.status >= 300 && res.status < 400) throw new Error('redirects are not allowed')
            const body = await readCapped(res, maxBytes)
            const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || ''
            return { ok: !!res.ok, status: res.status || 0, headers: { 'content-type': contentType }, body }
        } catch (err) {
            if (err && err.name === 'AbortError') throw new Error('request timed out')
            throw err
        } finally {
            clearTimeout(timer)
        }
    }

    return {
        allowedHosts: [...allow],
        fetch: doFetch,
        /** Bridge entry point: JSON args in, a JSON PluginFetchResponse (or error shape) out. */
        async fetchJson(argsJson) {
            let args
            try { args = JSON.parse(argsJson) } catch { args = {} }
            try {
                return JSON.stringify(await doFetch(String(args.url || ''), args.options || {}))
            } catch (err) {
                return JSON.stringify({ ok: false, status: 0, headers: {}, body: '', error: err instanceof Error ? err.message : String(err) })
            }
        },
    }
}

module.exports = { createFetchBroker, isDangerousHost }
