'use strict'

// Verifies the session encryption-at-rest building block (scripts/session-crypto.js):
// round-trips with a key, reads legacy plaintext, stays plaintext without a key, and
// degrades gracefully (undefined, never throws) on a wrong key or tampered file.
// Uses an explicit key so it does not depend on the machine's OS vault.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readSessionJson, writeSessionJson, isEncryptionActive, FORMAT } = require('../session-crypto')

const KEY = crypto.randomBytes(32)
const OTHER_KEY = crypto.randomBytes(32)

let dir
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-sess-'))
})
after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('encrypts at rest and round-trips with the key', () => {
    const file = path.join(dir, 'session_desktop.json')
    const cookies = [{ name: 'auth', value: 'super-secret', domain: '.bing.com' }]
    writeSessionJson(file, cookies, { key: KEY })

    // On disk it must be an opaque envelope — the secret must not appear in plaintext.
    const onDisk = fs.readFileSync(file, 'utf8')
    const env = JSON.parse(onDisk)
    assert.equal(env.format, FORMAT)
    assert.ok(!onDisk.includes('super-secret'), 'cookie value must not be stored in plaintext')

    assert.deepEqual(readSessionJson(file, { key: KEY }), cookies)
})

test('reads legacy plaintext session files unchanged', () => {
    const file = path.join(dir, 'legacy.json')
    const value = [{ name: 'c', value: 'v' }]
    fs.writeFileSync(file, JSON.stringify(value))
    assert.deepEqual(readSessionJson(file, { key: KEY }), value)
})

test('writes plaintext when no key is available (no opt-in)', () => {
    const file = path.join(dir, 'plain.json')
    const value = { hello: 'world' }
    writeSessionJson(file, value, { key: null })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(onDisk, value, 'should be stored as plain JSON')
    assert.equal(isEncryptionActive({ key: null }), false)
    assert.deepEqual(readSessionJson(file, { key: null }), value)
})

test('returns undefined (re-login) when the key cannot decrypt', () => {
    const file = path.join(dir, 'wrongkey.json')
    writeSessionJson(file, [{ name: 'a', value: 'b' }], { key: KEY })
    assert.equal(readSessionJson(file, { key: OTHER_KEY }), undefined, 'wrong key must not throw — degrade to no session')
    assert.equal(readSessionJson(file, { key: null }), undefined, 'encrypted file with no key available → no session')
})

test('returns undefined on a tampered envelope without throwing', () => {
    const file = path.join(dir, 'tampered.json')
    writeSessionJson(file, [{ name: 'a', value: 'b' }], { key: KEY })
    const env = JSON.parse(fs.readFileSync(file, 'utf8'))
    env.ciphertext = Buffer.from('garbage').toString('base64')
    fs.writeFileSync(file, JSON.stringify(env))
    assert.equal(readSessionJson(file, { key: KEY }), undefined)
})

test('returns undefined for a missing file', () => {
    assert.equal(readSessionJson(path.join(dir, 'does-not-exist.json'), { key: KEY }), undefined)
})

test('isEncryptionActive reflects key availability', () => {
    assert.equal(isEncryptionActive({ key: KEY }), true)
    assert.equal(isEncryptionActive({ key: null }), false)
})
