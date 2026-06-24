'use strict'

// On-demand installer for marketplace plugins. Given a verified signed catalog
// (from scripts/security/marketplace-catalog.js) and a plugins.jsonc entry that
// declares { source: 'marketplace', version }, this ensures the plugin source is
// present on disk under plugins/<name>/index.js, fetched + verified fail-closed:
//   in catalog → not revoked → version-compatible → sha256 matches → write.
//
// The fetcher is injected (real runtime = an HTTPS GET from jsDelivr; tests pass a
// local fetcher), so this module is network-free and fully testable. Marketplace
// plugins ship as a single JavaScript source file (sandboxed plugins are JS source
// anyway); multi-file/tree archives (treeSha256) are a future extension.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const semver = require('semver')
const { findEntry, isRevoked } = require('./security/marketplace-catalog')

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex')
}

function atomicWrite(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
    )
    let fd
    try {
        fd = fs.openSync(tempPath, 'wx', 0o600)
        fs.writeFileSync(fd, data)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(tempPath, filePath)
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(tempPath, { force: true })
    }
}

// Compatible when the plugin's required API major version equals the bot's.
function apiCompatible(required, current) {
    if (!required) return true
    const r = semver.coerce(required)
    const c = semver.coerce(current)
    return Boolean(r && c && r.major === c.major)
}

/**
 * Ensure a marketplace plugin is installed and current. Returns
 * { installed: boolean, reason, version? }. Never throws for policy rejections
 * (returns a reason); only unexpected I/O errors propagate.
 *
 * @param {object} o
 * @param {string} o.root              project root (plugins/ lives here)
 * @param {string} o.name              plugin entry name
 * @param {string} [o.requestedVersion] pin from plugins.jsonc (optional)
 * @param {object} o.catalog           VERIFIED signed catalog object
 * @param {(url: string) => Promise<Buffer|Uint8Array|string>} o.fetcher
 * @param {string} [o.botVersion]      for botVersionRange gating
 * @param {string} [o.apiVersion]      PLUGIN_API_VERSION for apiVersion gating
 * @param {string} [o.now]            timestamp string for the install marker
 */
async function ensureMarketplacePlugin(o) {
    const { root, name, requestedVersion, catalog, fetcher, botVersion, apiVersion, now } = o

    const entry = findEntry(catalog, name, requestedVersion)
    if (!entry) return { installed: false, reason: 'not-in-catalog' }
    if (!entry.sha256) return { installed: false, reason: 'unpinned' }
    if (isRevoked(catalog, { name, version: entry.version, sha256: entry.sha256 })) {
        return { installed: false, reason: 'revoked' }
    }
    if (entry.botVersionRange && botVersion && !semver.satisfies(semver.coerce(botVersion) || '0.0.0', entry.botVersionRange)) {
        return { installed: false, reason: 'incompatible-bot' }
    }
    if (!apiCompatible(entry.apiVersion, apiVersion)) {
        return { installed: false, reason: 'incompatible-api' }
    }

    const expected = String(entry.sha256).toLowerCase()
    const targetDir = path.join(root, 'plugins', name)
    const indexPath = path.join(targetDir, 'index.js')
    const markerPath = path.join(targetDir, '.installed.json')

    // Already installed at the right version + verified on disk?
    if (fs.existsSync(indexPath) && fs.existsSync(markerPath)) {
        try {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
            if (
                marker.version === entry.version &&
                String(marker.sha256).toLowerCase() === expected &&
                sha256(fs.readFileSync(indexPath)) === expected
            ) {
                return { installed: true, reason: 'up-to-date', version: entry.version }
            }
        } catch {
            // fall through to reinstall
        }
    }

    if (typeof fetcher !== 'function') return { installed: false, reason: 'no-fetcher' }

    const fetched = await fetcher(entry.installUrl)
    const bytes = Buffer.isBuffer(fetched) ? fetched : Buffer.from(fetched)
    if (sha256(bytes) !== expected) {
        return { installed: false, reason: 'sha-mismatch' }
    }

    atomicWrite(indexPath, bytes)
    atomicWrite(markerPath, JSON.stringify({ name, version: entry.version, sha256: expected, installedAt: now || null }, null, 2))
    return { installed: true, reason: 'installed', version: entry.version }
}

module.exports = { ensureMarketplacePlugin, sha256, apiCompatible }
