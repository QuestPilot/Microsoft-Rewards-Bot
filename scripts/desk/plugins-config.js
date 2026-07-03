'use strict'

// Rewards Desk — plugins.jsonc read/write helpers (extracted from app-window.js).
// Reads the JSONC plugin registry and toggles a plugin's `enabled` flag with
// comment-preserving string surgery (so the file's comments/example survive).
// `atomicWriteText` is injected so writes match the rest of the Desk exactly.
// Behavior is identical to the original inline implementation.

const fs = require('fs')
const path = require('path')

function createPluginsConfig({ root, atomicWriteText }) {
    const PLUGINS_JSONC = path.join(root, 'plugins', 'plugins.jsonc')

    const PLUGIN_META = {
        'core': {
            official: true,
            description: 'Official premium plugin: auto-claim points, coupons, double-search, app rewards, read-to-earn, streak protection, punchcards & the remote dashboard. Requires a valid Core license.'
        }
    }

    function stripJsonc(raw) {
        // Remove block comments, then line comments (avoiding :// in URLs), then trailing commas
        let s = raw.replace(/\/\*[\s\S]*?\*\//g, '')
        s = s.replace(/(^|[^:"'])\/\/.*$/gm, '$1')
        s = s.replace(/,(\s*[}\]])/g, '$1')
        return s
    }

    function readPluginsConfig() {
        try {
            return JSON.parse(stripJsonc(fs.readFileSync(PLUGINS_JSONC, 'utf8')))
        } catch {
            return {}
        }
    }

    function isPluginEnabled(name) {
        const plugin = readPluginsConfig()[name]
        return Boolean(plugin && typeof plugin === 'object' && plugin.enabled !== false)
    }

    function readPluginsList() {
        const cfg = readPluginsConfig()
        return Object.entries(cfg)
            .filter(([, v]) => v && typeof v === 'object')
            .map(([name, v]) => ({
                name,
                enabled: v.enabled !== false,
                priority: typeof v.priority === 'number' ? v.priority : 0,
                source: v.source === 'marketplace' ? 'marketplace' : 'local',
                version: typeof v.version === 'string' ? v.version : '',
                autoUpdate: v.autoUpdate !== false,
                trust: v.trust === 'full' ? 'full' : '',
                official: (PLUGIN_META[name] && PLUGIN_META[name].official) || false,
                description: (PLUGIN_META[name] && PLUGIN_META[name].description) || 'Custom plugin.'
            }))
            .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    }

    function setPluginEnabled(name, enabled) {
        let src = fs.readFileSync(PLUGINS_JSONC, 'utf8')
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keyIdx = src.search(new RegExp('"' + escaped + '"\\s*:'))
        if (keyIdx < 0) throw new Error('Plugin not found: ' + name)
        const enabledIdx = src.indexOf('"enabled"', keyIdx)
        if (enabledIdx < 0) throw new Error('No enabled flag for: ' + name)
        const tail = src.slice(enabledIdx).replace(/("enabled"\s*:\s*)(true|false)/, '$1' + (enabled ? 'true' : 'false'))
        src = src.slice(0, enabledIdx) + tail
        atomicWriteText(PLUGINS_JSONC, src)
        return true
    }

    // Set a plugin's isolation/trust level ('full' = Trusted Mode / in-process,
    // 'sandbox' = isolated). Comment-preserving: replaces an existing "trust" value
    // or inserts the field, scoped to this plugin's own { } object via brace matching.
    function setPluginTrust(name, trust) {
        if (trust !== 'full' && trust !== 'sandbox') throw new Error('Invalid trust level: ' + trust)
        let src = fs.readFileSync(PLUGINS_JSONC, 'utf8')
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keyIdx = src.search(new RegExp('"' + escaped + '"\\s*:\\s*\\{'))
        if (keyIdx < 0) throw new Error('Plugin not found: ' + name)
        const braceIdx = src.indexOf('{', keyIdx)
        let depth = 0
        let endIdx = -1
        for (let i = braceIdx; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
        }
        if (endIdx < 0) throw new Error('Malformed plugin entry: ' + name)
        const objText = src.slice(braceIdx, endIdx + 1)
        const newObjText = /"trust"\s*:\s*"(full|sandbox)"/.test(objText)
            ? objText.replace(/("trust"\s*:\s*")(full|sandbox)(")/, '$1' + trust + '$3')
            : objText.replace(/^\{/, '{\n        "trust": "' + trust + '",')
        src = src.slice(0, braceIdx) + newObjText + src.slice(endIdx + 1)
        atomicWriteText(PLUGINS_JSONC, src)
        return true
    }

    // Add a marketplace plugin entry to plugins.jsonc (does not download — the bot
    // fetches & verifies on next start via the auto-install pipeline).
    function addMarketplacePlugin(name, version) {
        if (!/^[a-z0-9][a-z0-9._-]{1,48}$/.test(name)) throw new Error('Invalid plugin name: ' + name)
        if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Invalid version: ' + version)
        const cfg = readPluginsConfig()
        if (cfg[name]) throw new Error('Already in plugins.jsonc: ' + name)
        let src
        try { src = fs.readFileSync(PLUGINS_JSONC, 'utf8') } catch { src = '{\n}' }
        const trimmed = src.trimEnd()
        const closingBrace = trimmed.lastIndexOf('}')
        if (closingBrace < 0) throw new Error('Malformed plugins.jsonc')
        const hasEntries = Object.keys(cfg).length > 0
        const entry = '  "' + name + '": {\n    "enabled": true,\n    "source": "marketplace",\n    "version": "' + version + '"\n  }'
        const newSrc = trimmed.slice(0, closingBrace) + (hasEntries ? ',\n' : '\n') + entry + '\n}'
        atomicWriteText(PLUGINS_JSONC, newSrc)
        return true
    }

    // Remove a plugin's entry from plugins.jsonc (comment-safe). Brace-matches the
    // plugin's own { } object and drops it plus one adjacent comma. Any comment lines
    // above the entry are left in place (harmless). The bot's loader / readPluginsConfig
    // tolerates trailing commas, so even an imperfect trim still parses.
    function removePlugin(name) {
        let src = fs.readFileSync(PLUGINS_JSONC, 'utf8')
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keyIdx = src.search(new RegExp('"' + escaped + '"\\s*:\\s*\\{'))
        if (keyIdx < 0) throw new Error('Plugin not found: ' + name)
        const braceIdx = src.indexOf('{', keyIdx)
        let depth = 0
        let endIdx = -1
        for (let i = braceIdx; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
        }
        if (endIdx < 0) throw new Error('Malformed plugin entry: ' + name)
        let start = keyIdx
        let end = endIdx + 1
        // Drop a trailing comma if present, else a preceding one (last-entry case).
        let after = end
        while (after < src.length && /\s/.test(src[after])) after++
        if (src[after] === ',') {
            end = after + 1
        } else {
            let before = start - 1
            while (before >= 0 && /\s/.test(src[before])) before--
            if (src[before] === ',') start = before
        }
        atomicWriteText(PLUGINS_JSONC, src.slice(0, start) + src.slice(end))
        return true
    }

    // Pin a plugin to a specific version (used by the Desk "Update" action). Comment-
    // preserving, scoped to the plugin's own { } object — mirrors setPluginTrust.
    function setPluginVersion(name, version) {
        if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Invalid version: ' + version)
        let src = fs.readFileSync(PLUGINS_JSONC, 'utf8')
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keyIdx = src.search(new RegExp('"' + escaped + '"\\s*:\\s*\\{'))
        if (keyIdx < 0) throw new Error('Plugin not found: ' + name)
        const braceIdx = src.indexOf('{', keyIdx)
        let depth = 0
        let endIdx = -1
        for (let i = braceIdx; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
        }
        if (endIdx < 0) throw new Error('Malformed plugin entry: ' + name)
        const objText = src.slice(braceIdx, endIdx + 1)
        const newObjText = /"version"\s*:\s*"[^"]*"/.test(objText)
            ? objText.replace(/("version"\s*:\s*")[^"]*(")/, '$1' + version + '$2')
            : objText.replace(/^\{/, '{\n        "version": "' + version + '",')
        src = src.slice(0, braceIdx) + newObjText + src.slice(endIdx + 1)
        atomicWriteText(PLUGINS_JSONC, src)
        return true
    }

    // Toggle a plugin's auto-update flag (marketplace plugins). Comment-preserving,
    // scoped to the plugin's own { } object — mirrors setPluginTrust.
    function setPluginAutoUpdate(name, autoUpdate) {
        let src = fs.readFileSync(PLUGINS_JSONC, 'utf8')
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const keyIdx = src.search(new RegExp('"' + escaped + '"\\s*:\\s*\\{'))
        if (keyIdx < 0) throw new Error('Plugin not found: ' + name)
        const braceIdx = src.indexOf('{', keyIdx)
        let depth = 0
        let endIdx = -1
        for (let i = braceIdx; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
        }
        if (endIdx < 0) throw new Error('Malformed plugin entry: ' + name)
        const objText = src.slice(braceIdx, endIdx + 1)
        const newObjText = /"autoUpdate"\s*:\s*(true|false)/.test(objText)
            ? objText.replace(/("autoUpdate"\s*:\s*)(true|false)/, '$1' + (autoUpdate ? 'true' : 'false'))
            : objText.replace(/^\{/, '{\n        "autoUpdate": ' + (autoUpdate ? 'true' : 'false') + ',')
        src = src.slice(0, braceIdx) + newObjText + src.slice(endIdx + 1)
        atomicWriteText(PLUGINS_JSONC, src)
        return true
    }

    return { PLUGINS_JSONC, PLUGIN_META, stripJsonc, readPluginsConfig, isPluginEnabled, readPluginsList, setPluginEnabled, setPluginTrust, addMarketplacePlugin, removePlugin, setPluginVersion, setPluginAutoUpdate }
}

module.exports = { createPluginsConfig }
