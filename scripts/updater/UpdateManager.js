const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const { URL } = require('url')

const { migrateUserFiles } = require('./ConfigMigrator')

const DEFAULT_REPO = 'QuestPilot/Microsoft-Rewards-Bot'
const DEFAULT_CHANNEL = 'stable'
const DEFAULT_PUBLIC_KEY = [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAHEuafXvGqNUq89PhiAXIH9MGlYaap6eUAY1GNKYBn48=',
    '-----END PUBLIC KEY-----'
].join('\n')

const DEFAULT_EXCLUDES = [
    '.git',
    '.updates',
    'node_modules',
    'dist',
    'release',
    'logs',
    'diagnostics',
    'Page',
    'sessions',
    'src/config.json',
    'src/accounts.json',
    'plugins/plugins.jsonc',
    'plugins/*/node_modules',
    'plugins/*/.cache'
]

const DEFAULT_BACKUP_PATHS = [
    'logs',
    'diagnostics',
    'Page',
    'sessions',
    'src/config.json',
    'src/accounts.json',
    'plugins/plugins.jsonc'
]

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

function stripSignature(manifest) {
    const clone = { ...manifest }
    delete clone.signature
    return clone
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function pathToPosix(relativePath) {
    return relativePath.replace(/\\/g, '/')
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternToRegex(pattern) {
    const escaped = escapeRegex(pattern).replace(/\\\*/g, '[^/]*')
    return new RegExp(`^${escaped}(?:/.*)?$`)
}

function isExcluded(relativePath, patterns) {
    const posix = pathToPosix(relativePath)
    return patterns.some(pattern => patternToRegex(pathToPosix(pattern)).test(posix))
}

function mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true })
}

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true })
}

function copyRecursive(src, dest) {
    const srcStat = fs.statSync(src)

    if (srcStat.isDirectory()) {
        mkdirp(dest)
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry), options)
        }
        return
    }

    mkdirp(path.dirname(dest))
    fs.copyFileSync(src, dest)
}

function copyReleaseTree(sourceRoot, targetRoot, excludes) {
    for (const entry of fs.readdirSync(sourceRoot)) {
        const entryPath = path.join(sourceRoot, entry)
        copyReleaseEntry(entryPath, path.join(targetRoot, entry), entry, excludes)
    }
}

function copyReleaseEntry(sourcePath, targetPath, relativePath, excludes) {
    if (isExcluded(relativePath, excludes)) return

    const stat = fs.statSync(sourcePath)
    if (stat.isDirectory()) {
        mkdirp(targetPath)
        for (const entry of fs.readdirSync(sourcePath)) {
            copyReleaseEntry(
                path.join(sourcePath, entry),
                path.join(targetPath, entry),
                pathToPosix(path.join(relativePath, entry)),
                excludes
            )
        }
        return
    }

    mkdirp(path.dirname(targetPath))
    fs.copyFileSync(sourcePath, targetPath)
}

function findExtractedRoot(extractDir) {
    const entries = fs.readdirSync(extractDir).map(entry => path.join(extractDir, entry))
    const packageRoots = entries.filter(entry => fs.existsSync(path.join(entry, 'package.json')))
    if (packageRoots.length === 1) return packageRoots[0]
    if (fs.existsSync(path.join(extractDir, 'package.json'))) return extractDir
    throw new Error('Downloaded archive does not contain a package.json root')
}

