const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { URL } = require('url')

const { migrateUserFiles } = require('./ConfigMigrator')
const { compareReleaseVersions, isReleaseVersion } = require('./ReleaseVersion')
const DEFAULT_REPO = 'QuestPilot/Microsoft-Rewards-Bot'
const DEFAULT_BRANCH = 'main'
const ALLOWED_UPDATE_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'codeload.github.com'
])

const DEFAULT_EXCLUDES = [
    '.git',
    '.updates',
    '.github',
    '.dockerignore',
    '.eslintrc.js',
    '.gitattributes',
    '.gitignore',
    '.node-version',
    '.nvmrc',
    '.prettierrc',
    'node_modules',
    'dist',
    'release',
    'data',
    'logs',
    'diagnostics',
    'Page',
    'sessions',
    // Generated at runtime (gitignored, never shipped in a release) — the OS
    // shortcuts and auto-start entries point straight at scripts/runtime/*.cmd,
    // so pruning them because they're absent from the release tree silently
    // breaks every launcher until start.js/the notifier re-creates them. Keep
    // them across updates; start.js re-ensures their content on each launch.
    'scripts/runtime',
    'src/config.json',
    'src/accounts.json',
    'src/accounts.enc.json',
    'plugins/plugins.jsonc',
    'plugins/*/node_modules',
    'plugins/*/.cache',
    // Per-plugin runtime state written by the capability layer (settings a user set in
    // the Desk, scoped storage, the last panel snapshot). Not shipped in a release, so
    // preserve it across updates — losing it would silently reset every plugin's config.
    'plugins/.data'
]

// Only the small, critical user files are backed up before an apply and
// restored on rollback. The heavy runtime dirs (sessions/, logs/, Page/,
// diagnostics/) are excluded from syncing entirely — neither strategy ever
// writes or prunes them — so copying hundreds of MB (including possibly
// locked live session files) into .updates/ on every update only made
// updates slow and failure-prone without protecting anything.
const DEFAULT_BACKUP_PATHS = ['src/config.json', 'src/accounts.json', 'src/accounts.enc.json', 'plugins/plugins.jsonc']

const DEFAULT_MANAGED_PATHS = [
    'assets',
    'docker',
    'docs',
    'plugins/core',
    'plugins/official-core.json',
    'plugins/official-core.sig',
    'scripts',
    'src',
    'tests',
    'updates',
    'LICENSE',
    'README.md',
    'compose.yaml',
    'flake.lock',
    'flake.nix',
    'package-lock.json',
    'package.json',
    'tsconfig.json'
    // COMMERCIAL.md, NOTICE, and TRADEMARK.md moved under docs/legal/ — already
    // covered by the 'docs' entry above. CODE_OF_CONDUCT.md/CONTRIBUTING.md/
    // SECURITY.md moved under .github/, which is deliberately excluded from
    // archive-based syncing (see DEFAULT_EXCLUDES) since it has no effect on a
    // locally-run install; git-based updates still sync it normally via checkout.
]

const DEFAULT_OBSOLETE_PATHS = [
    'src/core/DashboardServer.ts',
    'plugins/catalog.json',
    // 2026-07-05 root cleanup: these moved into .github/ or docs/legal/, and
    // Dockerfile into docker/ — delete the stale root copies on existing installs.
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'COMMERCIAL.md',
    'NOTICE',
    'TRADEMARK.md',
    'Dockerfile',
    // Stray tracked dev scratch file — was never meant to ship.
    'scratch.js',
    // Safety advisory is now served by Core-API + Redis (lib/safety-advisory.ts),
    // toggled from the admin dashboard, instead of this static file. No legacy
    // fallback kept: the bot's fetch already fails open (warns, continues) on a
    // 404, so a not-yet-updated bot simply skips the check until it updates.
    'safety-advisory.json'
]

const UPDATE_STRATEGIES = new Set(['auto', 'git', 'archive'])
const UPDATE_LOCK_FILE = 'update.lock'
const APPLIED_MANIFEST_FILE = 'applied.json'
// Keep the last two .updates/<stamp>/ workdirs (current + previous) for
// post-mortem; everything older is deleted after a successful apply.
const KEEP_UPDATE_WORKDIRS = 2
const DEFAULT_UPDATE_LOCK_WAIT_MS = 2 * 60 * 1000
const DEFAULT_UPDATE_LOCK_STALE_MS = 30 * 60 * 1000
const UPDATE_LOCK_POLL_MS = 500

function pathToPosix(relativePath) {
    return relativePath.replace(/\\/g, '/')
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternToRegex(pattern) {
    const escaped = escapeRegex(pathToPosix(pattern)).replace(/\\\*/g, '[^/]*')
    return new RegExp(`^${escaped}(?:/.*)?$`)
}

function isExcluded(relativePath, patterns = DEFAULT_EXCLUDES) {
    const posix = pathToPosix(relativePath)
    return patterns.some(pattern => patternToRegex(pattern).test(posix))
}

function mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true })
}

