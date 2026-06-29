'use strict'

// Verifier for the server-signed marketplace catalog (the trust anchor for the
// plugin marketplace). The catalog lists every publishable plugin + its pinned
// hash, plus a revocation/kill-switch list. core-api signs it server-side with the
// MARKETPLACE private key (kept off all client machines); the bot only VERIFIES.
//
// Trust model:
//   - ed25519 detached signature over the RAW bytes of plugins/marketplace.json
//     (reuses scripts/security/SignedManifest.js — the same primitive Core uses,
//     with a SEPARATE key so marketplace trust != premium entitlement).
//   - Multiple trusted public keys (current + next) allow key rotation without a
//     bot release: a catalog verifies if ANY trusted key matches.
//   - Anti-rollback: a monotonic `sequence` (caller persists the last-seen value
//     and passes it as `minSequence`; an older catalog is rejected).
//   - Freshness: `issuedAt` + `ttlSeconds` yields an `expired` flag so the caller
//     can fail-closed offline once a catalog is too stale (TTL grace).
//   - Revocation: per-plugin `revoked` entries and a global `killSwitch`.

const fs = require('fs')
const path = require('path')
const { readPublicKey, verifySignedBytes } = require('./SignedManifest')

const FORMAT = 'msrb-marketplace'
const DEFAULT_KEYS_DIR = path.join(__dirname, 'marketplace-keys')

/** Load every Ed25519 public key (*.pem) from the trusted-keys directory. */
function loadTrustedKeys(keysDir) {
    const dir = keysDir || DEFAULT_KEYS_DIR
    let names = []
    try {
        names = fs.readdirSync(dir).filter(name => /\.pem$/i.test(name))
    } catch {
        return []
    }
    const keys = []
    for (const name of names) {
        try {
            keys.push(readPublicKey(path.join(dir, name)))
        } catch {
            // skip non-Ed25519 / unreadable keys
        }
    }
    return keys
}

/**
 * Verify the marketplace catalog. Returns:
 *   { ok: false, reason }                         on absence/failure
 *   { ok: true, catalog, sequence, expired }      on success
 * `expired` is advisory — the caller decides the offline/stale policy.
 */
function verifyMarketplaceCatalog(options = {}) {
    const root = options.root || process.cwd()
    const catalogPath = options.catalogPath || path.join(root, 'plugins', 'marketplace.json')
    const sigPath = options.sigPath || path.join(root, 'plugins', 'marketplace.sig')

    if (!fs.existsSync(catalogPath) || !fs.existsSync(sigPath)) {
        return { ok: false, reason: 'absent' }
    }

    let payload
    let signature
    try {
        payload = fs.readFileSync(catalogPath) // raw bytes — must match the signed bytes exactly
        signature = fs.readFileSync(sigPath, 'utf8').trim()
    } catch {
        return { ok: false, reason: 'unreadable' }
    }

    return verifyCatalogBytes(payload, signature, {
        keysDir: options.keysDir,
        minSequence: options.minSequence,
        now: options.now
    })
}

/**
 * Verify catalog bytes already in memory (signature + format + anti-rollback +
 * freshness), WITHOUT reading them from disk first. Same return shapes as
 * verifyMarketplaceCatalog. This is what lets the bot verify a freshly-fetched
 * catalog BEFORE swapping it onto disk (verify-before-swap), so an unverified or
 * rolled-back response can never replace the last known-good cached catalog.
 *   @param payload   raw catalog bytes (Buffer or string)
 *   @param signature detached base64 signature (string)
 */
