const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { migrateUserFiles } = require('../scripts/updater/ConfigMigrator')
const { DEFAULT_BACKUP_PATHS, UpdateManager } = require('../scripts/updater/UpdateManager')

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-updater-'))
}

test('updater skips dev mode and explicit opt-out', () => {
    const updater = new UpdateManager({ root: process.cwd(), logger: { log() {}, warn() {} } })

    assert.equal(updater.shouldSkip(['node', 'src/index.ts', '-dev'], {}).skip, true)
    assert.equal(updater.shouldSkip(['node', 'src/index.ts'], { npm_lifecycle_event: 'dev' }).skip, true)
    assert.equal(updater.shouldSkip(['node', 'src/index.ts'], { MSRB_AUTO_UPDATE: '0' }).skip, true)
    assert.equal(updater.shouldSkip(['node', 'src/index.ts'], {}).skip, false)
})

test('updater skips Docker by default but can be explicitly enabled', () => {
    const updater = new UpdateManager({ root: process.cwd(), logger: { log() {}, warn() {} } })
    updater.isDocker = () => true

    assert.equal(updater.shouldSkip(['node'], {}).skip, true)
    assert.equal(updater.shouldSkip(['node'], { MSRB_AUTO_UPDATE_IN_DOCKER: '1' }).skip, false)
})

test('config migrator adds missing keys without replacing user values', () => {
    const root = tempRoot()
    const src = path.join(root, 'src')
    fs.mkdirSync(src, { recursive: true })

    fs.writeFileSync(
        path.join(src, 'config.example.json'),
        JSON.stringify({
            headless: false,
            workers: { doDailySet: true, doClaimPoints: true },
            nested: { added: 1 }
        })
    )
    fs.writeFileSync(
        path.join(src, 'config.json'),
        JSON.stringify({
            headless: true,
            workers: { doDailySet: false },
            dashboard: { enabled: true, port: 3000 }
        })
    )
    fs.writeFileSync(
        path.join(src, 'accounts.example.json'),
        JSON.stringify([
            {
                email: 'example',
                password: '',
                recoveryEmail: '',
                proxy: { proxyAxios: false, url: '', port: 0, username: '', password: '' },
                saveFingerprint: { mobile: false, desktop: false }
            }
        ])
    )
    fs.writeFileSync(
        path.join(src, 'accounts.json'),
        JSON.stringify([
            {
                email: 'user@example.com',
                password: 'secret',
                proxy: { url: 'http://proxy' }
            }
        ])
    )

    migrateUserFiles(root, { log() {} })

    const config = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'))
    const accounts = JSON.parse(fs.readFileSync(path.join(src, 'accounts.json'), 'utf8'))

    assert.equal(config.headless, true)
    assert.equal(config.workers.doDailySet, false)
    assert.equal(config.workers.doClaimPoints, true)
    assert.equal(config.nested.added, 1)
    assert.equal(Object.hasOwn(config, 'dashboard'), false)
    assert.equal(accounts[0].email, 'user@example.com')
    assert.equal(accounts[0].password, 'secret')
    assert.equal(accounts[0].proxy.url, 'http://proxy')
    assert.equal(accounts[0].proxy.port, 0)
    assert.equal(accounts[0].saveFingerprint.mobile, false)
})

test('local stable manifest verifies with current update policy', () => {
    const updater = new UpdateManager({ root: process.cwd(), logger: { log() {}, warn() {} } })
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'updates', 'stable.json'), 'utf8'))

    assert.doesNotThrow(() => updater.verifyManifest(manifest))
    assert.equal(updater.isNewer(manifest.botVersion), false)
})

test('updater can still enforce signed manifests when requested', () => {
    const updater = new UpdateManager({
        root: process.cwd(),
        logger: { log() {}, warn() {} },
        requireSignature: true
    })

    assert.throws(
        () =>
            updater.verifyManifest({
                schemaVersion: 1,
                channel: 'stable',
                botVersion: '4.0.1'
            }),
        /Manifest signature missing/
    )
})

test('updater backup paths never include internal updater or dependency folders', () => {
    const updater = new UpdateManager({ root: process.cwd(), logger: { log() {}, warn() {} } })
    const backupPaths = updater.getBackupPaths([
        '.git',
        '.updates',
        'node_modules',
        'dist',
        'sessions',
        'src/config.json',
        'src/accounts.json',
        'plugins/plugins.jsonc'
    ])

    assert.deepEqual(backupPaths, ['sessions', 'src/config.json', 'src/accounts.json', 'plugins/plugins.jsonc'])
    assert.equal(DEFAULT_BACKUP_PATHS.includes('.updates'), false)
    assert.equal(DEFAULT_BACKUP_PATHS.includes('.git'), false)
    assert.equal(DEFAULT_BACKUP_PATHS.includes('node_modules'), false)
    assert.equal(DEFAULT_BACKUP_PATHS.includes('dist'), false)
})

test('dependency sync chooses npm ci when package-lock is present', () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    const childProcess = require('child_process')
    const originalSpawnSync = childProcess.spawnSync
    let capturedArgs = null
    childProcess.spawnSync = (_command, args) => {
        capturedArgs = args
        return { status: 0 }
    }

    try {
        updater.syncDependencies()
    } finally {
        childProcess.spawnSync = originalSpawnSync
    }

    assert.deepEqual(capturedArgs, ['ci', '--omit=optional'])
})
