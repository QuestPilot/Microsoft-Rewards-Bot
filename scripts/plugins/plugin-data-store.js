'use strict'

// Shared plugin capability backend (Phase 2). One module, used by BOTH sides:
//   - the bot (src/core/PluginManager.ts) builds ctx.settings / ctx.storage / ctx.ui
//     from here for in-process AND sandboxed plugins;
//   - the Desk (scripts/desk) reads the manifest, resolved settings and the last panel
//     snapshot from here to render a plugin's slice of the Plugins page.
// Keeping it in one place is what guarantees the Desk shows exactly what the bot runs.
//
// Nothing here executes plugin code. The manifest (plugins/<name>/plugin.json) is the
// static source of truth for the settings schema + declared permissions; per-plugin
// runtime state lives under plugins/.data/<name>/ (storage.json, panel.json,
// settings.json) — a dot-dir so it is never mistaken for a plugin.

const fs = require('fs')
const path = require('path')

const MAX_STORAGE_BYTES = 256 * 1024 // whole KV store, serialized
const MAX_PANEL_BYTES = 32 * 1024
const MAX_PANEL_STATS = 12
const MAX_PANEL_LINES = 20
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/i

function isSafeName(name) {
    return typeof name === 'string' && NAME_RE.test(name)
}

function dataDir(root, name) {
    return path.join(root, 'plugins', '.data', name)
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value))
    fs.renameSync(tmp, filePath)
}

function readJson(filePath, fallback) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
        return fallback
    }
}

/** The plugin's static manifest (plugins/<name>/plugin.json), or {} if absent/invalid. */
function readManifest(root, name) {
    if (!isSafeName(name)) return {}
    const manifest = readJson(path.join(root, 'plugins', name, 'plugin.json'), {})
    // Only surface the fields we understand; ignore anything else.
    const settings = Array.isArray(manifest.settings) ? manifest.settings.filter(isValidSettingField) : []
    const permissions = Array.isArray(manifest.permissions)
        ? manifest.permissions.filter(p => typeof p === 'string').slice(0, 24)
        : []
    return {
        name: typeof manifest.name === 'string' ? manifest.name : name,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        author: typeof manifest.author === 'string' ? manifest.author : '',
        permissions,
        settings,
    }
}

function isValidSettingField(field) {
    return (
        field &&
        typeof field === 'object' &&
        typeof field.key === 'string' &&
        /^[a-z0-9][a-z0-9._-]{0,48}$/i.test(field.key) &&
        ['number', 'text', 'toggle', 'select'].includes(field.type) &&
        typeof field.label === 'string'
    )
}

/** User-set settings values (written by the Desk), or {} — plugins/.data/<name>/settings.json. */
function readSettingsValues(root, name) {
    if (!isSafeName(name)) return {}
    return readJson(path.join(dataDir(root, name), 'settings.json'), {})
}

/** Persist the user-set settings values (Desk write path). Coerces to the schema types. */
function writeSettingsValues(root, name, values) {
    if (!isSafeName(name)) throw new Error('Invalid plugin name')
    const schema = readManifest(root, name).settings
    const clean = coerceToSchema(schema, values)
    atomicWriteJson(path.join(dataDir(root, name), 'settings.json'), clean)
    return clean
}

function coerceToSchema(schema, values) {
    const out = {}
    const byKey = new Map(schema.map(f => [f.key, f]))
    for (const [key, raw] of Object.entries(values || {})) {
        const field = byKey.get(key)
        if (!field) continue // ignore keys not in the schema
        out[key] = coerceValue(field, raw)
    }
    return out
}

function coerceValue(field, raw) {
    if (field.type === 'number') {
        let n = Number(raw)
        if (!Number.isFinite(n)) n = typeof field.default === 'number' ? field.default : 0
        if (typeof field.min === 'number') n = Math.max(field.min, n)
        if (typeof field.max === 'number') n = Math.min(field.max, n)
        return n
    }
    if (field.type === 'toggle') return Boolean(raw)
    if (field.type === 'select') {
        const allowed = Array.isArray(field.options) ? field.options.map(o => o && o.value) : []
        const v = String(raw)
        return allowed.includes(v) ? v : (typeof field.default === 'string' ? field.default : allowed[0] || '')
    }
    return String(raw == null ? '' : raw).slice(0, 2000) // text
}

/**
 * Resolve the settings the plugin actually sees at runtime: schema defaults, overlaid
 * with plugins.jsonc `config`, overlaid with the values the user set in the Desk.
 */
function resolveSettings(root, name, pluginConfig) {
    const schema = readManifest(root, name).settings
    const resolved = {}
    for (const field of schema) {
        if (field.default !== undefined) resolved[field.key] = field.default
    }
    if (pluginConfig && typeof pluginConfig === 'object') {
        for (const field of schema) {
            if (pluginConfig[field.key] !== undefined) resolved[field.key] = coerceValue(field, pluginConfig[field.key])
        }
    }
    const userValues = readSettingsValues(root, name)
    for (const field of schema) {
        if (userValues[field.key] !== undefined) resolved[field.key] = coerceValue(field, userValues[field.key])
    }
    return resolved
}

