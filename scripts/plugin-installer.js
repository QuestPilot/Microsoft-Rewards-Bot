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

    // Multi-file plugin: the signed catalog carries a files[] manifest — fetch + verify
    // every file and install the whole tree. Single-file plugins keep the path below.
    if (Array.isArray(entry.files) && entry.files.length > 0) {
        return ensureTree({ targetDir, name, entry, fetcher, now, updateAvailable, installedVersion })
    }

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

// ── multi-file (tree) install ─────────────────────────────────────────────────
// A relative path that cannot escape the plugin directory, or null if unsafe.
function safeTreePath(rel) {
    if (typeof rel !== 'string' || !rel) return null
    if (rel.includes('..') || path.isAbsolute(rel) || /^[\\/]/.test(rel)) return null
    return rel.replace(/\\/g, '/')
}

// True when every manifest file exists under `dir` with a matching sha256.
function treeMatches(dir, manifest) {
    for (const file of manifest) {
        try {
            if (sha256(fs.readFileSync(path.join(dir, file.path))) !== file.sha256) return false
        } catch {
            return false
        }
    }
    return true
}

/**
 * Install a multi-file marketplace plugin: fetch + verify EVERY file in the signed
 * manifest, stage them in a temp dir, then swap into plugins/<name>/. Fail closed —
 * nothing is written unless all files match their pinned sha256.
 */
async function ensureTree({ targetDir, name, entry, fetcher, now, updateAvailable, installedVersion }) {
    const base = String(entry.installUrl || '')
    const manifest = []
    for (const file of entry.files) {
        const rel = safeTreePath(file && file.path)
        if (!rel || typeof (file && file.sha256) !== 'string') return { installed: false, reason: 'bad-manifest' }
        manifest.push({ path: rel, sha256: String(file.sha256).toLowerCase() })
    }
    if (!manifest.some(file => file.path === 'index.js')) return { installed: false, reason: 'no-entry-file' }
    const markerPath = path.join(targetDir, '.installed.json')

    // Up-to-date? marker matches the manifest AND every file verifies on disk.
    try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
        if (marker.version === entry.version && marker.manifestSha256 === entry.manifestSha256 && treeMatches(targetDir, manifest)) {
            return { installed: true, reason: 'up-to-date', version: entry.version, updateAvailable }
        }
    } catch {
        // fall through to (re)install
    }
    // Self-heal: a correct tree is already on disk (marker lost / verified manual drop).
    if (fs.existsSync(path.join(targetDir, 'index.js')) && treeMatches(targetDir, manifest)) {
        atomicWrite(markerPath, JSON.stringify({ name, version: entry.version, manifestSha256: entry.manifestSha256, files: manifest, installedAt: now || null }, null, 2))
        return { installed: true, reason: 'up-to-date', version: entry.version, updateAvailable }
    }

    if (typeof fetcher !== 'function') return { installed: false, reason: 'no-fetcher' }

    // Fetch + verify EVERY file into memory before touching disk (fail closed).
    const fetched = []
    for (const file of manifest) {
        const raw = await fetcher(base + file.path)
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        if (sha256(bytes) !== file.sha256) return { installed: false, reason: 'sha-mismatch' }
        fetched.push({ path: file.path, bytes })
    }

    // Stage in a temp dir, then swap into place (replacing any older version).
    const tmpDir = targetDir + '.tmp-' + crypto.randomBytes(4).toString('hex')
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        for (const file of fetched) {
            const dest = path.join(tmpDir, file.path)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, file.bytes)
        }
        fs.writeFileSync(
            path.join(tmpDir, '.installed.json'),
            JSON.stringify({ name, version: entry.version, manifestSha256: entry.manifestSha256, files: manifest, installedAt: now || null }, null, 2)
        )
        fs.rmSync(targetDir, { recursive: true, force: true })
        fs.renameSync(tmpDir, targetDir)
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    const wasUpdate = Boolean(installedVersion && installedVersion !== entry.version)
    return { installed: true, reason: wasUpdate ? 'updated' : 'installed', version: entry.version, updateAvailable }
}

module.exports = { ensureMarketplacePlugin, sha256, apiCompatible }
