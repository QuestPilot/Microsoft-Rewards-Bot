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
const { findEntry, findLatestEntry, cmpVersion, isRevoked } = require('./security/marketplace-catalog')

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
 * { installed: boolean, reason, version?, updateAvailable? }. Never throws for
 * policy rejections (returns a reason); only unexpected I/O errors propagate.
 *
 * Version resolution:
 *   - pinned (`requestedVersion`): that exact version, never auto-updated.
 *   - unpinned + (`autoUpdate === false` OR Trusted Mode `trust === 'full'`): HELD
 *     at the installed version — no silent update (a first install still takes the
 *     latest). Trusted plugins are held so new full-access code is never run without
 *     an explicit manual update.
 *   - unpinned otherwise: the latest approved version (auto-update, default on).
 *
 * @param {object} o
 * @param {string} o.root              project root (plugins/ lives here)
 * @param {string} o.name              plugin entry name
 * @param {string} [o.requestedVersion] pin from plugins.jsonc (optional)
 * @param {boolean} [o.autoUpdate]     false to hold an unpinned plugin (default true)
 * @param {string} [o.trust]           'full' holds the plugin back from silent updates
 * @param {object} o.catalog           VERIFIED signed catalog object
 * @param {(url: string) => Promise<Buffer|Uint8Array|string>} o.fetcher
 * @param {string} [o.botVersion]      for botVersionRange gating
 * @param {string} [o.apiVersion]      PLUGIN_API_VERSION for apiVersion gating
 * @param {string} [o.now]            timestamp string for the install marker
 */
async function ensureMarketplacePlugin(o) {
    const { root, name, requestedVersion, catalog, fetcher, botVersion, apiVersion, now, autoUpdate, trust } = o

    const targetDir = path.join(root, 'plugins', name)
    const indexPath = path.join(targetDir, 'index.js')
    const markerPath = path.join(targetDir, '.installed.json')

    // Global kill switch — purge the plugin from disk and refuse.
    if (catalog && catalog.killSwitch === true) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        return { installed: false, reason: 'kill-switch' }
    }

    // What's installed on disk right now (drives held / update-available decisions).
    let installedVersion
    try { installedVersion = JSON.parse(fs.readFileSync(markerPath, 'utf8')).version } catch {}

    const latest = findLatestEntry(catalog, name)
    const held = autoUpdate === false || trust === 'full'

    let entry
    if (requestedVersion) {
        entry = findEntry(catalog, name, requestedVersion)
    } else if (held && installedVersion) {
        entry = findEntry(catalog, name, installedVersion)
        if (!entry) {
            // Installed version is no longer published. Keep the on-disk bytes — the
            // load-time trust gate re-verifies them against the catalog and refuses if
            // it has been pulled; surface that a newer version exists.
            return { installed: true, reason: 'held', version: installedVersion, updateAvailable: latest ? latest.version : undefined }
        }
    } else {
        entry = latest
    }

    if (!entry) return { installed: false, reason: 'not-in-catalog' }
    if (!entry.sha256) return { installed: false, reason: 'unpinned' }
    if (isRevoked(catalog, { name, version: entry.version, sha256: entry.sha256 })) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        return { installed: false, reason: 'revoked' }
    }
    if (entry.botVersionRange && botVersion && !semver.satisfies(semver.coerce(botVersion) || '0.0.0', entry.botVersionRange)) {
        return { installed: false, reason: 'incompatible-bot' }
    }
    if (!apiCompatible(entry.apiVersion, apiVersion)) {
        return { installed: false, reason: 'incompatible-api' }
    }

    const expected = String(entry.sha256).toLowerCase()
    // Surfaced to the Desk: a newer approved version than the one we're installing
    // (true for held / pinned plugins sitting on an older version).
    const updateAvailable = (latest && latest.version !== entry.version && cmpVersion(latest.version, entry.version) > 0)
        ? latest.version
        : undefined

    // Already installed at the target version + verified on disk?
    if (fs.existsSync(indexPath) && fs.existsSync(markerPath)) {
        try {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
            if (
                marker.version === entry.version &&
                String(marker.sha256).toLowerCase() === expected &&
                sha256(fs.readFileSync(indexPath)) === expected
            ) {
                return { installed: true, reason: 'up-to-date', version: entry.version, updateAvailable }
            }
        } catch {
            // fall through to reinstall
        }
    }

    // Correct bytes already on disk (marker lost, or a verified manual drop):
    // adopt them, refresh the marker, and skip the download (self-heal without network).
    if (fs.existsSync(indexPath)) {
        try {
            if (sha256(fs.readFileSync(indexPath)) === expected) {
                atomicWrite(markerPath, JSON.stringify({ name, version: entry.version, sha256: expected, installedAt: now || null }, null, 2))
                return { installed: true, reason: 'up-to-date', version: entry.version, updateAvailable }
            }
        } catch {
            // fall through to (re)download
        }
    }

    if (typeof fetcher !== 'function') return { installed: false, reason: 'no-fetcher' }

    const fetched = await fetcher(entry.installUrl)
    const bytes = Buffer.isBuffer(fetched) ? fetched : Buffer.from(fetched)
    if (sha256(bytes) !== expected) {
        return { installed: false, reason: 'sha-mismatch' }
    }

    const wasUpdate = Boolean(installedVersion && installedVersion !== entry.version)
    atomicWrite(indexPath, bytes)
    atomicWrite(markerPath, JSON.stringify({ name, version: entry.version, sha256: expected, installedAt: now || null }, null, 2))
    return { installed: true, reason: wasUpdate ? 'updated' : 'installed', version: entry.version, updateAvailable }
}

module.exports = { ensureMarketplacePlugin, sha256, apiCompatible }
