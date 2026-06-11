const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const FORMAT = 'msrb-accounts'
const FORMAT_VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12
const SCRYPT_KEY_BYTES = 32
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function atomicWrite(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
    )
    let fd
    try {
        fd = fs.openSync(tempPath, 'wx', 0o600)
        fs.writeFileSync(fd, data, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(tempPath, filePath)
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(tempPath, { force: true })
    }
}

function parseAccounts(raw, label) {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error(`${label} must contain a JSON array`)
    return value
}

function encryptPayload(value, key, extra = {}) {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
        format: FORMAT,
        version: FORMAT_VERSION,
        algorithm: 'aes-256-gcm',
        ...extra,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    }
}

function decryptPayload(container, key) {
    if (
        !container ||
        container.format !== FORMAT ||
        container.version !== FORMAT_VERSION ||
        container.algorithm !== 'aes-256-gcm'
    ) {
        throw new Error('Unsupported encrypted accounts format')
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(container.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(container.tag, 'base64'))
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(container.ciphertext, 'base64')),
        decipher.final()
    ]).toString('utf8')
    return parseAccounts(plaintext, 'Encrypted accounts')
}

function powershellExecutable(env = process.env) {
    return env.ComSpec ? 'powershell.exe' : 'powershell'
}

function createSystemVault(options = {}) {
    const platform = options.platform || process.platform
    const env = options.env || process.env
    const execFileSync = options.execFileSync || childProcess.execFileSync
    const home = options.home || os.homedir()
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const vaultDir = path.join(appData, '.msrb')
    const dpapiFile = path.join(vaultDir, 'accounts-key.dpapi')
    const service = 'Microsoft-Rewards-Bot'
    const account = crypto.createHash('sha256').update(path.resolve(options.root || process.cwd())).digest('hex')

    function run(command, args, input, extraEnv = {}) {
        return String(
            execFileSync(command, args, {
                encoding: 'utf8',
                env: { ...env, ...extraEnv },
                input,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            })
        ).trim()
    }

    if (platform === 'win32') {
        return {
            name: 'Windows DPAPI CurrentUser',
            available() {
                try {
                    run(
                        powershellExecutable(env),
                        ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security;[Security.Cryptography.ProtectedData]::Protect([byte[]](1),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)|Out-Null']
                    )
                    return true
                } catch {
                    return false
                }
            },
            load() {
                if (!fs.existsSync(dpapiFile)) return null
                const script =
                    'Add-Type -AssemblyName System.Security;' +
                    '$b=[IO.File]::ReadAllBytes($env:MSRB_DPAPI_FILE);' +
                    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
                    '[Convert]::ToBase64String($p)'
                const output = run(
                    powershellExecutable(env),
                    ['-NoProfile', '-NonInteractive', '-Command', script],
                    undefined,
                    { MSRB_DPAPI_FILE: dpapiFile }
                )
                return Buffer.from(output, 'base64')
            },
            save(key) {
                fs.mkdirSync(vaultDir, { recursive: true })
                const script =
                    'Add-Type -AssemblyName System.Security;' +
                    '$p=[Convert]::FromBase64String($env:MSRB_DPAPI_KEY);' +
                    '$b=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
                    '[IO.File]::WriteAllBytes($env:MSRB_DPAPI_FILE,$b)'
                run(
                    powershellExecutable(env),
                    ['-NoProfile', '-NonInteractive', '-Command', script],
                    undefined,
                    {
                        MSRB_DPAPI_FILE: dpapiFile,
                        MSRB_DPAPI_KEY: key.toString('base64')
                    }
                )
            }
        }
    }

    if (platform === 'darwin') {
        return {
            name: 'macOS Keychain',
            available() {
                try {
                    run('security', ['help'])
                    return true
                } catch {
                    return false
                }
            },
            load() {
                try {
                    return Buffer.from(run('security', ['find-generic-password', '-s', service, '-a', account, '-w']), 'base64')
                } catch {
                    return null
                }
            },
            save(key) {
                run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', key.toString('base64')])
            }
        }
    }

    return {
        name: 'Linux Secret Service',
        available() {
            try {
                run('secret-tool', ['--version'])
                return true
            } catch {
                return false
            }
        },
        load() {
            try {
                const value = run('secret-tool', ['lookup', 'service', service, 'account', account])
                return value ? Buffer.from(value, 'base64') : null
            } catch {
                return null
            }
        },
        save(key) {
            run(
                'secret-tool',
                ['store', '--label', 'Microsoft Rewards Bot accounts key', 'service', service, 'account', account],
                key.toString('base64')
            )
        }
    }
}

