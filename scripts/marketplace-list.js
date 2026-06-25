'use strict'
// npm run marketplace:list — browse the signed marketplace catalog from the terminal.
// Reads the local disk cache (plugins/marketplace.json) written by the bot on start,
// or fetches live from MSRB_MARKETPLACE_CATALOG_URL if no cache exists yet.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CATALOG_PATH = path.join(ROOT, 'plugins', 'marketplace.json')

function col(s, w) {
    s = String(s == null ? '' : s)
    return s.length >= w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length)
}
function hr(n) { return '═'.repeat(n) }

async function main() {
    let catalog = null
    let source = 'none'

    try {
        catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
        source = 'disk cache'
    } catch {}

    if (!catalog) {
        const url = process.env.MSRB_MARKETPLACE_CATALOG_URL
        if (!url) {
            console.log('\nNo marketplace catalog on disk.')
            console.log('Set MSRB_MARKETPLACE_CATALOG_URL and start the bot once to sync the catalog,')
            console.log('or run:  npm run marketplace:sign  (local/offline testing only)\n')
            return
        }
        console.log('Fetching live catalog from:', url)
        const { fetchSignedCatalog } = require('./marketplace-fetch')
        const result = await fetchSignedCatalog(url)
        catalog = JSON.parse(result.catalog)
        source = 'live'
    }

    const plugins = (catalog && catalog.plugins) || []
    if (!plugins.length) {
        console.log('\nNo plugins in the marketplace yet.\n')
        return
    }

    let installed = {}
    try {
        const { createPluginsConfig } = require('./desk/plugins-config')
        const cfg = createPluginsConfig({ root: ROOT, atomicWriteText: () => {} })
        installed = cfg.readPluginsConfig()
    } catch {}

    const W = 74
    console.log('\n' + hr(W))
    console.log(' MSRB Marketplace — ' + plugins.length + ' plugin(s)  [' + source + ']')
    if (catalog.issuedAt) console.log(' Catalog: seq ' + (catalog.sequence || 1) + '  issued ' + catalog.issuedAt)
    console.log(hr(W))
    console.log(' ' + col('Name', 22) + col('Version', 10) + col('Author', 16) + col('Description', 26))
    console.log(hr(W))

    for (const p of plugins) {
        const tag = installed[p.name] ? '[INSTALLED] ' : '            '
        console.log(tag + col(p.name, 22) + col(p.version, 10) + col(p.authorUsername, 16) + col(p.description, 26))
    }

    console.log(hr(W))
    console.log()
    console.log('Install via the Desk:  npm start  →  Plugins  →  ✶ Marketplace  →  Install')
    console.log('Or add to plugins/plugins.jsonc manually:')
    console.log('  "<name>": { "enabled": true, "source": "marketplace", "version": "<version>" }')
    console.log()
}

main().catch(e => { console.error('Error:', e.message); process.exit(1) })
