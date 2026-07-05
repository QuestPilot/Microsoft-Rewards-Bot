const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_DIR = path.join(ROOT, 'plugins', 'core')
const OFFICIAL_CORE_PATH = path.join(ROOT, 'plugins', 'official-core.json')
const OFFICIAL_CORE_SIGNATURE_PATH = path.join(ROOT, 'plugins', 'official-core.sig')
const CORE_PUBLIC_KEY_PATH = path.join(ROOT, 'scripts', 'security', 'core-public-key.pem')
const CORE_API_POLICY_PATH = path.resolve(ROOT, '..', 'Core-API', 'config', 'core-version-policy.json')

const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.map', '.env', '.pem', '.key'])
const FORBIDDEN_NAMES = new Set(['.env', '.env.local', '.env.production'])
const ALLOWED_JS_FILES = new Set(['index.js'])
const ALLOWED_TOP_LEVEL_CORE_FILES = new Set(['index.js', 'package.json', 'package-lock.json', 'LICENSE'])
const FORBIDDEN_BYTECODE_MARKERS = [
    '__MSRB_RELEASE_DASHBOARD_CLIENT_SECRET__',
    'MSRB_RELEASE_DASHBOARD_CLIENT_SECRET',
    'CORE_DASHBOARD_CLIENT_SECRET',
    '.env.dashboard.local'
]
const REQUIRED_TARGETS = new Set([
    'win32-x64-node-24.15.0',
    'linux-x64-node-24.15.0',
    'linux-arm64-node-24.15.0',
    'darwin-x64-node-24.15.0'
])
const DARWIN_COMPAT_TARGET = 'darwin-x64-node-24.15.0'
const DARWIN_COMPAT_SOURCE = 'linux-x64-node-24.15.0'

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function assertNoForbiddenBytecodeMarkers(filePath, label) {
    const artifact = fs.readFileSync(filePath)
    for (const marker of FORBIDDEN_BYTECODE_MARKERS) {
        if (artifact.includes(Buffer.from(marker))) {
            fail(`${label} contains forbidden release marker ${marker}`)
        }
    }
}

function walk(dir, base = dir) {
    const files = []
    if (!fs.existsSync(dir)) return files
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...walk(fullPath, base))
            continue
        }
        files.push({
            fullPath,
            relativePath: path.relative(base, fullPath).replace(/\\/g, '/'),
            name: entry.name,
            extension: path.extname(entry.name).toLowerCase()
        })
    }
    return files
}

function fail(message) {
    console.error(`[CORE-RELEASE-CHECK] ${message}`)
    process.exitCode = 1
}

function assertSameVersion(label, actual, expected) {
    if (actual !== expected) {
        fail(`${label} version ${actual || '(missing)'} does not match Core package version ${expected}`)
    }
}

function assertTargetSet(label, targets) {
    const ids = new Set(Object.keys(targets || {}))
    for (const required of REQUIRED_TARGETS) {
        if (!ids.has(required)) {
            fail(`${label} is missing required Core bytecode target ${required}`)
        }
    }
    for (const id of ids) {
        if (!REQUIRED_TARGETS.has(id)) {
            fail(`${label} contains unsupported Core bytecode target ${id}`)
        }
    }
}

function assertTargetMetadata(targetId, target, sourceLabel) {
    const match = targetId.match(/^(win32|linux|darwin)-(x64|arm64)-node-(\d+\.\d+\.\d+)$/)
    if (!match) {
        fail(`${sourceLabel} target id ${targetId} is not in platform-arch-node-version format`)
        return
    }

    const [, platform, arch, node] = match
    if (target.bytecodeTarget?.platform !== platform || target.bytecodeTarget?.arch !== arch || target.bytecodeTarget?.node !== node) {
        fail(`${sourceLabel} ${targetId} bytecodeTarget metadata does not match its target id`)
    }
}

