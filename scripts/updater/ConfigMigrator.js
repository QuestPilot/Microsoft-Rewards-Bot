const fs = require('fs')
const path = require('path')

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeMissing(target, defaults) {
    if (Array.isArray(defaults)) {
        return Array.isArray(target) ? target : defaults
    }

    if (!isPlainObject(defaults)) {
        return target === undefined ? defaults : target
    }

    const result = isPlainObject(target) ? { ...target } : {}
    for (const [key, defaultValue] of Object.entries(defaults)) {
        if (result[key] === undefined) {
            result[key] = defaultValue
        } else if (isPlainObject(result[key]) && isPlainObject(defaultValue)) {
            result[key] = mergeMissing(result[key], defaultValue)
        }
    }
    return result
}

function removePath(target, dottedPath) {
    if (!isPlainObject(target)) return false
    const parts = dottedPath.split('.')
    let current = target
    for (const part of parts.slice(0, -1)) {
        if (!isPlainObject(current[part])) return false
        current = current[part]
    }
    const leaf = parts[parts.length - 1]
    if (!Object.hasOwn(current, leaf)) return false
    delete current[leaf]
    return true
}

const DEPRECATED_CONFIG_PATHS = [
    'dashboard'
]

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`, 'utf8')
}

function migrateConfig(root, logger = console) {
    const userPath = path.join(root, 'src', 'config.json')
    const examplePath = path.join(root, 'src', 'config.example.json')

    if (!fs.existsSync(userPath) || !fs.existsSync(examplePath)) {
        return { changed: false, reason: 'missing config or example' }
    }

    const userConfig = readJson(userPath)
    const defaultConfig = readJson(examplePath)
    const migrated = mergeMissing(userConfig, defaultConfig)
    const removed = DEPRECATED_CONFIG_PATHS.filter(configPath => removePath(migrated, configPath))
    const changed = JSON.stringify(migrated) !== JSON.stringify(userConfig)

    if (changed) {
        writeJson(userPath, migrated)
        logger.log(
            removed.length > 0
                ? `[UPDATER] Migrated src/config.json and removed deprecated keys: ${removed.join(', ')}`
                : '[UPDATER] Migrated src/config.json with new default keys'
        )
    }

    return { changed }
}

function migrateAccount(account, defaultAccount) {
    const merged = mergeMissing(account, defaultAccount)

    if (isPlainObject(account.proxy) && isPlainObject(defaultAccount.proxy)) {
        merged.proxy = mergeMissing(account.proxy, defaultAccount.proxy)
    }
    if (isPlainObject(account.saveFingerprint) && isPlainObject(defaultAccount.saveFingerprint)) {
        merged.saveFingerprint = mergeMissing(account.saveFingerprint, defaultAccount.saveFingerprint)
    }

    return merged
}

function migrateAccounts(root, logger = console) {
    const userPath = path.join(root, 'src', 'accounts.json')
    const examplePath = path.join(root, 'src', 'accounts.example.json')

    if (!fs.existsSync(userPath) || !fs.existsSync(examplePath)) {
        return { changed: false, reason: 'missing accounts or example' }
    }

    const accounts = readJson(userPath)
    const examples = readJson(examplePath)
    if (!Array.isArray(accounts) || !Array.isArray(examples) || !examples[0]) {
        return { changed: false, reason: 'invalid account shape' }
    }

    const migrated = accounts.map(account => migrateAccount(account, examples[0]))
    const changed = JSON.stringify(migrated) !== JSON.stringify(accounts)

    if (changed) {
        writeJson(userPath, migrated)
        logger.log('[UPDATER] Migrated src/accounts.json with new default keys')
    }

    return { changed }
}

function migrateUserFiles(root, logger = console) {
    const results = {
        config: migrateConfig(root, logger),
        accounts: migrateAccounts(root, logger)
    }
    return results
}

module.exports = {
    mergeMissing,
    migrateAccounts,
    migrateConfig,
    migrateUserFiles
}