// Best-effort, purely cosmetic: hide .updates/ (Windows/macOS) so it doesn't clutter
// Explorer/Finder. Same helper as src/helpers/HiddenDir.ts — kept as a separate,
// duplicated implementation here since this file runs as plain CommonJS outside the
// compiled bot bundle. No-op on Linux (no attribute-based hidden mechanism without
// renaming, which is out of scope — see HiddenDir.ts for why). Never throws.
function markDirHidden(dir) {
    try {
        if (process.platform === 'win32') {
            childProcess.spawn('attrib', ['+h', dir], { stdio: 'ignore', windowsHide: true }).unref()
        } else if (process.platform === 'darwin') {
            childProcess.spawn('chflags', ['hidden', dir], { stdio: 'ignore' }).unref()
        }
    } catch {
        // Cosmetic only.
    }
}

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true })
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        cwd: options.cwd,
        stdio: options.stdio ?? 'pipe',
        shell: false,
        encoding: 'utf8'
    })

    if (result.error) {
        throw new Error(`${options.label ?? command} failed: ${result.error.message}`)
    }

    if (result.status !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
        throw new Error(
            `${options.label ?? command} failed with exit code ${result.status}${output ? `: ${output}` : ''}`
        )
    }

    return result.stdout ?? ''
}

function resolveNpmInvocation(env = process.env, nodePath = process.execPath) {
    if (env.npm_execpath) {
        return {
            command: nodePath,
            argsPrefix: [env.npm_execpath],
            label: 'npm'
        }
    }

    const portableNpm = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(portableNpm)) {
        return {
            command: nodePath,
            argsPrefix: [portableNpm],
            label: 'npm'
        }
    }

    return {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        argsPrefix: [],
        label: 'npm'
    }
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

// Walk a release tree and return { 'posix/relative/path': sha256 } for every
// file that the given exclude rules would sync. This is both the integrity
// check input and the applied-manifest payload.
function collectReleaseFiles(sourceRoot, excludes = DEFAULT_EXCLUDES) {
    const files = {}
    const walk = (dir, relative) => {
        for (const entry of fs.readdirSync(dir)) {
            const relPath = relative ? `${relative}/${entry}` : entry
            if (isExcluded(relPath, excludes)) continue
            const absolute = path.join(dir, entry)
            if (fs.statSync(absolute).isDirectory()) {
                walk(absolute, relPath)
            } else {
                files[relPath] = sha256File(absolute)
            }
        }
    }
    walk(sourceRoot, '')
    return files
}

// A manifest path is only ever joined under root when it is a plain,
// relative, forward path. Anything else (absolute, drive-letter, '..', empty
// segments) is ignored — the manifest is local state, but never trust it
// enough to delete outside the install root.
function isSafeManifestPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return false
    if (path.isAbsolute(relPath) || /^[a-z]:/i.test(relPath)) return false
    const segments = pathToPosix(relPath).split('/')
    return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function copyRecursive(src, dest) {
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
        mkdirp(dest)
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry))
        }
        return
    }

    mkdirp(path.dirname(dest))
    fs.copyFileSync(src, dest)
}

function copyReleaseTree(sourceRoot, targetRoot, excludes = DEFAULT_EXCLUDES) {
    for (const entry of fs.readdirSync(sourceRoot)) {
        copyReleaseEntry(path.join(sourceRoot, entry), path.join(targetRoot, entry), entry, excludes)
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

function removeObsoletePaths(root, obsoletePaths = DEFAULT_OBSOLETE_PATHS, excludes = DEFAULT_EXCLUDES) {
    for (const obsoletePath of obsoletePaths) {
        if (isExcluded(obsoletePath, excludes)) continue
        const target = path.join(root, obsoletePath)
        if (!fs.existsSync(target)) continue
        rmrf(target)
        removeEmptyParents(path.dirname(target), root)
    }
}

function normalizeRepoUrl(value) {
    return String(value || '')
        .trim()
        .replace(/^git@github\.com:/i, 'https://github.com/')
        .replace(/^https?:\/\/github\.com\//i, 'github.com/')
        .replace(/\.git$/i, '')
        .replace(/\/+$/g, '')
        .toLowerCase()
}

function remoteMatchesRepo(remoteUrl, repo) {
    const normalizedRemote = normalizeRepoUrl(remoteUrl)
    const normalizedRepo = normalizeRepoUrl(repo)
    return normalizedRemote === normalizedRepo || normalizedRemote.endsWith(`/${normalizedRepo}`)
}

function assertSafeBranchName(branch) {
    if (
        typeof branch !== 'string' ||
        !/^[A-Za-z0-9._/-]+$/.test(branch) ||
        branch.startsWith('/') ||
        branch.endsWith('/') ||
        branch.includes('..') ||
        branch.includes('//') ||
        branch.endsWith('.lock')
    ) {
        throw new Error(`Unsafe update branch name: ${branch}`)
    }
}

function pruneManagedPaths(sourceRoot, targetRoot, managedPaths = DEFAULT_MANAGED_PATHS, excludes = DEFAULT_EXCLUDES) {
    for (const managedPath of managedPaths) {
        if (isExcluded(managedPath, excludes)) continue

        const source = path.join(sourceRoot, managedPath)
        const target = path.join(targetRoot, managedPath)
        if (!fs.existsSync(target)) continue

        if (!fs.existsSync(source)) {
            rmrf(target)
            removeEmptyParents(path.dirname(target), targetRoot)
            continue
        }

        pruneManagedEntry(source, target, managedPath, excludes, targetRoot)
    }
}

function pruneManagedEntry(source, target, relativePath, excludes, targetRoot) {
    if (isExcluded(relativePath, excludes)) return
    if (!fs.existsSync(target)) return

    const sourceStat = fs.statSync(source)
    const targetStat = fs.statSync(target)

    if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
        rmrf(target)
        return
    }

    if (!sourceStat.isDirectory()) return

    for (const entry of fs.readdirSync(target)) {
        const childRelative = pathToPosix(path.join(relativePath, entry))
        if (isExcluded(childRelative, excludes)) continue

        const childSource = path.join(source, entry)
        const childTarget = path.join(target, entry)
        if (!fs.existsSync(childSource)) {
            rmrf(childTarget)
            removeEmptyParents(path.dirname(childTarget), targetRoot)
            continue
        }

        pruneManagedEntry(childSource, childTarget, childRelative, excludes, targetRoot)
    }
}

function assertAllowedUpdateUrl(url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase())) {
        throw new Error(`Updater refused untrusted URL: ${parsed.protocol}//${parsed.host}`)
    }
}

