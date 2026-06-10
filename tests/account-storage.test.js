const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createAccountStorage, createSystemVault } = require('../scripts/account-storage')

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-accounts-'))
    fs.mkdirSync(path.join(root, 'src'))
    const accounts = [{ email: 'test@example.com', password: 'secret', enabled: true }]
    fs.writeFileSync(path.join(root, 'src', 'accounts.json'), JSON.stringify(accounts))
    let key = null
    const vault = {
        name: 'Test vault',
        available: () => true,
        load: () => key,
        save: value => { key = Buffer.from(value) }
    }
    return { root, accounts, vault }
}

test('enables encryption atomically and keeps accounts editable', () => {
    const { root, accounts, vault } = fixture()
    const storage = createAccountStorage({ root, vault })

    storage.enableEncryption()
    assert.equal(fs.existsSync(storage.accountsPath), false)
    assert.equal(fs.existsSync(storage.encryptedPath), true)
    assert.deepEqual(storage.readAccounts(), accounts)

    const updated = [...accounts, { email: 'second@example.com', password: 'new' }]
    storage.writeAccounts(updated)
    assert.deepEqual(storage.readAccounts(), updated)
})

test('disables encryption by restoring verified plaintext', () => {
    const { root, accounts, vault } = fixture()
    const storage = createAccountStorage({ root, vault })
    storage.enableEncryption()
    storage.disableEncryption()

    assert.equal(fs.existsSync(storage.encryptedPath), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.accountsPath, 'utf8')), accounts)
})

test('rotates the vault key without changing account data', () => {
    const { root, accounts, vault } = fixture()
    let savedKey
    const observedVault = { ...vault, save: value => { savedKey = Buffer.from(value); vault.save(value) } }
    const storage = createAccountStorage({ root, vault: observedVault })
    storage.enableEncryption()
    const firstKey = Buffer.from(savedKey)
    storage.rotateKey()

    assert.notDeepEqual(savedKey, firstKey)
    assert.deepEqual(storage.readAccounts(), accounts)
})

test('exports and imports a password-protected portable backup', () => {
    const source = fixture()
    const sourceStorage = createAccountStorage({ root: source.root, vault: source.vault })
    sourceStorage.enableEncryption()
    const backup = path.join(source.root, 'backup.msrb-accounts')
    sourceStorage.exportBackup(backup, 'correct horse battery staple')

    const destination = fixture()
    const destinationStorage = createAccountStorage({ root: destination.root, vault: destination.vault })
    destinationStorage.enableEncryption()
    destinationStorage.importBackup(backup, 'correct horse battery staple')
    assert.deepEqual(destinationStorage.readAccounts(), source.accounts)
})

test('keeps plaintext with a warning when the OS vault is unavailable', () => {
    const { root, accounts } = fixture()
    const storage = createAccountStorage({
        root,
        vault: { name: 'Unavailable vault', available: () => false, load: () => null, save: () => {} }
    })
    const result = storage.initializeEncryption()

    assert.equal(result.encrypted, false)
    assert.match(result.warning, /remain plaintext/)
    assert.deepEqual(storage.readAccounts(), accounts)
})

test('stores and restores a key with Windows DPAPI', { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-dpapi-'))
    const appData = path.join(root, 'appdata')
    const vault = createSystemVault({
        root,
        platform: 'win32',
        home: root,
        env: { ...process.env, APPDATA: appData }
    })
    const key = Buffer.from('0123456789abcdef0123456789abcdef')

    assert.equal(vault.available(), true)
    vault.save(key)
    assert.deepEqual(vault.load(), key)

    const protectedBytes = fs.readFileSync(path.join(appData, '.msrb', 'accounts-key.dpapi'))
    assert.equal(protectedBytes.includes(key), false)
})
