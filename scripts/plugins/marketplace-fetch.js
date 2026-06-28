'use strict'

// Marketplace network fetches. Two callers, two trust policies:
//   - fetchMarketplaceAsset(url): downloads a plugin's source from the public CDN
//     named by the SIGNED catalog's `installUrl`. Host-allowlisted (jsDelivr/GitHub),
//     but the REAL gate is the sha256 pin enforced by scripts/plugin-installer.js.
//   - fetchSignedCatalog(url): pulls the signed catalog {catalog, signature} from
//     core-api (operator-configured URL, e.g. https://bot.lgtw.tf/api/marketplace/
//     catalog). HTTPS-only; the Ed25519 signature is the gate (verified fail-closed
//     by scripts/security/marketplace-catalog.js), so the host is not allowlisted.
//
// Both share one hardened GET (redirect cap, timeout, byte cap) that mirrors the
// updater's requestBuffer — kept here with its own policy so marketplace trust stays
// decoupled from auto-update trust.

const https = require('https')
const { URL } = require('url')

const DEFAULT_ALLOWED_HOSTS = [
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'gcore.jsdelivr.net',
    'originfastly.jsdelivr.net',
    'data.jsdelivr.com',
    'raw.githubusercontent.com',
    'github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]

function allowedHosts() {
    const extra = String(process.env.MSRB_MARKETPLACE_FETCH_HOSTS || '')
        .split(',')
        .map(host => host.trim().toLowerCase())
        .filter(Boolean)
    return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])
}

function assertAllowedAssetUrl(url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !allowedHosts().has(parsed.hostname.toLowerCase())) {
        throw new Error(`Marketplace fetch refused untrusted URL: ${parsed.protocol}//${parsed.host}`)
    }
}

function assertHttpsUrl(url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
        throw new Error(`Marketplace catalog URL must be https: ${parsed.protocol}//${parsed.host}`)
    }
}

// Hardened HTTPS GET -> Buffer. `assertUrl(url)` enforces the caller's host policy.
function httpGetBuffer(url, options) {
    const { timeoutMs, maxBytes, maxRedirects, assertUrl } = options
    const redirects = options.redirects ?? 0
    assertUrl(url)
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                timeout: timeoutMs,
                headers: {
                    'user-agent': 'msrb-marketplace',
                    accept: 'application/json, text/javascript, application/javascript, application/octet-stream, */*;q=0.5',
                    'cache-control': 'no-cache'
                }
            },
            response => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    response.resume()
                    if (redirects >= maxRedirects) {
                        reject(new Error(`Too many redirects while fetching ${url}`))
                        return
                    }
                    httpGetBuffer(new URL(response.headers.location, url).toString(), { ...options, redirects: redirects + 1 }).then(
                        resolve,
                        reject
                    )
                    return
                }

                const chunks = []
                let received = 0
                response.on('error', reject)
                response.on('data', chunk => {
                    received += chunk.length
                    if (received > maxBytes) {
                        response.destroy(new Error(`Response exceeded ${maxBytes} bytes: ${url}`))
                        return
                    }
                    chunks.push(chunk)
                })
                response.on('end', () => {
                    const body = Buffer.concat(chunks)
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`HTTP ${response.statusCode} while fetching ${url}: ${body.toString('utf8').slice(0, 200)}`))
                        return
                    }
                    resolve(body)
                })
            }
        )

        request.on('timeout', () => request.destroy(new Error(`Marketplace fetch timed out after ${timeoutMs}ms`)))
        request.on('error', reject)
    })
}

/** Download a marketplace plugin asset (host-allowlisted). Returns raw bytes. */
function fetchMarketplaceAsset(url, options = {}) {
    return httpGetBuffer(url, {
        timeoutMs: options.timeoutMs ?? 45_000,
        maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
        maxRedirects: options.maxRedirects ?? 5,
        assertUrl: assertAllowedAssetUrl
    })
}

/** Fetch the signed catalog { catalog, signature } from core-api (HTTPS-only). */
async function fetchSignedCatalog(url, options = {}) {
    const body = await httpGetBuffer(url, {
        timeoutMs: options.timeoutMs ?? 20_000,
        maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
        maxRedirects: options.maxRedirects ?? 5,
        assertUrl: assertHttpsUrl
    })
    let json
    try {
        json = JSON.parse(body.toString('utf8'))
    } catch {
        throw new Error('Marketplace catalog response is not valid JSON')
    }
    if (!json || typeof json.catalog !== 'string' || typeof json.signature !== 'string') {
        throw new Error('Marketplace catalog response must be { catalog, signature }')
    }
    return { catalog: json.catalog, signature: json.signature }
}

module.exports = { fetchMarketplaceAsset, fetchSignedCatalog, assertAllowedAssetUrl, DEFAULT_ALLOWED_HOSTS }