function verifyCatalogBytes(payload, signature, options = {}) {
    const now = typeof options.now === 'number' ? options.now : Date.now()
    const minSequence = typeof options.minSequence === 'number' ? options.minSequence : null
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const sig = String(signature || '').trim()

    const keys = loadTrustedKeys(options.keysDir)
    if (keys.length === 0) {
        return { ok: false, reason: 'no-trusted-keys' }
    }
    const verified = keys.some(key => {
        try {
            verifySignedBytes(bytes, sig, key)
            return true
        } catch {
            return false
        }
    })
    if (!verified) {
        return { ok: false, reason: 'bad-signature' }
    }

    let catalog
    try {
        catalog = JSON.parse(bytes.toString('utf8'))
    } catch {
        return { ok: false, reason: 'parse-error' }
    }
    if (catalog.format !== FORMAT || typeof catalog.sequence !== 'number') {
        return { ok: false, reason: 'bad-format' }
    }
    if (!Array.isArray(catalog.plugins)) {
        return { ok: false, reason: 'bad-format' }
    }
    if (minSequence !== null && catalog.sequence < minSequence) {
        return { ok: false, reason: 'rollback' }
    }

    const issuedAtMs = Date.parse(catalog.issuedAt)
    const ttlMs = (Number(catalog.ttlSeconds) || 0) * 1000
    const expired = Number.isFinite(issuedAtMs) && ttlMs > 0 ? now > issuedAtMs + ttlMs : false

    return { ok: true, catalog, sequence: catalog.sequence, expired }
}

/** Find a catalog entry by name (and optional exact version). */
function findEntry(catalog, name, version) {
    if (!catalog || !Array.isArray(catalog.plugins)) return undefined
    return catalog.plugins.find(entry => entry && entry.name === name && (version === undefined || entry.version === version))
}

/** Numeric dotted version compare (lenient): 1 if a>b, -1 if a<b, 0 if equal. */
function cmpVersion(a, b) {
    const pa = String(a || '').split(/[.\-+]/)
    const pb = String(b || '').split(/[.\-+]/)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i], 10)
        const nb = parseInt(pb[i], 10)
        if (Number.isNaN(na) && Number.isNaN(nb)) continue
        if (Number.isNaN(na)) return -1
        if (Number.isNaN(nb)) return 1
        if (na > nb) return 1
        if (na < nb) return -1
    }
    return 0
}

// ── plugin staleness (auto bot-version compatibility) ─────────────────────────
// A plugin is stamped (server-side, at publish) with the bot version current at the
// time. We DON'T block old plugins — we just flag them as possibly outdated once the
// running bot has moved more than a window ahead of that stamp. Coarse distance:
// major*10000 + minor*100 + patch, so the window (~20) trips after ~20 patch updates
// in the same minor, or after any minor/major bump.
const DEFAULT_STALE_WINDOW = 20

function coarseVersion(v) {
    const m = String(v || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!m) return null
    return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] || 0)
}

/** How far `botVersion` is AHEAD of `publishedBotVersion` (0 if not ahead / unknown). */
function botAheadDistance(publishedBotVersion, botVersion) {
    const p = coarseVersion(publishedBotVersion)
    const b = coarseVersion(botVersion)
    if (p == null || b == null) return 0
    return Math.max(0, b - p)
}

/** True when the running bot is more than `window` ahead of the plugin's stamp. */
function isPluginStale(publishedBotVersion, botVersion, window) {
    if (!publishedBotVersion || !botVersion) return false
    const w = Number.isFinite(window) && window > 0 ? window : DEFAULT_STALE_WINDOW
    return botAheadDistance(publishedBotVersion, botVersion) > w
}

/** The highest-version catalog entry for `name` (the "latest approved"), or undefined. */
function findLatestEntry(catalog, name) {
    if (!catalog || !Array.isArray(catalog.plugins)) return undefined
    let best
    for (const entry of catalog.plugins) {
        if (!entry || entry.name !== name) continue
        if (!best || cmpVersion(entry.version, best.version) > 0) best = entry
    }
    return best
}

/**
 * True if the plugin is revoked by the signed catalog — either the global kill
 * switch is on, or a `revoked` entry matches by name(+version) or by sha256.
 */
function isRevoked(catalog, { name, version, sha256 } = {}) {
    if (!catalog) return false
    if (catalog.killSwitch === true) return true
    if (!Array.isArray(catalog.revoked)) return false
    return catalog.revoked.some(entry => {
        if (!entry) return false
        if (sha256 && entry.sha256 && entry.sha256.toLowerCase() === String(sha256).toLowerCase()) return true
        if (entry.name && entry.name === name) {
            return entry.version === undefined || entry.version === version
        }
        return false
    })
}

module.exports = { verifyMarketplaceCatalog, verifyCatalogBytes, loadTrustedKeys, findEntry, findLatestEntry, cmpVersion, isRevoked, isPluginStale, botAheadDistance, FORMAT, DEFAULT_KEYS_DIR }
