const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const RunHealthPlugin = require('../plugins/run-health')
const SessionHealthPlugin = require('../plugins/session-health')

function context(config = {}) {
    let diagnostics
    return {
        value: {
            apiVersion: '1.0.0',
            config,
            log: {
                info() {},
                warn() {},
                error() {},
                debug() {}
            },
            registerSelectors() {},
            registerNotificationSink() {},
            registerDiagnostics(provider) {
                diagnostics = provider
            }
        },
        diagnostics: () => diagnostics
    }
}

test('run-health records masked account outcomes and reports diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-run-health-'))
    try {
        const plugin = new RunHealthPlugin()
        const fixture = context({ outputDir: path.join(root, 'health'), historyLimit: 10 })
        plugin.register(fixture.value)
        await plugin.onAccountEnd({
            result: {
                email: 'person@example.com',
                initialPoints: 100,
                finalPoints: 100,
                collectedPoints: 0,
                duration: 12,
                success: true
            }
        })

        const saved = fs.readFileSync(path.join(root, 'health', 'history.json'), 'utf8')
        assert.doesNotMatch(saved, /person@example\.com/)
        assert.match(saved, /pe\*\*\*@example\.com/)
        const diagnostics = await fixture.diagnostics()()
        assert.equal(diagnostics[0].details.zeroPointRuns, 1)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('session-health reports empty and stale official session directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-session-health-'))
    try {
        const emptySession = path.join(root, 'sessions', 'empty-account')
        const staleSession = path.join(root, 'sessions', 'stale-account')
        fs.mkdirSync(emptySession, { recursive: true })
        fs.mkdirSync(staleSession, { recursive: true })
        const staleFile = path.join(staleSession, 'cookies.json')
        fs.writeFileSync(staleFile, '[]')
        const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        fs.utimesSync(staleFile, old, old)

        const plugin = new SessionHealthPlugin()
        const fixture = context({ sessionPath: path.join(root, 'sessions'), staleDays: 30 })
        plugin.register(fixture.value)
        const diagnostics = await fixture.diagnostics()()

        assert.equal(diagnostics[0].level, 'warn')
        assert.equal(diagnostics[0].details.emptySessions, 1)
        assert.equal(diagnostics[0].details.staleSessions, 1)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})
