const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const dist = path.join(root, 'dist')
const packageTarget = path.join(root, 'node_modules', 'microsoft-rewards-bot')

// Refresh the self-package so `import 'microsoft-rewards-bot'` resolves to the
// freshly built dist/. The committed/published release artifact is dist/ itself —
// this node_modules copy is only a runtime convenience. On Windows a running bot
// instance (or the dashboard background agent) keeps the compiled .js files open,
// which makes rmSync/cpSync fail with EPERM/EBUSY. In that case we must NOT fail
// the build: dist/ is already built and is what gets released.
try {
    fs.rmSync(packageTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.cpSync(dist, packageTarget, { recursive: true })
    fs.copyFileSync(path.join(root, 'package.json'), path.join(packageTarget, 'package.json'))
    console.log('Copied dist/ and package.json to node_modules/microsoft-rewards-bot/')
} catch (err) {
    const locked = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY')
    if (locked) {
        console.warn(
            `[sync-dist-package] Self-package is locked (${err.code}) — likely a running bot/dashboard ` +
                'instance. Skipping node_modules refresh; dist/ is built and is the release artifact.'
        )
        process.exit(0)
    }
    throw err
}
