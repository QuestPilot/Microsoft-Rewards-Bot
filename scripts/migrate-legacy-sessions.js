const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return null
    }
}

function copyMissingRecursive(source, target) {
    if (!fs.existsSync(source)) return 0

    const stat = fs.statSync(source)
    if (stat.isDirectory()) {
        fs.mkdirSync(target, { recursive: true })
        let copied = 0
        for (const entry of fs.readdirSync(source)) {
            copied += copyMissingRecursive(path.join(source, entry), path.join(target, entry))
        }
        return copied
    }

    if (fs.existsSync(target)) return 0

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    return 1
}

function main() {
    const config =
        readJsonIfExists(path.join(root, 'src', 'config.json')) ||
        readJsonIfExists(path.join(root, 'dist', 'config.json')) ||
        {}
    const sessionPath = typeof config.sessionPath === 'string' && config.sessionPath.trim() ? config.sessionPath : 'sessions'
    const target = path.resolve(root, sessionPath)
    const candidates = [
        path.join(root, 'dist', 'automation', sessionPath),
        path.join(root, 'src', 'automation', sessionPath),
        path.join(root, 'dist', 'browser', sessionPath),
        path.join(root, 'src', 'browser', sessionPath)
    ]

    let total = 0
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate) || path.resolve(candidate) === target) continue
        total += copyMissingRecursive(candidate, target)
    }

    if (total > 0) {
        console.log(`[SESSIONS] Migrated ${total} legacy session file(s) to ${path.relative(root, target)}`)
    }
}

main()