function requestBuffer(url, timeoutMs = 45_000, headers = {}, options = {}) {
    const redirects = options.redirects ?? 0
    const maxRedirects = options.maxRedirects ?? 5
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    assertAllowedUpdateUrl(url)
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                timeout: timeoutMs,
                headers: {
                    'user-agent': 'msrb-updater',
                    'cache-control': 'no-cache',
                    pragma: 'no-cache',
                    ...headers
                }
            },
            response => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    response.resume()
                    if (redirects >= maxRedirects) {
                        reject(new Error(`Too many redirects while requesting ${url}`))
                        return
                    }
                    requestBuffer(new URL(response.headers.location, url).toString(), timeoutMs, headers, {
                        ...options,
                        redirects: redirects + 1
                    }).then(resolve, reject)
                    return
                }

                const chunks = []
                let received = 0
                response.on('error', reject)
                response.on('data', chunk => {
                    received += chunk.length
                    if (received > maxBytes) {
                        response.destroy(new Error(`Response exceeded ${maxBytes} bytes: ${url}`))
                        return
                    }
                    chunks.push(chunk)
                })
                response.on('end', () => {
                    const body = Buffer.concat(chunks)
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(
                            new Error(
                                `HTTP ${response.statusCode} while requesting ${url}: ${body.toString('utf8').slice(0, 200)}`
                            )
                        )
                        return
                    }
                    resolve(body)
                })
            }
        )

        request.on('timeout', () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)))
        request.on('error', reject)
    })
}

async function requestJson(url, timeoutMs = 20_000, headers = {}) {
    const body = await requestBuffer(url, timeoutMs, {
        accept: 'application/vnd.github+json',
        ...headers
    })
    return JSON.parse(body.toString('utf8'))
}

async function requestText(url, timeoutMs = 20_000, headers = {}) {
    const body = await requestBuffer(url, timeoutMs, headers)
    return body.toString('utf8')
}