function main() {
    if (!fs.existsSync(CORE_DIR)) {
        fail('plugins/core is missing')
        return
    }

    const corePackage = readJson(path.join(CORE_DIR, 'package.json'))
    const enforceSingleEntryBytecode = corePackage.msrb?.releaseShape === 'single-entry-bytecode'
    const files = walk(CORE_DIR)
    for (const file of files) {
        const parts = file.relativePath.split('/')
        if (FORBIDDEN_NAMES.has(file.name.toLowerCase()) || FORBIDDEN_EXTENSIONS.has(file.extension)) {
            fail(`Forbidden Core artifact file: plugins/core/${file.relativePath}`)
        }
        if (file.extension === '.js' && !ALLOWED_JS_FILES.has(file.relativePath)) {
            fail(`Forbidden Core JavaScript source file: plugins/core/${file.relativePath}`)
        }
        if (enforceSingleEntryBytecode) {
            if (parts[0] === 'targets') {
                if (parts.length !== 3 || parts[2] !== 'index.jsc' || !REQUIRED_TARGETS.has(parts[1])) {
                    fail(`Forbidden Core target artifact shape: plugins/core/${file.relativePath}`)
                }
            } else if (file.extension === '.jsc') {
                fail(`Forbidden legacy Core bytecode location: plugins/core/${file.relativePath}`)
            } else if (parts.length !== 1 || !ALLOWED_TOP_LEVEL_CORE_FILES.has(parts[0])) {
                fail(`Forbidden Core artifact file: plugins/core/${file.relativePath}`)
            }
        }
    }

    const shimPath = path.join(CORE_DIR, 'index.js')
    if (fs.existsSync(shimPath)) {
        assertNoForbiddenBytecodeMarkers(shimPath, 'plugins/core/index.js')
    }

    const manifestPayload = fs.readFileSync(OFFICIAL_CORE_PATH)
    const signature = Buffer.from(fs.readFileSync(OFFICIAL_CORE_SIGNATURE_PATH, 'utf8').trim(), 'base64')
    const publicKey = crypto.createPublicKey(fs.readFileSync(CORE_PUBLIC_KEY_PATH, 'utf8'))
    if (signature.length !== 64 || publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, manifestPayload, publicKey, signature)) {
        fail('plugins/official-core.json signature verification failed')
    }
    const officialCore = JSON.parse(manifestPayload.toString('utf8'))
    const targets = officialCore.targets || corePackage.msrb?.targets || null
    const coreVersion = corePackage.version

    assertSameVersion('plugins/official-core.json', officialCore.version, coreVersion)

    if (fs.existsSync(CORE_API_POLICY_PATH)) {
        const policy = readJson(CORE_API_POLICY_PATH)
        if (policy.required_core_version !== coreVersion) {
            fail(`Core-API required_core_version ${policy.required_core_version || '(missing)'} does not match Core package version ${coreVersion}`)
        }
        if (policy.minimum_core_version !== coreVersion) {
            fail(`Core-API minimum_core_version ${policy.minimum_core_version || '(missing)'} does not match Core package version ${coreVersion}`)
        }
    } else {
        console.warn('[CORE-RELEASE-CHECK] Core-API policy file not found beside this repository; skipping server version policy check.')
    }

    if (targets && typeof targets === 'object') {
        const packageTargets = corePackage.msrb?.targets || {}
        assertTargetSet('plugins/official-core.json', officialCore.targets)
        assertTargetSet('plugins/core/package.json', packageTargets)
        for (const [targetId, target] of Object.entries(targets)) {
            const indexJsc = path.join(CORE_DIR, 'targets', targetId, 'index.jsc')
            if (!fs.existsSync(indexJsc)) {
                fail(`plugins/core/targets/${targetId}/index.jsc is missing`)
                continue
            }
            assertTargetMetadata(targetId, target, 'plugins/official-core.json')
            assertTargetMetadata(targetId, packageTargets[targetId] || {}, 'plugins/core/package.json')
            assertNoForbiddenBytecodeMarkers(indexJsc, `plugins/core/targets/${targetId}/index.jsc`)
            const actualHash = sha256(indexJsc)
            if (target.indexSha256 !== actualHash) {
                fail(`plugins/official-core.json ${targetId} indexSha256 does not match the target bytecode`)
            }
            if (packageTargets[targetId]?.indexSha256 !== actualHash) {
                fail(`plugins/core/package.json ${targetId} indexSha256 does not match the target bytecode`)
            }
            if (!target.bytecodeTarget?.node || !target.bytecodeTarget?.platform || !target.bytecodeTarget?.arch) {
                fail(`plugins/official-core.json ${targetId} bytecodeTarget metadata is incomplete`)
            }
        }
        const darwinTarget = targets[DARWIN_COMPAT_TARGET]
        const linuxSource = targets[DARWIN_COMPAT_SOURCE]
        if (darwinTarget?.compatibleArtifactSource !== DARWIN_COMPAT_SOURCE) {
            fail(`plugins/official-core.json ${DARWIN_COMPAT_TARGET} must declare ${DARWIN_COMPAT_SOURCE} as its compatibility source`)
        }
        if (packageTargets[DARWIN_COMPAT_TARGET]?.compatibleArtifactSource !== DARWIN_COMPAT_SOURCE) {
            fail(`plugins/core/package.json ${DARWIN_COMPAT_TARGET} must declare ${DARWIN_COMPAT_SOURCE} as its compatibility source`)
        }
        if (darwinTarget?.indexSha256 !== linuxSource?.indexSha256) {
            fail(`macOS compatibility target must remain byte-for-byte identical to ${DARWIN_COMPAT_SOURCE}`)
        }
        const targetList = Object.keys(targets).join(', ')
        console.log(`[CORE-RELEASE-CHECK] Core bytecode targets: ${targetList}`)
    } else {
        const indexJsc = path.join(CORE_DIR, 'index.jsc')
        if (!fs.existsSync(indexJsc)) {
            fail('plugins/core/index.jsc is missing')
            return
        }

        assertNoForbiddenBytecodeMarkers(indexJsc, 'plugins/core/index.jsc')
        const actualHash = sha256(indexJsc)
        if (officialCore.indexSha256 !== actualHash) {
            fail('plugins/official-core.json indexSha256 does not match plugins/core/index.jsc')
        }
        if (corePackage.msrb?.indexSha256 !== actualHash) {
            fail('plugins/core/package.json msrb.indexSha256 does not match plugins/core/index.jsc')
        }

        const target = officialCore.bytecodeTarget || corePackage.msrb?.bytecodeTarget
        if (!target) {
            console.warn('[CORE-RELEASE-CHECK] Core bytecode target metadata is missing; single-target legacy artifact detected.')
        } else {
            console.log(`[CORE-RELEASE-CHECK] Core bytecode target: ${target.platform}/${target.arch}/node-${target.node}`)
        }
    }

    // The in-process loader shim (plugins/core/index.js) require()s the verified
    // .jsc bytecode but is never itself hashed against the bytecode — a tampered
    // shim could load an attacker-controlled path while the bytecode hash still
    // "passes" (PluginManager.isVerifiedOfficialCore pins this when present). One
    // shim file covers every target, so the pin is top-level, not per-target.
    if (fs.existsSync(shimPath)) {
        const shimHash = sha256(shimPath)
        const manifestShimSha = officialCore.shimSha256
        const packageShimSha = corePackage.msrb?.shimSha256
        if (!manifestShimSha && !packageShimSha) {
            console.warn(
                '[CORE-RELEASE-CHECK] plugins/core/index.js (loader shim) is not pinned by shimSha256 in official-core.json or package.json — ' +
                'PluginManager currently SKIPS shim verification when this is absent. Add "shimSha256": "' + shimHash + '" before signing this release.'
            )
        } else {
            if (manifestShimSha && manifestShimSha !== shimHash) {
                fail('plugins/official-core.json shimSha256 does not match plugins/core/index.js')
            }
            if (packageShimSha && packageShimSha !== shimHash) {
                fail('plugins/core/package.json msrb.shimSha256 does not match plugins/core/index.js')
            }
        }
    }

    if (!process.exitCode) {
        console.log('[CORE-RELEASE-CHECK] Core release artifact check passed.')
    }
}

main()
