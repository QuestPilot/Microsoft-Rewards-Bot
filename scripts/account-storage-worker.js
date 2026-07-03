const os = require('os')
const path = require('path')
const readline = require('readline')
const { createAccountStorage } = require('./account-storage')

const ROOT = path.resolve(__dirname, '..')
const storage = createAccountStorage({ root: ROOT })

function maskEmail(email) {
    const [name, domain] = String(email).split('@')
    if (!domain) return email
    const visible = name.length <= 2 ? name : `${name.slice(0, 2)}${'*'.repeat(Math.min(5, name.length - 2))}`
    return `${visible}@${domain}`
}

function maskedAccounts(accounts) {
    return accounts.map((account, index) => ({
        id: index + 1,
        email: maskEmail(account.email || `Account ${index + 1}`),
        enabled: account.enabled !== false,
        status: account.enabled === false ? 'Disabled' : 'Ready'
    }))
}

function send(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function execute(action, payload = {}) {
    if (action === 'read') return { accounts: storage.readAccounts() }
    if (action === 'write') {
        storage.writeAccounts(payload.accounts)
        const accounts = storage.readAccounts()
        return { accounts, masked: maskedAccounts(accounts) }
    }
    if (action === 'status') return storage.status()
    if (action === 'enable') return storage.enableEncryption()
    if (action === 'disable') {
        if (String(payload.confirmation || '') !== os.userInfo().username) {
            throw new Error('Local-user confirmation did not match')
        }
        return storage.disableEncryption()
    }
    if (action === 'rotate') return storage.rotateKey()
    if (action === 'export') {
        const destination = payload.destination
            ? path.resolve(String(payload.destination))
            : path.join(os.homedir(), `MSRB-accounts-${new Date().toISOString().slice(0, 10)}.msrb-accounts`)
        return { path: storage.exportBackup(destination, String(payload.password || '')) }
    }
    if (action === 'import') {
        const count = storage.importBackup(String(payload.source || ''), String(payload.password || ''))
        const accounts = storage.readAccounts()
        return { count, accounts, masked: maskedAccounts(accounts) }
    }
    throw new Error('Unknown account storage action')
}

try {
    const storageState = storage.initializeEncryption()
    const accounts = storage.readAccounts()
    // SECURITY: do NOT emit plaintext `rawAccounts` in the unsolicited startup
    // message. The consumer requests them explicitly over the line protocol when
    // needed (the `read` action returns { accounts }), so decrypted credentials
    // are only ever sent on demand rather than pushed to stdout at boot.
    send({
        type: 'ready',
        success: true,
        storage: storageState,
        accounts: maskedAccounts(accounts)
    })
} catch (error) {
    send({
        type: 'ready',
        success: false,
        message: error instanceof Error ? error.message : String(error),
        accounts: []
    })
}

const input = readline.createInterface({ input: process.stdin, terminal: false })
input.on('line', line => {
    let request
    try {
        request = JSON.parse(line)
        const result = execute(request.action, request.payload)
        send({ id: request.id, success: true, result })
    } catch (error) {
        send({
            id: request?.id,
            success: false,
            message: error instanceof Error ? error.message : String(error)
        })
    }
})
