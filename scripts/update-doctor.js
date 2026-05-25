const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { UpdateManager } = require('./updater/UpdateManager')

const ROOT = path.resolve(__dirname, '..')

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function sha256(relativePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relativePath))).digest('hex')
}

async function main() {
    const packageJson = readJson('package.json')
    const officialCore = readJson('plugins/official-core.json')
    const catalog = readJson('plugins/catalog.json')
    const coreHash = sha256('plugins/core/index.jsc')
    const catalogCore = catalog.plugins.find(plugin => plugin.name === 'core')
    const updater = new UpdateManager({ root: ROOT })

    console.log(`[UPDATE-DOCTOR] package.json version: ${packageJson.version}`)
    console.log(`[UPDATE-DOCTOR] source: ${updater.repo}#${updater.branch}`)
    console.log(`[UPDATE-DOCTOR] official Core hash: ${officialCore.indexSha256}`)
    console.log(`[UPDATE-DOCTOR] actual Core hash: ${coreHash}`)

    if (officialCore.indexSha256 !== coreHash) {
        throw new Error('plugins/official-core.json does not match plugins/core/index.jsc')
    }
    if (catalogCore?.sha256 !== coreHash) {
        throw new Error('plugins/catalog.json does not match plugins/core/index.jsc')
    }

    try {
        const remote = await updater.fetchRemoteRelease()
        console.log(`[UPDATE-DOCTOR] remote release branch SHA: ${remote.commitSha}`)
        console.log(`[UPDATE-DOCTOR] remote package version: ${remote.version}`)
        if (remote.version !== packageJson.version) {
            console.warn('[UPDATE-DOCTOR] Local package.json does not match the release branch version.')
        }
    } catch (error) {
        console.warn(`[UPDATE-DOCTOR] Could not read GitHub release branch: ${error.message}`)
    }

    console.log('[UPDATE-DOCTOR] GitHub updater metadata check complete.')
}

main().catch(error => {
    console.error(`[UPDATE-DOCTOR] ${error.message}`)
    process.exit(1)
})
