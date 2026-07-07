const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { UpdateManager } = require('./UpdateManager')
const { compareReleaseVersions } = require('./ReleaseVersion')
const { readPublicKey, verifySignedBytes } = require('../security/SignedManifest')

const ROOT = path.resolve(__dirname, '..', '..')

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function readOptionalJson(relativePath) {
    const filePath = path.join(ROOT, relativePath)
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function stripJsonComments(source) {
    let output = ''
    let inString = false
    let quote = ''
    let escaping = false
    for (let index = 0; index < source.length; index += 1) {
        const current = source[index]
        const next = source[index + 1]

        if (inString) {
            output += current
            if (escaping) {
                escaping = false
            } else if (current === '\\') {
                escaping = true
            } else if (current === quote) {
                inString = false
            }
            continue
        }

        if (current === '"' || current === "'") {
            inString = true
            quote = current
            output += current
            continue
        }

        if (current === '/' && next === '/') {
            while (index < source.length && source[index] !== '\n') index += 1
            output += '\n'
            continue
        }

        if (current === '/' && next === '*') {
            index += 2
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
            index += 1
            continue
        }

        output += current
    }

    return output.replace(/,(\s*[}\]])/g, '$1')
}

function readPluginConfig() {
    const configPath = path.join(ROOT, 'plugins', 'plugins.jsonc')
    if (!fs.existsSync(configPath)) return { exists: false, coreEnabled: null }
    try {
        const parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')))
        return {
            exists: true,
            coreEnabled: parsed.core?.enabled !== false,
            corePriority: parsed.core?.priority ?? null
        }
    } catch (error) {
        return { exists: true, coreEnabled: null, error: error.message }
    }
}

function sha256(relativePath) {
    return crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, relativePath)))
        .digest('hex')
}

function currentCoreTargetId() {
    return `${process.platform}-${process.arch}-node-${process.versions.node}`
}

function formatBool(value) {
    if (value === true) return 'yes'
    if (value === false) return 'no'
    return 'unknown'
}

function actionForUpdateResult(result) {
    if (!result) return 'Update check did not run.'
    if (result.status === 'current') return 'No action required.'
    if (result.status === 'updated') return 'The launcher restarts automatically after dependency sync.'
    if (result.status === 'update-available' && result.docker)
        return 'Docker users must pull or rebuild the image, then restart the container.'
    if (result.status === 'update-available') return 'Run npm start without -dev so the updater can apply the release.'
    if (result.status === 'failed') return 'Check network access to GitHub, then retry npm run update:doctor.'
    if (result.status === 'skipped') return `Update skipped: ${result.reason}.`
    return 'Review updater output above.'
}

// Compare the installed tree against the last applied-release manifest, so
// "the version says X" can be proven (or disproven) as "the files of X are
// actually on disk, intact".
function reportManifestCheck(check) {
    if (check.status === 'ok') {
        console.log(
            `[UPDATE-DOCTOR] installed files integrity: ok (${check.fileCount} files match the last applied release)`
        )
        return
    }
    if (check.status === 'drift') {
        const sample = [
            ...check.missing.map(file => `missing ${file}`),
            ...check.drifted.map(file => `modified ${file}`)
        ]
            .slice(0, 5)
            .join(', ')
        console.error(
            `[UPDATE-DOCTOR] installed files integrity: DRIFT — ${check.missing.length} missing, ${check.drifted.length} modified (${sample})`
        )
        console.log('[UPDATE-DOCTOR] action: run npm run update:repair to re-apply the current release.')
        process.exitCode = 1
        return
    }
    if (check.status === 'stale') {
        console.log(
            `[UPDATE-DOCTOR] installed files integrity: manifest is for ${check.manifestVersion} but local version is ${check.localVersion}; it refreshes on the next update or repair.`
        )
        return
    }
    if (check.status === 'unsupported') {
        console.log(
            `[UPDATE-DOCTOR] installed files integrity: not applicable (${check.strategy} install — use git status to inspect drift).`
        )
        return
    }
    console.log(
        '[UPDATE-DOCTOR] installed files integrity: no applied-release manifest yet (recorded by the next update or repair).'
    )
}

