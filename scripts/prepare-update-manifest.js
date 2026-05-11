const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { URL } = require('url')

const manifestPath = process.argv[2] || path.join('updates', 'stable.json')
const root = path.resolve(__dirname, '..')
const absoluteManifestPath = path.resolve(root, manifestPath)

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function git(args) {
    const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim())
    }
    return result.stdout.trim()
}

function download(url) {
    return new Promise((resolve, reject) => {
        const chunks = []
        const request = https.get(url, { headers: { 'user-agent': 'msrb-manifest-prep' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                download(new URL(response.headers.location, url).toString()).then(resolve, reject)
                return
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`))
                return
            }
            response.on('data', chunk => chunks.push(chunk))
            response.on('end', () => resolve(Buffer.concat(chunks)))
        })
        request.on('error', reject)
    })
}

async function main() {
    const status = git(['status', '--porcelain'])
    if (status) {
        throw new Error('Working tree must be clean before preparing an immutable update archive.')
    }

    const packageJson = readJson(path.join(root, 'package.json'))
    const coreManifest = readJson(path.join(root, 'plugins', 'official-core.json'))
    const manifest = readJson(absoluteManifestPath)
    const commit = git(['rev-parse', 'HEAD'])
    const archiveUrl = `https://github.com/QuestPilot/Microsoft-Rewards-Bot/archive/${commit}.tar.gz`
    const archive = await download(archiveUrl)

    manifest.botVersion = packageJson.version
    manifest.coreVersion = coreManifest.version || manifest.coreVersion
    manifest.compatibleNode = packageJson.engines?.node || manifest.compatibleNode
    manifest.archiveUrl = archiveUrl
    manifest.sha256 = crypto.createHash('sha256').update(archive).digest('hex')
    delete manifest.signature

    fs.writeFileSync(absoluteManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`Prepared ${manifestPath}`)
    console.log(`Archive: ${archiveUrl}`)
    console.log(`SHA-256: ${manifest.sha256}`)
    console.log('Next: review, test, commit, and push the manifest.')
    console.log('Optional private signed channels can still run npm run update:key:check and npm run update:sign.')
}

main().catch(error => {
    console.error(error.message)
    process.exit(1)
})
