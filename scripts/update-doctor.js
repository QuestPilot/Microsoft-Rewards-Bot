const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { URL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/release/updates/stable.json'

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function sha256(relativePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relativePath))).digest('hex')
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url)
        parsed.searchParams.set('_msrb', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
        https
            .get(parsed, {
                headers: {
                    'user-agent': 'msrb-update-doctor',
                    'cache-control': 'no-cache',
                    pragma: 'no-cache'
                }
            }, response => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    fetchJson(new URL(response.headers.location, parsed).toString()).then(resolve, reject)
                    return
                }
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode}`))
                    return
                }
                const chunks = []
                response.on('data', chunk => chunks.push(chunk))
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                    } catch (error) {
                        reject(error)
                    }
                })
            })
            .on('error', reject)
    })
}

async function main() {
    const packageJson = readJson('package.json')
    const localManifest = readJson('updates/stable.json')
    const officialCore = readJson('plugins/official-core.json')
    const catalog = readJson('plugins/catalog.json')
    const coreHash = sha256('plugins/core/index.jsc')
    const catalogCore = catalog.plugins.find(plugin => plugin.name === 'core')

    console.log(`[UPDATE-DOCTOR] package.json version: ${packageJson.version}`)
    console.log(`[UPDATE-DOCTOR] local stable manifest: ${localManifest.botVersion}`)
    console.log(`[UPDATE-DOCTOR] official Core hash: ${officialCore.indexSha256}`)
    console.log(`[UPDATE-DOCTOR] actual Core hash: ${coreHash}`)

    if (officialCore.indexSha256 !== coreHash) {
        throw new Error('plugins/official-core.json does not match plugins/core/index.jsc')
    }
    if (catalogCore?.sha256 !== coreHash) {
        throw new Error('plugins/catalog.json does not match plugins/core/index.jsc')
    }
    if (localManifest.botVersion !== packageJson.version) {
        console.warn('[UPDATE-DOCTOR] Local updates/stable.json does not match package.json yet.')
        console.warn('[UPDATE-DOCTOR] This is expected before running npm run update:prepare after commit A.')
    }

    const remoteUrl = process.env.MSRB_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL
    try {
        const remoteManifest = await fetchJson(remoteUrl)
        console.log(`[UPDATE-DOCTOR] remote stable manifest: ${remoteManifest.botVersion}`)
        if (remoteManifest.botVersion !== packageJson.version) {
            console.warn('[UPDATE-DOCTOR] Remote manifest still points to another version.')
            console.warn('[UPDATE-DOCTOR] Users will not see this release until updates/stable.json is prepared, committed, and pushed.')
        }
    } catch (error) {
        console.warn(`[UPDATE-DOCTOR] Could not read remote manifest: ${error.message}`)
    }

    console.log('[UPDATE-DOCTOR] Local updater metadata check complete.')
}

main().catch(error => {
    console.error(`[UPDATE-DOCTOR] ${error.message}`)
    process.exit(1)
})
