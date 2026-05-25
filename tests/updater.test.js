const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { migrateUserFiles } = require('../scripts/updater/ConfigMigrator')
const {
    DEFAULT_BACKUP_PATHS,
    DEFAULT_EXCLUDES,
    DEFAULT_MANAGED_PATHS,
    DEFAULT_OBSOLETE_PATHS,
    UpdateManager
} = require('../scripts/updater/UpdateManager')

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

test('updater does not skip Docker during preflight checks', () => {
    const updater = new UpdateManager({ root: process.cwd(), logger: { log() {}, warn() {} } })
    updater.isDocker = () => true

    assert.equal(updater.shouldSkip(['node'], {}).skip, false)
    assert.equal(updater.shouldSkip(['node'], { MSRB_UPDATE_CHECK_ONLY: '1' }).skip, false)
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

test('updater reports current when release branch version is not newer', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    updater.fetchRemoteRelease = async () => ({
        version: '2.0.0',
        commitSha: 'abc123456789',
        branch: 'release',
        repo: 'QuestPilot/Microsoft-Rewards-Bot',
        packageJson: { version: '2.0.0' },
        archiveUrl: 'https://example.test/archive.tgz',
        checkedAt: new Date().toISOString()
    })

    const result = await updater.run()

    assert.equal(result.status, 'current')
})

test('Docker never mutates local files and only reports update availability', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    updater.isDocker = () => true
    updater.fetchRemoteRelease = async () => ({
        version: '2.0.0',
        commitSha: 'abc123456789',
        branch: 'release',
        repo: 'QuestPilot/Microsoft-Rewards-Bot',
        packageJson: { version: '2.0.0' },
        archiveUrl: 'https://example.test/archive.tgz',
        checkedAt: new Date().toISOString()
    })
    updater.applyRelease = async () => {
        throw new Error('applyRelease must not run in Docker')
    }

    const result = await updater.run()

    assert.equal(result.status, 'update-available')
    assert.equal(result.docker, true)
})

test('check-only reports update availability without applying', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    updater.fetchRemoteRelease = async () => ({
        version: '2.0.0',
        commitSha: 'abc123456789',
        branch: 'release',
        repo: 'QuestPilot/Microsoft-Rewards-Bot',
        packageJson: { version: '2.0.0' },
        archiveUrl: 'https://example.test/archive.tgz',
        checkedAt: new Date().toISOString()
    })
    updater.applyRelease = async () => {
        throw new Error('applyRelease must not run in check-only mode')
    }

    const result = await updater.run({ env: { MSRB_UPDATE_CHECK_ONLY: '1' } })

    assert.equal(result.status, 'update-available')
    assert.equal(result.checkOnly, true)
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

test('updater knows old local dashboard source is obsolete', () => {
    assert.ok(DEFAULT_OBSOLETE_PATHS.includes('src/core/DashboardServer.ts'))
    assert.ok(DEFAULT_MANAGED_PATHS.includes('src'))
    assert.ok(DEFAULT_MANAGED_PATHS.includes('plugins/core'))
})

test('updater skips root repository tooling files at runtime', () => {
    assert.ok(DEFAULT_EXCLUDES.includes('.github'))
    assert.ok(DEFAULT_EXCLUDES.includes('.dockerignore'))
    assert.ok(DEFAULT_EXCLUDES.includes('.eslintrc.js'))
    assert.ok(DEFAULT_EXCLUDES.includes('.gitattributes'))
    assert.ok(DEFAULT_EXCLUDES.includes('.gitignore'))
    assert.ok(DEFAULT_EXCLUDES.includes('.node-version'))
    assert.ok(DEFAULT_EXCLUDES.includes('.nvmrc'))
    assert.ok(DEFAULT_EXCLUDES.includes('.prettierrc'))
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

    assert.deepEqual(capturedArgs, ['ci'])
})

test('GitHub tarball download uses the GitHub API accept header', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'updater', 'UpdateManager.js'), 'utf8')
    assert.match(source, /archiveUrl: this\.githubApiUrl\(`\/repos\/\$\{this\.repo\}\/tarball\/\$\{commitSha\}`\)/)
    assert.match(source, /accept: 'application\/vnd\.github\+json'/)
    assert.doesNotMatch(source, /downloadArchive[\s\S]+accept: 'application\/octet-stream'/)
})

test('applying release preserves user files and removes obsolete managed files', () => {
    const root = tempRoot()
    const source = tempRoot()
    const backup = path.join(root, '.updates', 'backup')

    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
    fs.mkdirSync(path.join(source, 'src'), { recursive: true })
    fs.mkdirSync(path.join(source, 'plugins'), { recursive: true })

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    fs.writeFileSync(path.join(root, 'src', 'config.json'), '{"user":true}')
    fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'old')
    fs.writeFileSync(path.join(root, 'plugins', 'plugins.jsonc'), '{"core":{"enabled":true}}')
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sessions', 'keep.txt'), 'session')

    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    fs.writeFileSync(path.join(source, 'src', 'new.ts'), 'new')
    fs.writeFileSync(path.join(source, 'src', 'config.example.json'), '{}')
    fs.writeFileSync(path.join(source, 'plugins', 'catalog.json'), '{"plugins":[]}')

    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    updater.applyFromSourceRoot(source, backup)

    assert.equal(fs.readFileSync(path.join(root, 'src', 'config.json'), 'utf8'), '{"user":true}')
    assert.equal(fs.readFileSync(path.join(root, 'plugins', 'plugins.jsonc'), 'utf8'), '{"core":{"enabled":true}}')
    assert.equal(fs.readFileSync(path.join(root, 'sessions', 'keep.txt'), 'utf8'), 'session')
    assert.equal(fs.existsSync(path.join(root, 'src', 'old.ts')), false)
    assert.equal(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8'), 'new')
})

test('failed release apply restores backed up user files', () => {
    const root = tempRoot()
    const source = tempRoot()
    const backup = path.join(root, '.updates', 'backup')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(source, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    fs.writeFileSync(path.join(root, 'src', 'config.json'), '{"user":true}')
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '2.0.0' }))

    const updater = new UpdateManager({ root, logger: { log() {}, warn() {} } })
    updater.backupMutablePaths(backup)
    fs.writeFileSync(path.join(root, 'src', 'config.json'), '{"broken":true}')
    updater.restoreBackup(backup)

    assert.equal(fs.readFileSync(path.join(root, 'src', 'config.json'), 'utf8'), '{"user":true}')
})
