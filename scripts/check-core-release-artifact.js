const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE_DIR = path.join(ROOT, 'plugins', 'core')
const OFFICIAL_CORE_PATH = path.join(ROOT, 'plugins', 'official-core.json')
const CATALOG_PATH = path.join(ROOT, 'plugins', 'catalog.json')

const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.map', '.env', '.pem', '.key'])
const FORBIDDEN_NAMES = new Set(['.env', '.env.local', '.env.production'])
const ALLOWED_JS_FILES = new Set(['index.js'])

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

function main() {
    if (!fs.existsSync(CORE_DIR)) {
        fail('plugins/core is missing')
        return
    }

    const files = walk(CORE_DIR)
    for (const file of files) {
        if (FORBIDDEN_NAMES.has(file.name.toLowerCase()) || FORBIDDEN_EXTENSIONS.has(file.extension)) {
            fail(`Forbidden Core artifact file: plugins/core/${file.relativePath}`)
        }
        if (file.extension === '.js' && !ALLOWED_JS_FILES.has(file.relativePath)) {
            fail(`Forbidden Core JavaScript source file: plugins/core/${file.relativePath}`)
        }
    }

    const indexJsc = path.join(CORE_DIR, 'index.jsc')
    if (!fs.existsSync(indexJsc)) {
        fail('plugins/core/index.jsc is missing')
        return
    }

    const actualHash = sha256(indexJsc)
    const officialCore = readJson(OFFICIAL_CORE_PATH)
    const corePackage = readJson(path.join(CORE_DIR, 'package.json'))
    const catalog = readJson(CATALOG_PATH)
    const catalogCore = Array.isArray(catalog.plugins) ? catalog.plugins.find(plugin => plugin.name === 'core') : null

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

    if (!process.exitCode) {
        console.log('[CORE-RELEASE-CHECK] Core release artifact check passed.')
    }
}

main()
