'use strict'

// Rewards Desk — config read/patch helpers (extracted from app-window.js). Reads the
// runtime config (dist/config.json preferred, else src) and deep-merges patches into
// BOTH src and dist so they stay in sync. `atomicWriteText` is injected so the write
// behavior matches the rest of the Desk exactly. Behavior identical to the original.

const fs = require('fs')
const path = require('path')

function createConfig({ root, atomicWriteText }) {
    const CONFIG_SRC = path.join(root, 'src', 'config.json')
    const CONFIG_DIST = path.join(root, 'dist', 'config.json')

    function readConfigRaw() {
        // Prefer dist/config.json — that's what the bot actually reads at runtime
        const file = fs.existsSync(CONFIG_DIST) ? CONFIG_DIST : CONFIG_SRC
        try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
        catch { return {} }
    }

    function writeConfigPatch(patch) {
        const cfg = readConfigRaw()
        ;(function merge(t, s) {
            for (const [k, v] of Object.entries(s)) {
                if (v !== null && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') merge(t[k], v)
                else t[k] = v
            }
        })(cfg, patch)
        const json = JSON.stringify(cfg, null, 4)
        // Write to both so src and dist stay in sync
        atomicWriteText(CONFIG_SRC, json)
        if (fs.existsSync(CONFIG_DIST)) atomicWriteText(CONFIG_DIST, json)
    }

    return { CONFIG_SRC, CONFIG_DIST, readConfigRaw, writeConfigPatch }
}

module.exports = { createConfig }