/**
 * A file-backed key/value store scoped to one plugin. Loaded once into memory, every
 * mutation is persisted atomically, and the serialized store is size-capped so a
 * runaway plugin cannot fill the disk. JSON-serializable values only.
 */
function createStorage(root, name) {
    if (!isSafeName(name)) throw new Error('Invalid plugin name')
    const file = path.join(dataDir(root, name), 'storage.json')
    const map = readJson(file, {})

    const persist = () => {
        const serialized = JSON.stringify(map)
        if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_BYTES) {
            throw new Error(`plugin storage exceeds ${Math.round(MAX_STORAGE_BYTES / 1024)}KB`)
        }
        atomicWriteJson(file, map)
    }

    return {
        get(key) {
            return Object.prototype.hasOwnProperty.call(map, String(key)) ? map[String(key)] : undefined
        },
        set(key, value) {
            // Round-trip through JSON so only serializable data is ever stored.
            map[String(key)] = value === undefined ? null : JSON.parse(JSON.stringify(value))
            persist()
        },
        delete(key) {
            delete map[String(key)]
            persist()
        },
        keys() {
            return Object.keys(map)
        },
    }
}

/** Hostnames a manifest declares as elevated `net:<host>` permissions. */
function netHostsFromManifest(manifest) {
    const perms = (manifest && Array.isArray(manifest.permissions)) ? manifest.permissions : []
    return perms
        .filter(p => typeof p === 'string' && p.toLowerCase().startsWith('net:'))
        .map(p => p.slice(4).trim().toLowerCase())
        .filter(h => h.length > 0 && h.length < 254)
}

/** User consent decisions for elevated permissions — plugins/.data/<name>/grants.json. */
function readGrants(root, name) {
    if (!isSafeName(name)) return {}
    return readJson(path.join(dataDir(root, name), 'grants.json'), {})
}

/** Grant or revoke one elevated permission (e.g. "net:api.example.com"). */
function writeGrant(root, name, permission, granted) {
    if (!isSafeName(name)) throw new Error('Invalid plugin name')
    if (typeof permission !== 'string' || !permission) throw new Error('Invalid permission')
    const grants = readGrants(root, name)
    if (granted) grants[permission] = true
    else delete grants[permission]
    atomicWriteJson(path.join(dataDir(root, name), 'grants.json'), grants)
    return grants
}

/**
 * The net hosts a plugin may actually reach: declared in the manifest AND consented to
 * by the user. This intersection is what the fetch broker is scoped to.
 */
function grantedNetHosts(root, name, manifest) {
    const m = manifest || readManifest(root, name)
    const declared = netHostsFromManifest(m)
    const grants = readGrants(root, name)
    return declared.filter(host => grants[`net:${host}`] === true)
}

/** Read the last panel snapshot a plugin pushed (Desk render path), or null. */
function readPanel(root, name) {
    if (!isSafeName(name)) return null
    return readJson(path.join(dataDir(root, name), 'panel.json'), null)
}

/**
 * Validate + persist a plugin's panel snapshot (the plugin's ctx.ui.panel path). The
 * shape is a fixed vocabulary (title + labelled stats + text lines) — never HTML — so
 * a plugin can never inject markup into the Desk. Everything is stringified + capped.
 */
function writePanel(root, name, data) {
    if (!isSafeName(name)) throw new Error('Invalid plugin name')
    const input = data && typeof data === 'object' ? data : {}
    const panel = {
        title: input.title !== undefined ? String(input.title).slice(0, 120) : undefined,
        stats: Array.isArray(input.stats)
            ? input.stats
                  .slice(0, MAX_PANEL_STATS)
                  .filter(s => s && typeof s === 'object')
                  .map(s => ({
                      label: String(s.label == null ? '' : s.label).slice(0, 60),
                      value: String(s.value == null ? '' : s.value).slice(0, 60),
                      ...(s.hint !== undefined ? { hint: String(s.hint).slice(0, 120) } : {}),
                  }))
            : [],
        lines: Array.isArray(input.lines) ? input.lines.slice(0, MAX_PANEL_LINES).map(l => String(l == null ? '' : l).slice(0, 200)) : [],
        updatedAt: new Date().toISOString(),
    }
    const serialized = JSON.stringify(panel)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PANEL_BYTES) {
        throw new Error('plugin panel payload too large')
    }
    atomicWriteJson(path.join(dataDir(root, name), 'panel.json'), panel)
    return panel
}

/** Best-effort cleanup of a plugin's runtime data (called on removal). */
function clearData(root, name) {
    if (!isSafeName(name)) return
    try {
        fs.rmSync(dataDir(root, name), { recursive: true, force: true })
    } catch {
        // best-effort
    }
}

module.exports = {
    readManifest,
    readSettingsValues,
    writeSettingsValues,
    resolveSettings,
    createStorage,
    netHostsFromManifest,
    readGrants,
    writeGrant,
    grantedNetHosts,
    readPanel,
    writePanel,
    clearData,
    isSafeName,
    MAX_STORAGE_BYTES,
    MAX_PANEL_BYTES,
}
