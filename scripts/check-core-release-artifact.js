const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE_DIR = path.join(ROOT, 'plugins', 'core')
const OFFICIAL_CORE_PATH = path.join(ROOT, 'plugins', 'official-core.json')
const CATALOG_PATH = path.join(ROOT, 'plugins', 'catalog.json')
const CORE_API_POLICY_PATH = path.resolve(ROOT, '..', 'Core-API', 'config', 'core-version-policy.json')

const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.map', '.env', '.pem', '.key'])
const FORBIDDEN_NAMES = new Set(['.env', '.env.local', '.env.production'])
const ALLOWED_JS_FILES = new Set(['index.js'])
const ALLOWED_TOP_LEVEL_CORE_FILES = new Set(['index.js', 'package.json', 'package-lock.json', 'LICENSE'])
const REQUIRED_TARGETS = new Set([
    'win32-x64-node-24.15.0',
    'linux-x64-node-24.15.0',
    'linux-arm64-node-24.15.0'
])

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
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
    const match = targetId.match(/^(win32|linux)-(x64|arm64)-node-(\d+\.\d+\.\d+)$/)
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

    const officialCore = readJson(OFFICIAL_CORE_PATH)
    const catalog = readJson(CATALOG_PATH)
    const catalogCore = Array.isArray(catalog.plugins) ? catalog.plugins.find(plugin => plugin.name === 'core') : null
    const targets = officialCore.targets || corePackage.msrb?.targets || null
    const coreVersion = corePackage.version

    assertSameVersion('plugins/official-core.json', officialCore.version, coreVersion)
    assertSameVersion('plugins/catalog.json core', catalogCore?.version, coreVersion)

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
        if (!catalogCore?.targets || typeof catalogCore.targets !== 'object') {
            fail('plugins/catalog.json core targets metadata is missing')
        }
        const packageTargets = corePackage.msrb?.targets || {}
        const catalogTargets = catalogCore?.targets || {}
        assertTargetSet('plugins/official-core.json', officialCore.targets)
        assertTargetSet('plugins/core/package.json', packageTargets)
        assertTargetSet('plugins/catalog.json', catalogTargets)
        for (const [targetId, target] of Object.entries(targets)) {
            const indexJsc = path.join(CORE_DIR, 'targets', targetId, 'index.jsc')
            if (!fs.existsSync(indexJsc)) {
                fail(`plugins/core/targets/${targetId}/index.jsc is missing`)
                continue
            }
            assertTargetMetadata(targetId, target, 'plugins/official-core.json')
            assertTargetMetadata(targetId, packageTargets[targetId] || {}, 'plugins/core/package.json')
            assertTargetMetadata(targetId, catalogTargets[targetId] || {}, 'plugins/catalog.json')
            const actualHash = sha256(indexJsc)
            if (target.indexSha256 !== actualHash) {
                fail(`plugins/official-core.json ${targetId} indexSha256 does not match the target bytecode`)
            }
            if (packageTargets[targetId]?.indexSha256 !== actualHash) {
                fail(`plugins/core/package.json ${targetId} indexSha256 does not match the target bytecode`)
            }
            if (catalogTargets[targetId]?.indexSha256 !== actualHash) {
                fail(`plugins/catalog.json ${targetId} indexSha256 does not match the target bytecode`)
            }
            if (!target.bytecodeTarget?.node || !target.bytecodeTarget?.platform || !target.bytecodeTarget?.arch) {
                fail(`plugins/official-core.json ${targetId} bytecodeTarget metadata is incomplete`)
            }
        }
        const targetList = Object.keys(targets).join(', ')
        console.log(`[CORE-RELEASE-CHECK] Core bytecode targets: ${targetList}`)
    } else {
        const indexJsc = path.join(CORE_DIR, 'index.jsc')
        if (!fs.existsSync(indexJsc)) {
            fail('plugins/core/index.jsc is missing')
            return
        }

        const actualHash = sha256(indexJsc)
        if (officialCore.indexSha256 !== actualHash) {
            fail('plugins/official-core.json indexSha256 does not match plugins/core/index.jsc')
        }
        if (corePackage.msrb?.indexSha256 !== actualHash) {
            fail('plugins/core/package.json msrb.indexSha256 does not match plugins/core/index.jsc')
        }
        if (catalogCore?.sha256 !== actualHash) {
            fail('plugins/catalog.json core sha256 does not match plugins/core/index.jsc')
        }

        const target = officialCore.bytecodeTarget || corePackage.msrb?.bytecodeTarget
        if (!target) {
            console.warn('[CORE-RELEASE-CHECK] Core bytecode target metadata is missing; single-target legacy artifact detected.')
        } else {
            console.log(`[CORE-RELEASE-CHECK] Core bytecode target: ${target.platform}/${target.arch}/node-${target.node}`)
        }
    }

    if (!process.exitCode) {
        console.log('[CORE-RELEASE-CHECK] Core release artifact check passed.')
    }
}

main()
