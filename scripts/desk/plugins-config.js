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
        },
        'run-summary': {
            official: false,
            description: 'Writes per-account run summaries to diagnostics/run-summary after each run.'
        },
        'run-health': {
            official: false,
            description: 'Tracks recent failures, zero-point runs, and account duration without storing credentials.'
        },
        'session-health': {
            official: false,
            description: 'Checks the official sessions directory for missing, empty, or stale browser sessions.'
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

    return { PLUGINS_JSONC, PLUGIN_META, stripJsonc, readPluginsConfig, isPluginEnabled, readPluginsList, setPluginEnabled }
}

module.exports = { createPluginsConfig }
