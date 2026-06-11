const path = require('path')
const { createAccountStorage } = require('./account-storage')

const ROOT = path.resolve(__dirname, '..')

function maskEmail(email) {
    const [name, domain] = String(email).split('@')
    if (!domain) return email
    const visible = name.length <= 2 ? name : `${name.slice(0, 2)}${'*'.repeat(Math.min(5, name.length - 2))}`
    return `${visible}@${domain}`
}

try {
    const storage = createAccountStorage({ root: ROOT })
    const storageState = storage.initializeEncryption()
    const accounts = storage.readAccounts().map((account, index) => ({
        id: index + 1,
        email: maskEmail(account.email || `Account ${index + 1}`),
        enabled: account.enabled !== false,
        status: account.enabled === false ? 'Disabled' : 'Ready'
    }))
    process.stdout.write(JSON.stringify({ success: true, storage: storageState, accounts }))
} catch (error) {
    process.stdout.write(
        JSON.stringify({
            success: false,
            message: error instanceof Error ? error.message : String(error),
            accounts: []
        })
    )
    process.exitCode = 1
}