function download(url, dest, timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
        mkdirp(path.dirname(dest))
        const file = fs.createWriteStream(dest)

        const request = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'msrb-updater' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                file.close()
                rmrf(dest)
                download(new URL(response.headers.location, url).toString(), dest, timeoutMs).then(resolve, reject)
                return
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                file.close()
                rmrf(dest)
                reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`))
                return
            }

            response.pipe(file)
            file.on('finish', () => {
                file.close(resolve)
            })
        })

        request.on('timeout', () => {
            request.destroy(new Error(`Download timed out after ${timeoutMs}ms`))
        })
        request.on('error', error => {
            file.close()
            rmrf(dest)
            reject(error)
        })
    })
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function removeEmptyParents(startDir, stopDir) {
    let current = startDir
    const stop = path.resolve(stopDir)

    while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
        if (!fs.existsSync(current)) return
        if (fs.readdirSync(current).length > 0) return
        fs.rmdirSync(current)
        current = path.dirname(current)
    }
}

class UpdateManager {
    constructor(options = {}) {
        this.root = options.root ?? path.resolve(__dirname, '..', '..')
        this.logger = options.logger ?? console
        this.channel = process.env.MSRB_UPDATE_CHANNEL || DEFAULT_CHANNEL
        this.manifestUrl =
            process.env.MSRB_UPDATE_MANIFEST_URL ||
            `https://raw.githubusercontent.com/${DEFAULT_REPO}/release/updates/${this.channel}.json`
        this.publicKey = process.env.MSRB_UPDATE_PUBLIC_KEY || DEFAULT_PUBLIC_KEY
        this.requireSignature = options.requireSignature ?? process.env.MSRB_UPDATE_REQUIRE_SIGNATURE === '1'
        this.updatesDir = path.join(this.root, '.updates')
        this.packageJson = readJson(path.join(this.root, 'package.json'))
    }

    shouldSkip(argv = process.argv, env = process.env) {
        if (env.MSRB_AUTO_UPDATE === '0') return { skip: true, reason: 'MSRB_AUTO_UPDATE=0' }
        if (argv.includes('-dev') || argv.includes('--dev')) return { skip: true, reason: 'dev mode' }
        if (env.npm_lifecycle_event === 'dev') return { skip: true, reason: 'npm run dev' }
        return { skip: false }
    }

    async run(options = {}) {
        const skip = this.shouldSkip(options.argv ?? process.argv, options.env ?? process.env)
        if (skip.skip) {
            this.logger.log(`[UPDATER] Skipped (${skip.reason})`)
            return { status: 'skipped', reason: skip.reason }
        }

        this.logger.log(`[UPDATER] Checking ${this.channel} updates from ${this.manifestUrl}`)

        try {
            const manifest = await this.fetchManifest()
            this.verifyManifest(manifest)
            this.logPlan(manifest)

            if (!this.isNewer(manifest.botVersion)) {
                this.logger.log(`[UPDATER] Already up to date (${this.packageJson.version})`)
                migrateUserFiles(this.root, this.logger)
                return { status: 'current', manifest }
            }

            if (options.dryRun || process.env.MSRB_UPDATE_DRY_RUN === '1') {
                this.logger.log(`[UPDATER] Dry run: would update ${this.packageJson.version} -> ${manifest.botVersion}`)
                return { status: 'dry-run', manifest }
            }

            await this.applyManifest(manifest)
            this.logger.log(`[UPDATER] Updated to ${manifest.botVersion}`)
            return { status: 'updated', manifest }
        } catch (error) {
            this.logger.warn(`[UPDATER] Update check failed: ${error.message}`)
            return { status: 'failed', error }
        }
    }

    async fetchManifest() {
        const manifestPath = path.join(this.updatesDir, `${this.channel}.json`)
        try {
            await download(this.manifestUrl, manifestPath, 20_000)
            return readJson(manifestPath)
        } catch (error) {
            const localManifestPath = path.join(this.root, 'updates', `${this.channel}.json`)
            if (!fs.existsSync(localManifestPath)) throw error
            this.logger.warn(`[UPDATER] Remote manifest unavailable, using local ${pathToPosix(path.relative(this.root, localManifestPath))}`)
            return readJson(localManifestPath)
        }
    }

    verifyManifest(manifest) {
        if (!manifest || typeof manifest !== 'object') throw new Error('Manifest is not an object')
        if (manifest.schemaVersion !== 1) throw new Error('Unsupported update manifest schema')
        if (manifest.channel !== this.channel) throw new Error(`Manifest channel mismatch: ${manifest.channel}`)
        if (typeof manifest.botVersion !== 'string') throw new Error('Manifest botVersion missing')

        if (manifest.signature) {
            const payload = Buffer.from(canonicalJson(stripSignature(manifest)))
            const signature = Buffer.from(manifest.signature, 'base64')
            const ok = crypto.verify(null, payload, this.publicKey, signature)
            if (!ok && this.requireSignature) throw new Error('Manifest signature is invalid')
            if (!ok) this.logger.warn('[UPDATER] Manifest signature is invalid; continuing because signature enforcement is disabled')
        } else if (this.requireSignature) {
            throw new Error('Manifest signature missing')
        }

        if (manifest.compatibleNode && !this.nodeSatisfies(manifest.compatibleNode)) {
            throw new Error(`Node ${process.version} does not satisfy ${manifest.compatibleNode}`)
        }
    }

    nodeSatisfies(range) {
        const semver = require('semver')
        return semver.satisfies(process.version, range)
    }

    isNewer(remoteVersion) {
        const semver = require('semver')
        return semver.gt(remoteVersion, this.packageJson.version)
    }

    logPlan(manifest) {
        const excludes = manifest.excludes ?? DEFAULT_EXCLUDES
        this.logger.log(`[UPDATER] Local=${this.packageJson.version} Remote=${manifest.botVersion}`)
        this.logger.log(`[UPDATER] Preserved paths: ${excludes.join(', ')}`)
    }

    async applyManifest(manifest) {
        if (!manifest.archiveUrl || !manifest.sha256) {
            throw new Error('Manifest update requires archiveUrl and sha256')
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const workDir = path.join(this.updatesDir, stamp)
        const archivePath = path.join(workDir, path.basename(new URL(manifest.archiveUrl).pathname) || 'release.tar.gz')
        const extractDir = path.join(workDir, 'extract')
        const backupDir = path.join(workDir, 'backup')
        const excludes = manifest.excludes ?? DEFAULT_EXCLUDES

        mkdirp(workDir)
        mkdirp(extractDir)
        mkdirp(backupDir)

        await download(manifest.archiveUrl, archivePath)

        const actualSha = sha256File(archivePath)
        if (actualSha.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
            throw new Error(`Archive checksum mismatch: ${actualSha}`)
        }

        this.extractArchive(archivePath, extractDir)
        const sourceRoot = findExtractedRoot(extractDir)

        try {
            this.backupMutablePaths(backupDir, excludes)
            copyReleaseTree(sourceRoot, this.root, excludes)
            migrateUserFiles(this.root, this.logger)
        } catch (error) {
            this.logger.warn(`[UPDATER] Apply failed, rolling back: ${error.message}`)
            this.restoreBackup(backupDir, excludes)
            throw error
        }
    }

    extractArchive(archivePath, extractDir) {
        const lower = archivePath.toLowerCase()
        const args = lower.endsWith('.zip') ? ['-xf', archivePath, '-C', extractDir] : ['-xzf', archivePath, '-C', extractDir]
        const result = childProcess.spawnSync('tar', args, { stdio: 'pipe', encoding: 'utf8' })
        if (result.status !== 0) {
            throw new Error(`Archive extraction failed: ${result.stderr || result.stdout || 'tar failed'}`)
        }
    }

    backupMutablePaths(backupDir, excludes) {
        const backupPaths = this.getBackupPaths(excludes)
        for (const pattern of backupPaths) {
            if (pattern.includes('*')) continue
            const source = path.join(this.root, pattern)
            if (!fs.existsSync(source)) continue
            const target = path.join(backupDir, pattern)
            copyRecursive(source, target)
        }
    }

    restoreBackup(backupDir, excludes = DEFAULT_EXCLUDES) {
        if (!fs.existsSync(backupDir)) return
        const backupPaths = this.getBackupPaths(excludes)
        for (const pattern of backupPaths) {
            if (pattern.includes('*')) continue
            const backupSource = path.join(backupDir, pattern)
            const target = path.join(this.root, pattern)

            if (fs.existsSync(target)) {
                rmrf(target)
            }

            if (fs.existsSync(backupSource)) {
                copyRecursive(backupSource, target)
            } else {
                removeEmptyParents(path.dirname(target), this.root)
            }
        }
    }

    getBackupPaths(excludes = DEFAULT_EXCLUDES) {
        return DEFAULT_BACKUP_PATHS.filter(pattern => excludes.includes(pattern))
    }
}

module.exports = {
    DEFAULT_EXCLUDES,
    DEFAULT_BACKUP_PATHS,
    DEFAULT_PUBLIC_KEY,
    UpdateManager,
    canonicalJson,
    stripSignature
}
