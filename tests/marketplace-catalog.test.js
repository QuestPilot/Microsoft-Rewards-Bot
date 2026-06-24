'use strict'

// Verifies the signed marketplace catalog trust anchor (scripts/security/marketplace-catalog.js):
// signature verification, multi-key rotation, anti-rollback, freshness/TTL, and the
// revocation / kill-switch lookups. Generates real Ed25519 keypairs in-test.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { signBytes } = require('../scripts/security/SignedManifest')
const { verifyMarketplaceCatalog, findEntry, isRevoked } = require('../scripts/security/marketplace-catalog')

function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey }
}

const KEY_A = genKey()
const KEY_B = genKey()
const ISSUED = '2026-06-23T00:00:00.000Z'
const ISSUED_MS = Date.parse(ISSUED)
const TTL = 604800 // 7 days

let dir
let keysDir

before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-mkt-'))
    keysDir = path.join(dir, 'keys')
    fs.mkdirSync(keysDir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
})
after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

function baseCatalog(over = {}) {
    return {
        format: 'msrb-marketplace',
        version: 1,
        sequence: 5,
        issuedAt: ISSUED,
        ttlSeconds: TTL,
        killSwitch: false,
        plugins: [{ name: 'x', version: '1.0.0', sha256: 'abc' }],
        revoked: [],
        ...over
    }
}

function writeCatalog(catalog, signingPriv) {
    const json = JSON.stringify(catalog, null, 2)
    fs.writeFileSync(path.join(dir, 'plugins', 'marketplace.json'), json)
    fs.writeFileSync(path.join(dir, 'plugins', 'marketplace.sig'), signBytes(Buffer.from(json, 'utf8'), signingPriv) + '\n')
}

function trust(pems) {
    for (const f of fs.readdirSync(keysDir)) fs.rmSync(path.join(keysDir, f))
    pems.forEach((pem, i) => fs.writeFileSync(path.join(keysDir, `k${i}.pem`), pem))
}

function verify(extra = {}) {
    return verifyMarketplaceCatalog({ root: dir, keysDir, now: ISSUED_MS + 1000, ...extra })
}

test('verifies a correctly-signed catalog', () => {
    trust([KEY_A.pub])
    writeCatalog(baseCatalog(), KEY_A.priv)
    const r = verify()
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.sequence, 5)
    assert.equal(r.expired, false)
})

test('rejects a tampered catalog', () => {
    trust([KEY_A.pub])
    writeCatalog(baseCatalog(), KEY_A.priv)
    const file = path.join(dir, 'plugins', 'marketplace.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + ' ') // 1 byte after signing
    assert.deepEqual(verify(), { ok: false, reason: 'bad-signature' })
})

test('rejects a catalog signed by an untrusted key', () => {
    trust([KEY_B.pub])
    writeCatalog(baseCatalog(), KEY_A.priv)
    assert.deepEqual(verify(), { ok: false, reason: 'bad-signature' })
})

test('accepts any trusted key (rotation: current + next)', () => {
    trust([KEY_B.pub, KEY_A.pub])
    writeCatalog(baseCatalog(), KEY_A.priv)
    assert.equal(verify().ok, true)
})

test('rejects a rolled-back (older sequence) catalog', () => {
    trust([KEY_A.pub])
    writeCatalog(baseCatalog({ sequence: 5 }), KEY_A.priv)
    assert.deepEqual(verify({ minSequence: 6 }), { ok: false, reason: 'rollback' })
    assert.equal(verify({ minSequence: 5 }).ok, true, 'equal sequence is allowed')
    assert.equal(verify({ minSequence: 4 }).ok, true, 'newer sequence is allowed')
})

test('flags an expired catalog (past issuedAt + ttl) but still verifies', () => {
    trust([KEY_A.pub])
    writeCatalog(baseCatalog(), KEY_A.priv)
    const r = verify({ now: ISSUED_MS + TTL * 1000 + 1 })
    assert.equal(r.ok, true)
    assert.equal(r.expired, true, 'caller decides offline/stale policy via this flag')
})

test('reports absent when catalog or signature is missing', () => {
    trust([KEY_A.pub])
    for (const f of ['marketplace.json', 'marketplace.sig']) {
        try { fs.rmSync(path.join(dir, 'plugins', f)) } catch {}
    }
    assert.deepEqual(verify(), { ok: false, reason: 'absent' })
})

test('fails closed when no trusted keys are present', () => {
    trust([])
    writeCatalog(baseCatalog(), KEY_A.priv)
    assert.deepEqual(verify(), { ok: false, reason: 'no-trusted-keys' })
})

test('findEntry locates by name and exact version', () => {
    const catalog = baseCatalog({ plugins: [{ name: 'x', version: '1.0.0' }, { name: 'y', version: '2.0.0' }] })
    assert.equal(findEntry(catalog, 'y').version, '2.0.0')
    assert.equal(findEntry(catalog, 'x', '1.0.0').name, 'x')
    assert.equal(findEntry(catalog, 'x', '9.9.9'), undefined)
    assert.equal(findEntry(catalog, 'nope'), undefined)
})

test('isRevoked matches by name+version, by sha256, and honors killSwitch', () => {
    const byName = baseCatalog({ revoked: [{ name: 'evil', version: '1.2.3' }] })
    assert.equal(isRevoked(byName, { name: 'evil', version: '1.2.3' }), true)
    assert.equal(isRevoked(byName, { name: 'evil', version: '9.9.9' }), false, 'version must match when pinned')
    assert.equal(isRevoked(byName, { name: 'good', version: '1.0.0' }), false)

    const byHash = baseCatalog({ revoked: [{ sha256: 'DEADbeef' }] })
    assert.equal(isRevoked(byHash, { name: 'anything', sha256: 'deadbeef' }), true, 'sha256 match is case-insensitive')

    const kill = baseCatalog({ killSwitch: true })
    assert.equal(isRevoked(kill, { name: 'whatever', version: '1.0.0' }), true, 'kill switch revokes everything')
})