function download(url, dest, timeoutMs = 45_000, options = {}) {
    const redirects = options.redirects ?? 0
    const maxRedirects = options.maxRedirects ?? 5
    const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
    assertAllowedUpdateUrl(url)
    return new Promise((resolve, reject) => {
        mkdirp(path.dirname(dest))
        const file = fs.createWriteStream(dest)

        const request = https.get(
            url,
            {
                timeout: timeoutMs,
                headers: {
                    'user-agent': 'msrb-updater',
                    accept: options.accept || 'application/octet-stream, */*;q=0.8'
                }
            },
            response => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    file.close()
                    rmrf(dest)
                    if (redirects >= maxRedirects) {
                        reject(new Error(`Too many redirects while downloading ${url}`))
                        return
                    }
                    download(new URL(response.headers.location, url).toString(), dest, timeoutMs, {
                        ...options,
                        redirects: redirects + 1
                    }).then(resolve, reject)
                    return
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    file.close()
                    rmrf(dest)
                    reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`))
                    return
                }

                let received = 0
                response.on('data', chunk => {
                    received += chunk.length
                    if (received > maxBytes) {
                        response.destroy(new Error(`Download exceeded ${maxBytes} bytes: ${url}`))
                    }
                })
                response.on('error', error => {
                    file.close()
                    rmrf(dest)
                    reject(error)
                })
                response.pipe(file)
                file.on('finish', () => file.close(resolve))
            }
        )

        request.on('timeout', () => request.destroy(new Error(`Download timed out after ${timeoutMs}ms`)))
        request.on('error', error => {
            file.close()
            rmrf(dest)
            reject(error)
        })
    })
}

function color(code, value) {
    return `\u001b[${code}m${value}\u001b[0m`
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error?.code === 'EPERM'
    }
}

class UpdateManager {
    constructor(options = {}) {
        this.root = options.root ?? path.resolve(__dirname, '..', '..')
        this.logger = options.logger ?? console
        this.repo = options.repo ?? process.env.MSRB_UPDATE_REPO ?? DEFAULT_REPO
        this.branch = options.branch ?? process.env.MSRB_UPDATE_BRANCH ?? DEFAULT_BRANCH
        this.updatesDir = path.join(this.root, '.updates')
        this.packageJson = readJson(path.join(this.root, 'package.json'))
    }

    shouldSkip(argv = process.argv, env = process.env) {
        if (env.MSRB_AUTO_UPDATE === '0') return { skip: true, reason: 'MSRB_AUTO_UPDATE=0' }
        if (argv.includes('-dev') || argv.includes('--dev')) return { skip: true, reason: 'dev mode' }
        if (env.npm_lifecycle_event === 'dev') return { skip: true, reason: 'npm run dev' }
        return { skip: false }
    }

    isDocker() {
        if (fs.existsSync('/.dockerenv')) return true
        try {
            return fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker')
        } catch {
            return false
        }
    }

    async run(options = {}) {
        const env = options.env ?? process.env
        const argv = options.argv ?? process.argv
        const skip = this.shouldSkip(argv, env)
        if (skip.skip) {
            this.logger.log(`[UPDATER] Skipped (${skip.reason})`)
            return { status: 'skipped', reason: skip.reason }
        }

        const force = this.shouldForceUpdate(options, env, argv)
        this.logger.log(`[UPDATER] Checking ${this.repo}#${this.branch}`)

        try {
            const remote = await this.fetchRemoteRelease()
            this.logRemote(remote)

            const docker = this.isDocker()
            const initialDecision = this.updateDecision(remote, force && !docker)

            if (!initialDecision.apply) {
                this.logger.log(`[UPDATER] Already up to date (${this.packageJson.version})`)
                migrateUserFiles(this.root, this.logger)
                return { status: 'current', remote }
            }

            if (docker) {
                this.logDockerUpdateAvailable(remote)
                return { status: 'update-available', remote, docker: true }
            }

            if (options.dryRun || env.MSRB_UPDATE_DRY_RUN === '1' || env.MSRB_UPDATE_CHECK_ONLY === '1') {
                const action = initialDecision.reason === 'forced' ? 'repair from' : 'update to'
                this.logger.log(`[UPDATER] Check only: would ${action} ${remote.version}`)
                return {
                    status: 'update-available',
                    remote,
                    checkOnly: true,
                    forced: initialDecision.reason === 'forced'
                }
            }

            return await this.withUpdateLock(
                async () => {
                    this.packageJson = readJson(path.join(this.root, 'package.json'))
                    const decision = this.updateDecision(remote, force)

                    if (!decision.apply) {
                        this.logger.log(`[UPDATER] Already updated by another process (${this.packageJson.version})`)
                        migrateUserFiles(this.root, this.logger)
                        return { status: 'current', remote }
                    }

                    this.assertCompatibleNode(remote.packageJson)
                    const applyResult = await this.applyRelease(remote)
                    this.syncDependencies()
                    this.verifyAppliedRelease(remote)
                    this.packageJson = readJson(path.join(this.root, 'package.json'))
                    const forced = decision.reason === 'forced'
                    this.logger.log(
                        forced
                            ? `[UPDATER] Repaired ${remote.version} via ${applyResult.strategy}`
                            : `[UPDATER] Updated to ${remote.version} via ${applyResult.strategy}`
                    )
                    return { status: 'updated', remote, strategy: applyResult.strategy, forced }
                },
                { env }
            )
        } catch (error) {
            this.logger.warn(`[UPDATER] Update check failed: ${error.message}`)
            return { status: 'failed', error }
        }
    }

    async fetchRemoteRelease() {
        assertSafeBranchName(this.branch)
        const branch = encodeURIComponent(this.branch)
        const commit = await requestJson(this.githubApiUrl(`/repos/${this.repo}/commits/${branch}`))
        const commitSha = commit?.sha
        if (!/^[a-f0-9]{40}$/i.test(commitSha || '')) {
            throw new Error(`GitHub did not return a valid commit SHA for ${this.repo}#${this.branch}`)
        }
        const packageUrl = this.githubApiUrl(`/repos/${this.repo}/contents/package.json?ref=${commitSha}`)
        const packageSource = await requestText(packageUrl, 20_000, { accept: 'application/vnd.github.raw' })
        const packageJson = JSON.parse(packageSource)
        if (!isReleaseVersion(packageJson.version)) {
            throw new Error(`Remote package.json at ${commitSha.slice(0, 12)} has no valid version`)
        }

        return {
            version: packageJson.version,
            commitSha,
            branch: this.branch,
            repo: this.repo,
            packageJson,
            archiveUrl: this.githubApiUrl(`/repos/${this.repo}/tarball/${commitSha}`),
            checkedAt: new Date().toISOString()
        }
    }

    githubApiUrl(pathname) {
        return `https://api.github.com${pathname}`
    }

    isNewer(remoteVersion) {
        return compareReleaseVersions(remoteVersion, this.packageJson.version) > 0
    }

    updateDecision(remote, force = false) {
        const comparison = compareReleaseVersions(remote.version, this.packageJson.version)
        if (comparison > 0) {
            return { apply: true, reason: 'newer' }
        }
        if (force && comparison === 0) {
            return { apply: true, reason: 'forced' }
        }
        return { apply: false, reason: 'current' }
    }

    shouldForceUpdate(options = {}, env = process.env, argv = process.argv) {
        return (
            options.force === true ||
            env.MSRB_UPDATE_FORCE === '1' ||
            argv.includes('--force-update') ||
            argv.includes('--repair-update')
        )
    }

    assertCompatibleNode(packageJson) {
        const range = packageJson?.engines?.node
        if (!range) return
        const semver = require('semver')
        if (!semver.satisfies(process.version, range)) {
            throw new Error(`Node ${process.version} does not satisfy remote requirement ${range}`)
        }
    }

    logRemote(remote) {
        this.logger.log(
            `[UPDATER] Local=${this.packageJson.version} Remote=${remote.version} SHA=${remote.commitSha.slice(0, 12)}`
        )
    }

    logDockerUpdateAvailable(remote) {
        this.logger.warn(
            color(
                33,
                `[UPDATER] Update available: local ${this.packageJson.version} -> remote ${remote.version}. Docker containers update by replacing the image, never in place.`
            )
        )
        this.logger.warn(
            color(
                33,
                '[UPDATER] Run `docker compose pull && docker compose up -d` (published image) or `docker compose up -d --build` (local build).'
            )
        )
    }

    async applyRelease(remote) {
        const strategy = this.resolveUpdateStrategy()
        if (strategy !== 'archive' && this.canUseGitUpdate()) {
            return this.applyGitRelease(remote)
        }

        if (strategy === 'git') {
            throw new Error('MSRB_UPDATE_STRATEGY=git requested, but this install is not a compatible Git working tree')
        }

        return this.applyArchiveRelease(remote)
    }

    resolveUpdateStrategy(env = process.env) {
        const strategy = env.MSRB_UPDATE_STRATEGY ?? 'auto'
        if (!UPDATE_STRATEGIES.has(strategy)) {
            throw new Error(`Unsupported MSRB_UPDATE_STRATEGY=${strategy}. Use auto, git, or archive.`)
        }
        return strategy
    }

    async withUpdateLock(callback, options = {}) {
        const lock = await this.acquireUpdateLock(options)
        if (!lock.acquired) {
            const owner = lock.lock?.pid ? `pid ${lock.lock.pid}` : 'another process'
            this.logger.warn(`[UPDATER] Update lock is still active (${owner}); continuing with the local version.`)
            return { status: 'skipped', reason: 'update lock active' }
        }

        try {
            return await callback()
        } finally {
            this.releaseUpdateLock(lock)
        }
    }

    async acquireUpdateLock(options = {}) {
        const env = options.env ?? process.env
        const waitMs = positiveInteger(options.waitMs ?? env.MSRB_UPDATE_LOCK_WAIT_MS, DEFAULT_UPDATE_LOCK_WAIT_MS)
        const staleMs = positiveInteger(options.staleMs ?? env.MSRB_UPDATE_LOCK_STALE_MS, DEFAULT_UPDATE_LOCK_STALE_MS)
        const startedAt = Date.now()
        const token = crypto.randomUUID()
        const lockPath = this.updateLockPath()

        mkdirp(this.updatesDir)
        markDirHidden(this.updatesDir)

        while (true) {
            try {
                const lock = {
                    version: 1,
                    token,
                    pid: process.pid,
                    cwd: this.root,
                    createdAt: new Date().toISOString()
                }
                fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' })
                return { acquired: true, lock, path: lockPath }
            } catch (error) {
                if (error.code !== 'EEXIST') throw error
            }

            const lock = this.readUpdateLock()
            if (this.isUpdateLockStale(lock, staleMs)) {
                fs.rmSync(lockPath, { force: true })
                continue
            }

            if (Date.now() - startedAt >= waitMs) {
                return { acquired: false, lock, path: lockPath }
            }

            await sleep(Math.min(UPDATE_LOCK_POLL_MS, Math.max(0, waitMs - (Date.now() - startedAt))))
        }
    }

    releaseUpdateLock(lockHandle) {
        if (!lockHandle?.acquired) return
        const current = this.readUpdateLock()
        if (current?.token !== lockHandle.lock?.token) return
        fs.rmSync(lockHandle.path || this.updateLockPath(), { force: true })
    }

    readUpdateLock() {
        try {
            return JSON.parse(fs.readFileSync(this.updateLockPath(), 'utf8'))
        } catch {
            return null
        }
    }

    isUpdateLockStale(lock, staleMs = DEFAULT_UPDATE_LOCK_STALE_MS) {
        if (!lock || typeof lock !== 'object') return true
        if (lock.cwd && path.resolve(String(lock.cwd)) !== path.resolve(this.root)) return true

        const createdAt = Date.parse(String(lock.createdAt || ''))
        const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : Infinity
        if (ageMs > staleMs) return true

        return !isProcessAlive(Number(lock.pid))
    }

    updateLockPath() {
        return path.join(this.updatesDir, UPDATE_LOCK_FILE)
    }

    canUseGitUpdate() {
        if (!fs.existsSync(path.join(this.root, '.git'))) return false

        try {
            runCommand('git', ['--version'], { label: 'git --version' })
            const remoteUrl = this.git(['remote', 'get-url', 'origin']).trim()
            return remoteMatchesRepo(remoteUrl, this.repo)
        } catch (error) {
            this.logger.warn(`[UPDATER] Git update unavailable, falling back to archive: ${error.message}`)
            return false
        }
    }

    git(args, options = {}) {
        return runCommand('git', args, {
            cwd: this.root,
            stdio: options.stdio,
            label: `git ${args.join(' ')}`
        })
    }

    async applyGitRelease(remote) {
        assertSafeBranchName(this.branch)

        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupDir = path.join(this.updatesDir, stamp, 'backup')
        mkdirp(backupDir)

        const before = this.git(['rev-parse', 'HEAD']).trim()
        const remoteRef = `refs/remotes/origin/${this.branch}`
        const fetchRef = `+refs/heads/${this.branch}:${remoteRef}`

        this.logger.log(`[UPDATER] Applying update with Git reset to ${remote.commitSha.slice(0, 12)}`)
        this.backupMutablePaths(backupDir)

        try {
            this.git(['fetch', '--prune', 'origin', fetchRef], { stdio: 'pipe' })
            const fetchedSha = this.git(['rev-parse', `${remoteRef}^{commit}`]).trim()
            if (fetchedSha !== remote.commitSha) {
                throw new Error(
                    `Fetched ${fetchedSha.slice(0, 12)} but GitHub reported ${remote.commitSha.slice(0, 12)}`
                )
            }

            this.git(['reset', '--hard', remote.commitSha], { stdio: 'pipe' })
            this.git(['clean', '-ffd', '--', ...DEFAULT_MANAGED_PATHS], { stdio: 'pipe' })
            this.restoreBackup(backupDir)
            migrateUserFiles(this.root, this.logger)
            this.verifyAppliedRelease(remote)
            // Git itself guarantees tree integrity here; record what was
            // applied (no file map — `git status` is the drift check for git
            // installs) and trim old workdirs.
            this.writeAppliedManifest({
                strategy: 'git',
                botVersion: remote.version,
                commitSha: remote.commitSha
            })
            this.cleanupUpdateWorkDirs()
            return { strategy: 'git', before, after: remote.commitSha }
        } catch (error) {
            this.logger.warn(`[UPDATER] Git apply failed, rolling back: ${error.message}`)
            try {
                this.git(['reset', '--hard', before], { stdio: 'pipe' })
            } catch (rollbackError) {
                this.logger.warn(`[UPDATER] Git rollback reset failed: ${rollbackError.message}`)
            }
            this.restoreBackup(backupDir)
            throw error
        }
    }

    async applyArchiveRelease(remote) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const workDir = path.join(this.updatesDir, stamp)
        const archivePath = path.join(workDir, `${this.repo.replace(/[^\w.-]+/g, '-')}-${remote.commitSha}.tar.gz`)
        const extractDir = path.join(workDir, 'extract')
        const backupDir = path.join(workDir, 'backup')

        mkdirp(workDir)
        mkdirp(extractDir)
        mkdirp(backupDir)

        await this.downloadArchive(remote.archiveUrl, archivePath)
        this.extractArchive(archivePath, extractDir)
        const sourceRoot = findExtractedRoot(extractDir)
        this.verifySourceRootRelease(sourceRoot, remote)

        try {
            const applied = this.applyFromSourceRoot(sourceRoot, backupDir)
            migrateUserFiles(this.root, this.logger)
            this.verifyAppliedRelease(remote)
            this.writeAppliedManifest({
                strategy: 'archive',
                botVersion: remote.version,
                commitSha: remote.commitSha,
                files: applied.files
            })
            this.cleanupUpdateArtifacts(workDir, { archivePath, extractDir })
            return { strategy: 'archive' }
        } catch (error) {
            this.logger.warn(`[UPDATER] Apply failed, rolling back: ${error.message}`)
            this.restoreBackup(backupDir)
            throw error
        }
    }

    async downloadArchive(archiveUrl, archivePath) {
        await download(archiveUrl, archivePath, 60_000, { accept: 'application/vnd.github+json' })
    }

    extractArchive(archivePath, extractDir) {
        const result = childProcess.spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
            stdio: 'pipe',
            encoding: 'utf8'
        })
        if (result.status !== 0) {
            throw new Error(`Archive extraction failed: ${result.stderr || result.stdout || 'tar failed'}`)
        }
    }

    applyFromSourceRoot(sourceRoot, backupDir, options = {}) {
        const excludes = options.excludes ?? DEFAULT_EXCLUDES
        // Root package.json is the updater's only "this version is applied"
        // marker, so it is deliberately excluded from the bulk copy and
        // written last, after every other file has been copied and verified.
        // If anything fails before that final write, the old version stays on
        // disk and the next launch simply re-applies the same pinned release —
        // instead of a half-updated tree that already claims the new version.
        const copyExcludes = [...excludes, 'package.json']

        this.backupMutablePaths(backupDir, excludes)
        this.pruneFromAppliedManifest(sourceRoot, excludes)
        pruneManagedPaths(sourceRoot, this.root, options.managedPaths ?? DEFAULT_MANAGED_PATHS, excludes)
        removeObsoletePaths(this.root, options.obsoletePaths ?? DEFAULT_OBSOLETE_PATHS, excludes)
        copyReleaseTree(sourceRoot, this.root, copyExcludes)

        const files = this.verifyReleaseTree(sourceRoot, copyExcludes)

        const sourcePackage = path.join(sourceRoot, 'package.json')
        const targetPackage = path.join(this.root, 'package.json')
        fs.copyFileSync(sourcePackage, targetPackage)
        const packageHash = sha256File(sourcePackage)
        if (sha256File(targetPackage) !== packageHash) {
            throw new Error('Update apply failed: package.json did not copy intact')
        }
        files['package.json'] = packageHash

        return { files }
    }

    // Compare every synced file on disk against the extracted release,
    // byte-for-byte (SHA-256). This is what turns "the copy loop finished"
    // into "the update is actually on disk".
    verifyReleaseTree(sourceRoot, excludes = DEFAULT_EXCLUDES) {
        const files = collectReleaseFiles(sourceRoot, excludes)
        const problems = []
        for (const [relPath, expectedHash] of Object.entries(files)) {
            const target = path.join(this.root, relPath)
            if (!fs.existsSync(target)) {
                problems.push(`missing: ${relPath}`)
                continue
            }
            if (sha256File(target) !== expectedHash) {
                problems.push(`corrupted: ${relPath}`)
            }
        }
        if (problems.length > 0) {
            const shown = problems.slice(0, 10).join(', ')
            const more = problems.length > 10 ? ` (+${problems.length - 10} more)` : ''
            throw new Error(`Update verification failed for ${problems.length} file(s): ${shown}${more}`)
        }
        return files
    }

    // Delete files that the previous applied release installed but the new
    // release no longer ships. Unlike the static managed/obsolete lists, this
    // covers every synced path (root files included) without anyone having to
    // remember to hand-list deletions — user files can never appear here
    // because excluded paths are never recorded in the manifest.
    pruneFromAppliedManifest(sourceRoot, excludes = DEFAULT_EXCLUDES) {
        const manifest = this.readAppliedManifest()
        const files = manifest?.files
        if (!files || typeof files !== 'object') return

        for (const relPath of Object.keys(files)) {
            if (!isSafeManifestPath(relPath)) continue
            const posix = pathToPosix(relPath)
            if (posix === 'package.json') continue
            if (isExcluded(posix, excludes)) continue
            if (fs.existsSync(path.join(sourceRoot, posix))) continue

            const target = path.join(this.root, posix)
            if (!fs.existsSync(target)) continue
            rmrf(target)
            removeEmptyParents(path.dirname(target), this.root)
        }
    }

    appliedManifestPath() {
        return path.join(this.updatesDir, APPLIED_MANIFEST_FILE)
    }

    readAppliedManifest() {
        try {
            return JSON.parse(fs.readFileSync(this.appliedManifestPath(), 'utf8'))
        } catch {
            return null
        }
    }

    writeAppliedManifest(data) {
        mkdirp(this.updatesDir)
        const manifest = {
            schemaVersion: 1,
            appliedAt: new Date().toISOString(),
            ...data
        }
        const manifestPath = this.appliedManifestPath()
        const tempPath = `${manifestPath}.${process.pid}.tmp`
        fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`)
        fs.renameSync(tempPath, manifestPath)
    }

    // Re-hash the installed tree against the last applied manifest. Used by
    // update:doctor to prove (or disprove) that the version on disk is what
    // the last update actually installed.
    verifyAppliedManifest() {
        const manifest = this.readAppliedManifest()
        if (!manifest) return { status: 'missing' }
        if (manifest.strategy !== 'archive' || !manifest.files || typeof manifest.files !== 'object') {
            return { status: 'unsupported', strategy: manifest.strategy ?? 'unknown' }
        }
        if (manifest.botVersion !== this.packageJson.version) {
            return { status: 'stale', manifestVersion: manifest.botVersion, localVersion: this.packageJson.version }
        }

        const missing = []
        const drifted = []
        for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
            if (!isSafeManifestPath(relPath)) continue
            const target = path.join(this.root, pathToPosix(relPath))
            if (!fs.existsSync(target)) {
                missing.push(relPath)
            } else if (sha256File(target) !== expectedHash) {
                drifted.push(relPath)
            }
        }

        return {
            status: missing.length > 0 || drifted.length > 0 ? 'drift' : 'ok',
            fileCount: Object.keys(manifest.files).length,
            missing,
            drifted
        }
    }

    // After a successful apply: drop the biggest artifacts of the current
    // workdir right away (tarball + extracted tree), then trim old stamped
    // workdirs. Without this, .updates/ grew by the size of the repo on every
    // single update, forever.
    cleanupUpdateArtifacts(workDir, { archivePath, extractDir } = {}) {
        try {
            if (archivePath) rmrf(archivePath)
            if (extractDir) rmrf(extractDir)
            if (workDir && fs.existsSync(workDir) && fs.readdirSync(workDir).length === 0) {
                fs.rmdirSync(workDir)
            }
        } catch (error) {
            this.logger.warn(`[UPDATER] Workdir cleanup failed (non-fatal): ${error.message}`)
        }
        this.cleanupUpdateWorkDirs()
    }

    cleanupUpdateWorkDirs(keep = KEEP_UPDATE_WORKDIRS) {
        let entries
        try {
            entries = fs.readdirSync(this.updatesDir, { withFileTypes: true })
        } catch {
            return
        }

        // Stamped workdirs are ISO timestamps with ':' and '.' replaced by '-',
        // so a lexicographic sort is chronological.
        const stamped = entries
            .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
            .map(entry => entry.name)
            .sort()

        for (const name of stamped.slice(0, Math.max(0, stamped.length - keep))) {
            try {
                rmrf(path.join(this.updatesDir, name))
            } catch (error) {
                this.logger.warn(`[UPDATER] Could not remove old update workdir ${name}: ${error.message}`)
            }
        }
    }

    verifySourceRootRelease(sourceRoot, remote) {
        const packagePath = path.join(sourceRoot, 'package.json')
        if (!fs.existsSync(packagePath)) {
            throw new Error('Downloaded release is missing package.json')
        }

        const packageJson = readJson(packagePath)
        if (packageJson.version !== remote.version) {
            throw new Error(
                `Downloaded release version ${packageJson.version || 'unknown'} does not match remote ${remote.version}`
            )
        }
    }

    verifyAppliedRelease(remote) {
        const packagePath = path.join(this.root, 'package.json')
        if (!fs.existsSync(packagePath)) {
            throw new Error('Update verification failed: local package.json is missing')
        }

        const packageJson = readJson(packagePath)
        if (packageJson.version !== remote.version) {
            throw new Error(
                `Update verification failed: local package.json is ${packageJson.version || 'unknown'}, expected ${remote.version}`
            )
        }
    }

    backupMutablePaths(backupDir, excludes = DEFAULT_EXCLUDES) {
        for (const pattern of this.getBackupPaths(excludes)) {
            if (pattern.includes('*')) continue
            const source = path.join(this.root, pattern)
            if (!fs.existsSync(source)) continue
            copyRecursive(source, path.join(backupDir, pattern))
        }
    }

    restoreBackup(backupDir, excludes = DEFAULT_EXCLUDES) {
        if (!fs.existsSync(backupDir)) return
        for (const pattern of this.getBackupPaths(excludes)) {
            if (pattern.includes('*')) continue
            const backupSource = path.join(backupDir, pattern)
            const target = path.join(this.root, pattern)

            if (fs.existsSync(target)) rmrf(target)
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

    syncDependencies() {
        const hasLockfile = fs.existsSync(path.join(this.root, 'package-lock.json'))
        try {
            this.runNpm(hasLockfile ? ['ci'] : ['install'])
        } catch (error) {
            if (!hasLockfile) throw error
            // At this point the release files are already applied; giving up
            // here would strand the install as "up to date" with stale
            // dependencies. `npm ci` is strict (and brittle against a dirty
            // node_modules or npm cache), so fall back to `npm install`,
            // which still honors the lockfile.
            this.logger.warn(`[UPDATER] npm ci failed (${error.message}); retrying with npm install`)
            this.runNpm(['install'])
        }
    }

    runNpm(args) {
        const npm = resolveNpmInvocation()
        this.logger.log(`[UPDATER] Syncing dependencies with ${npm.label} ${args.join(' ')}`)
        const result = childProcess.spawnSync(npm.command, [...npm.argsPrefix, ...args], {
            cwd: this.root,
            stdio: 'inherit',
            shell: false
        })
        if (result.error) throw new Error(`Dependency sync failed: ${result.error.message}`)
        if (result.status !== 0) throw new Error(`Dependency sync failed with exit code ${result.status}`)
    }
}

module.exports = {
    DEFAULT_BACKUP_PATHS,
    DEFAULT_BRANCH,
    DEFAULT_EXCLUDES,
    DEFAULT_MANAGED_PATHS,
    DEFAULT_OBSOLETE_PATHS,
    DEFAULT_REPO,
    UpdateManager,
    collectReleaseFiles,
    copyReleaseTree,
    download,
    findExtractedRoot,
    isExcluded,
    isSafeManifestPath,
    pruneManagedPaths,
    resolveNpmInvocation,
    requestJson,
    sha256File
}
