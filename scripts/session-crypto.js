'use strict'

// Encryption-at-rest for browser session files (auth cookies + localStorage) under
// sessions/<email>/. These hold authenticated cookies/tokens — account-takeover
// material if read off disk by a same-OS-user attacker or a Trusted-Mode plugin.
//
// Design goals (all verified by tests/session-crypto.test.js):
//   - Uses the SAME OS-vault key as accounts.enc.json (AES-256-GCM) — "encrypt my
//     secrets at rest" then covers both accounts and sessions.
//   - Encryption is ACTIVE only when the vault already holds the machine key (i.e.
//     the user enabled account encryption). Otherwise files stay plaintext — no
//     surprise machine-binding for users who never opted in.
//   - Reads transparently handle BOTH encrypted envelopes and legacy plaintext, so
//     existing sessions keep working and migrate to encrypted on the next write.
//   - If an encrypted file can't be decrypted (missing/rotated key, tamper), the
//     read returns undefined → callers treat it as "no session" and re-login,
//     instead of crashing.
//
// NOTE: this module is the verified building block. It is intentionally NOT yet
// wired into the live session read/write path — that wiring spans the runtime
// (ConfigLoader) and several dev/diagnostic tools (some ESM, some with a different
// session-path layout) and must be done with the real login flow available to test.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

let createSystemVault
try {
    ;({ createSystemVault } = require('./account-storage'))
} catch {
    createSystemVault = null
}

const FORMAT = 'msrb-session'
const VERSION = 1
const IV_BYTES = 12
const KEY_BYTES = 32

const keyCache = new Map() // root -> Buffer | null

function loadVaultKey(root) {
    const cacheKey = root || '.'
    if (keyCache.has(cacheKey)) return keyCache.get(cacheKey)
    let key = null
    try {
        if (createSystemVault) {
            const vault = createSystemVault({ root: root || process.cwd() })
            if (vault.available()) {
                const loaded = vault.load()
                if (loaded && loaded.length === KEY_BYTES) key = loaded
            }
        }
    } catch {
        key = null
    }
    keyCache.set(cacheKey, key)
    return key
}

// `key` precedence: an explicit options.key (Buffer, or null to force plaintext)
// wins; otherwise the per-process vault key for the given root is used.
function resolveKey(options) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'key')) {
        return options.key || null
    }
    return loadVaultKey(options && options.root)
}

function atomicWriteText(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
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

function isEnvelope(parsed) {
    return Boolean(parsed) && typeof parsed === 'object' && parsed.format === FORMAT && parsed.algorithm === 'aes-256-gcm'
}

function encryptToEnvelope(value, key) {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()])
    return JSON.stringify({
        format: FORMAT,
        version: VERSION,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    })
}

/**
 * Read a session JSON file, transparently decrypting an encrypted envelope. Returns
 * the parsed value, or `undefined` if the file is missing / unparseable / cannot be
 * decrypted (caller should then treat it as "no session").
 */
function readSessionJson(filePath, options) {
    let raw
    try {
        raw = fs.readFileSync(filePath, 'utf8')
    } catch {
        return undefined
    }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch {
        return undefined
    }
    if (!isEnvelope(parsed)) return parsed // legacy plaintext
    const key = resolveKey(options)
    if (!key) return undefined // encrypted but no key available
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
        const plain = Buffer.concat([
            decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8')
        return JSON.parse(plain)
    } catch {
        return undefined
    }
}

/**
 * Write a session JSON file, encrypting at rest when a vault key is available;
 * otherwise writes plaintext (no opt-in account encryption → no session encryption).
 */
function writeSessionJson(filePath, value, options) {
    const key = resolveKey(options)
    atomicWriteText(filePath, key ? encryptToEnvelope(value, key) : JSON.stringify(value))
}

/** True when session encryption is active for the given root (vault key present). */
function isEncryptionActive(options) {
    return Boolean(resolveKey(options))
}

/** Test/diagnostics: clear the per-process vault-key cache. */
function _resetKeyCache() {
    keyCache.clear()
}

module.exports = { readSessionJson, writeSessionJson, isEncryptionActive, _resetKeyCache, FORMAT }