function createAccountStorage(options = {}) {
    const root = path.resolve(options.root || process.cwd())
    const accountsPath = options.accountsPath || path.join(root, 'src', 'accounts.json')
    const encryptedPath = options.encryptedPath || path.join(root, 'src', 'accounts.enc.json')
    const vault = options.vault || createSystemVault({ ...options, root })
    let cachedKey = null

    function vaultStatus() {
        try {
            return { available: Boolean(vault.available()), provider: vault.name }
        } catch (error) {
            return { available: false, provider: vault.name, warning: error.message }
        }
    }

    function getKey(create) {
        if (cachedKey) return Buffer.from(cachedKey)
        if (!vault.available()) throw new Error(`${vault.name} is unavailable`)
        const existing = vault.load()
        if (existing) {
            if (existing.length !== KEY_BYTES) throw new Error('The stored accounts key has an invalid length')
            cachedKey = Buffer.from(existing)
            return Buffer.from(cachedKey)
        }
        if (!create) throw new Error('The accounts encryption key is missing from the OS vault')
        const key = crypto.randomBytes(KEY_BYTES)
        vault.save(key)
        cachedKey = Buffer.from(key)
        return Buffer.from(cachedKey)
    }

    function readEncrypted(key = getKey(false)) {
        return decryptPayload(JSON.parse(fs.readFileSync(encryptedPath, 'utf8')), key)
    }

    function readAccounts() {
        if (fs.existsSync(encryptedPath)) return readEncrypted()
        return parseAccounts(fs.readFileSync(accountsPath, 'utf8'), 'Accounts file')
    }

    function writeAccounts(accounts) {
        if (!Array.isArray(accounts)) throw new Error('Accounts must be an array')
        if (fs.existsSync(encryptedPath)) {
            const key = getKey(false)
            const packed = `${JSON.stringify(encryptPayload(accounts, key), null, 2)}\n`
            atomicWrite(encryptedPath, packed)
            readEncrypted(key)
            return
        }
        atomicWrite(accountsPath, `${JSON.stringify(accounts, null, 4)}\n`)
        parseAccounts(fs.readFileSync(accountsPath, 'utf8'), 'Accounts file')
    }

    function enableEncryption() {
        if (fs.existsSync(encryptedPath)) return status()
        const accounts = readAccounts()
        const key = getKey(true)
        atomicWrite(encryptedPath, `${JSON.stringify(encryptPayload(accounts, key), null, 2)}\n`)
        readEncrypted(key)
        fs.rmSync(accountsPath, { force: true })
        return status()
    }

    function disableEncryption() {
        if (!fs.existsSync(encryptedPath)) return status()
        const accounts = readEncrypted()
        atomicWrite(accountsPath, `${JSON.stringify(accounts, null, 4)}\n`)
        parseAccounts(fs.readFileSync(accountsPath, 'utf8'), 'Accounts file')
        fs.rmSync(encryptedPath, { force: true })
        cachedKey = null
        return status()
    }

    function initializeEncryption() {
        const current = status()
        if (current.encrypted) return current
        if (!current.vaultAvailable) {
            return { ...current, warning: `${current.provider} is unavailable; accounts remain plaintext.` }
        }
        return enableEncryption()
    }

    function rotateKey() {
        if (!fs.existsSync(encryptedPath)) throw new Error('Account encryption is not enabled')
        const oldKey = getKey(false)
        const accounts = readEncrypted(oldKey)
        const newKey = crypto.randomBytes(KEY_BYTES)
        const next = `${JSON.stringify(encryptPayload(accounts, newKey), null, 2)}\n`
        const tempPath = `${encryptedPath}.rotation`
        atomicWrite(tempPath, next)
        decryptPayload(JSON.parse(fs.readFileSync(tempPath, 'utf8')), newKey)
        try {
            vault.save(newKey)
            cachedKey = Buffer.from(newKey)
            fs.renameSync(tempPath, encryptedPath)
        } catch (error) {
            try { vault.save(oldKey) } catch {}
            cachedKey = Buffer.from(oldKey)
            fs.rmSync(tempPath, { force: true })
            throw error
        }
        return status()
    }

    function exportBackup(destination, password) {
        if (typeof password !== 'string' || password.length < 12) {
            throw new Error('Backup password must contain at least 12 characters')
        }
        const salt = crypto.randomBytes(16)
        const key = crypto.scryptSync(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS)
        const container = encryptPayload(readAccounts(), key, {
            portable: true,
            kdf: 'scrypt',
            salt: salt.toString('base64'),
            scrypt: { N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p }
        })
        atomicWrite(path.resolve(destination), `${JSON.stringify(container, null, 2)}\n`)
        return path.resolve(destination)
    }

    function importBackup(source, password) {
        const container = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'))
        if (!container.portable || container.kdf !== 'scrypt') throw new Error('Not a portable MSRB accounts backup')
        const params = container.scrypt || {}
        const key = crypto.scryptSync(password, Buffer.from(container.salt, 'base64'), SCRYPT_KEY_BYTES, {
            N: params.N,
            r: params.r,
            p: params.p,
            maxmem: SCRYPT_OPTIONS.maxmem
        })
        const accounts = decryptPayload(container, key)
        writeAccounts(accounts)
        return accounts.length
    }

    function status() {
        const vaultInfo = vaultStatus()
        return {
            encrypted: fs.existsSync(encryptedPath),
            plaintext: fs.existsSync(accountsPath),
            vaultAvailable: vaultInfo.available,
            provider: vaultInfo.provider,
            warning: vaultInfo.warning || null
        }
    }

    return {
        accountsPath,
        encryptedPath,
        disableEncryption,
        enableEncryption,
        exportBackup,
        importBackup,
        initializeEncryption,
        readAccounts,
        rotateKey,
        status,
        writeAccounts
    }
}

module.exports = {
    createAccountStorage,
    createSystemVault,
    decryptPayload,
    encryptPayload
}
