const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { checkSafetyAdvisory } = require('../../dist/core/SafetyAdvisory')

const CACHE_RELATIVE_PATH = path.join('data', 'safety-advisory-cache.json')
const CONFIG = {
    enabled: true,
    url: 'https://example.invalid/safety-advisory',
    timeout: '5sec',
    blockedBehavior: 'stop'
}

function fakeBot(config = CONFIG) {
    const logs = []
    return {
        config: { safetyAdvisory: config },
        utils: { stringToNumber: () => 50 },
        logger: {
            debug: (...args) => logs.push(['debug', args]),
            warn: (...args) => logs.push(['warn', args]),
            error: (...args) => logs.push(['error', args])
        },
        logs
    }
}

function withTempCwd(fn) {
    return async () => {
        const previousCwd = process.cwd()
        const previousFetch = global.fetch
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-safety-advisory-'))
        try {
            process.chdir(tempDir)
            await fn(tempDir)
        } finally {
            global.fetch = previousFetch
            process.chdir(previousCwd)
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    }
}

test(
    'checkSafetyAdvisory fetches, caches the result, and returns true for status ok',
    withTempCwd(async tempDir => {
        let calls = 0
        global.fetch = async () => {
            calls++
            return { ok: true, json: async () => ({ schemaVersion: 1, status: 'ok' }) }
        }

        const result = await checkSafetyAdvisory(fakeBot())
        assert.equal(result, true)
        assert.equal(calls, 1)

        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        assert.equal(fs.existsSync(cachePath), true)
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
        assert.equal(cached.advisory.status, 'ok')
        assert.equal(typeof cached.checkedAt, 'number')
    })
)

test(
    'a fresh cached advisory (< 10 min old) is reused without hitting the network',
    withTempCwd(async tempDir => {
        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(
            cachePath,
            JSON.stringify({ checkedAt: Date.now() - 60_000, advisory: { schemaVersion: 1, status: 'ok' } })
        )
        global.fetch = async () => {
            throw new Error('fetch must not be called when a fresh cache entry exists')
        }

        const result = await checkSafetyAdvisory(fakeBot())
        assert.equal(result, true)
    })
)

test(
    'a stale cached advisory (>= 10 min old) triggers a fresh network check',
    withTempCwd(async tempDir => {
        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(
            cachePath,
            JSON.stringify({
                checkedAt: Date.now() - 11 * 60_000,
                advisory: { schemaVersion: 1, status: 'blocked', message: 'stale' }
            })
        )
        let calls = 0
        global.fetch = async () => {
            calls++
            return { ok: true, json: async () => ({ schemaVersion: 1, status: 'ok' }) }
        }

        const result = await checkSafetyAdvisory(fakeBot())
        assert.equal(calls, 1, 'a stale cache entry must not suppress the network check')
        assert.equal(result, true)
    })
)

test(
    'a cached blocked advisory still applies blockedBehavior without a network call',
    withTempCwd(async tempDir => {
        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(
            cachePath,
            JSON.stringify({
                checkedAt: Date.now(),
                advisory: { schemaVersion: 1, status: 'blocked', message: 'incident in progress' }
            })
        )
        global.fetch = async () => {
            throw new Error('fetch must not be called when a fresh cache entry exists')
        }

        const bot = fakeBot({ ...CONFIG, blockedBehavior: 'stop' })
        const result = await checkSafetyAdvisory(bot)
        assert.equal(result, false)
        assert.ok(bot.logs.some(([, args]) => String(args[2]).includes('incident in progress')))
    })
)

test(
    'a failed/unreachable check is never cached and fails open',
    withTempCwd(async tempDir => {
        global.fetch = async () => {
            throw new Error('network unreachable')
        }

        const result = await checkSafetyAdvisory(fakeBot())
        assert.equal(result, true)

        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        assert.equal(fs.existsSync(cachePath), false, 'a failed check must not poison the cache')
    })
)

test(
    'a corrupt cache file is ignored in favor of a fresh network check',
    withTempCwd(async tempDir => {
        const cachePath = path.join(tempDir, CACHE_RELATIVE_PATH)
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(cachePath, '{ not valid json')
        let calls = 0
        global.fetch = async () => {
            calls++
            return { ok: true, json: async () => ({ schemaVersion: 1, status: 'ok' }) }
        }

        const result = await checkSafetyAdvisory(fakeBot())
        assert.equal(calls, 1)
        assert.equal(result, true)
    })
)