function verifyCoreArtifact(officialCore) {
    verifySignedBytes(
        fs.readFileSync(path.join(ROOT, 'plugins', 'official-core.json')),
        fs.readFileSync(path.join(ROOT, 'plugins', 'official-core.sig'), 'utf8'),
        readPublicKey(path.join(ROOT, 'scripts', 'security', 'core-public-key.pem'))
    )
    if (officialCore.targets) {
        for (const [targetId, target] of Object.entries(officialCore.targets)) {
            const relativePath = `plugins/core/targets/${targetId}/index.jsc`
            const coreHash = sha256(relativePath)
            console.log(`[UPDATE-DOCTOR] official Core ${targetId}: ${target.indexSha256}`)
            console.log(`[UPDATE-DOCTOR] actual Core ${targetId}: ${coreHash}`)
            if (target.indexSha256 !== coreHash) {
                throw new Error(`plugins/official-core.json does not match ${relativePath}`)
            }
        }
        return
    }

    const coreHash = sha256('plugins/core/index.jsc')
    console.log(`[UPDATE-DOCTOR] official Core hash: ${officialCore.indexSha256}`)
    console.log(`[UPDATE-DOCTOR] actual Core hash: ${coreHash}`)

    if (officialCore.indexSha256 !== coreHash) {
        throw new Error('plugins/official-core.json does not match plugins/core/index.jsc')
    }
}

async function main() {
    const packageJson = readJson('package.json')
    const officialCore = readJson('plugins/official-core.json')
    const corePackage = readOptionalJson('plugins/core/package.json')
    const pluginConfig = readPluginConfig()
    const updater = new UpdateManager({ root: ROOT })
    const targetId = currentCoreTargetId()
    const isDocker = updater.isDocker()

    console.log(`[UPDATE-DOCTOR] bot version: ${packageJson.version}`)
    console.log(
        `[UPDATE-DOCTOR] node runtime: ${process.version} (required ${packageJson.engines?.node || 'unspecified'})`
    )
    console.log(`[UPDATE-DOCTOR] docker runtime: ${formatBool(isDocker)}`)
    console.log(`[UPDATE-DOCTOR] update source: ${updater.repo}#${updater.branch}`)
    console.log(`[UPDATE-DOCTOR] plugin config: ${pluginConfig.exists ? 'plugins/plugins.jsonc' : 'missing'}`)
    console.log(`[UPDATE-DOCTOR] core plugin enabled: ${formatBool(pluginConfig.coreEnabled)}`)
    if (pluginConfig.error) {
        console.warn(`[UPDATE-DOCTOR] plugins.jsonc parse error: ${pluginConfig.error}`)
    }
    console.log(`[UPDATE-DOCTOR] installed Core version: ${corePackage?.version || officialCore.version || 'unknown'}`)
    console.log(`[UPDATE-DOCTOR] current Core bytecode target: ${targetId}`)
    console.log(
        `[UPDATE-DOCTOR] target installed: ${formatBool(Boolean(corePackage?.msrb?.targets?.[targetId] || officialCore.targets?.[targetId]))}`
    )

    try {
        verifyCoreArtifact(officialCore)
    } catch (error) {
        console.error(`[UPDATE-DOCTOR] Core artifact check failed: ${error.message}`)
        process.exitCode = 1
    }

    reportManifestCheck(updater.verifyAppliedManifest())

    try {
        const remote = await updater.fetchRemoteRelease()
        const updateResult =
            compareReleaseVersions(remote.version, packageJson.version) > 0
                ? { status: 'update-available', remote, docker: isDocker }
                : { status: 'current', remote }
        if (remote) {
            console.log(`[UPDATE-DOCTOR] remote main commit SHA: ${remote.commitSha}`)
            console.log(`[UPDATE-DOCTOR] remote package version: ${remote.version}`)
        }
        console.log(`[UPDATE-DOCTOR] update status: ${updateResult.status}`)
        console.log(`[UPDATE-DOCTOR] action: ${actionForUpdateResult(updateResult)}`)
    } catch (error) {
        console.warn(`[UPDATE-DOCTOR] update check failed: ${error.message}`)
        console.log('[UPDATE-DOCTOR] action: Check network access to GitHub, then retry npm run update:doctor.')
    }

    if (pluginConfig.coreEnabled === false) {
        console.log(
            '[UPDATE-DOCTOR] action: Core is disabled in plugins/plugins.jsonc; enable it before testing license/dashboard issues.'
        )
    } else if (!corePackage) {
        console.log(
            '[UPDATE-DOCTOR] action: plugins/core/package.json is missing; run npm start to update or reinstall from the official repository.'
        )
    } else if (!(corePackage.msrb?.targets?.[targetId] || officialCore.targets?.[targetId])) {
        console.log(
            '[UPDATE-DOCTOR] action: Current platform has no Core bytecode target. Use the official Node/platform target or pull/rebuild the official Docker image.'
        )
    }

    console.log('[UPDATE-DOCTOR] support diagnostics complete.')
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[UPDATE-DOCTOR] ${error.message}`)
        process.exit(1)
    })
}

module.exports = {
    actionForUpdateResult,
    currentCoreTargetId,
    readPluginConfig,
    reportManifestCheck,
    stripJsonComments,
    verifyCoreArtifact
}
