const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    saveDashboardVariant,
    saveFingerprintData,
    saveSessionData,
    saveStorageState
} = require('../dist/helpers/ConfigLoader')

test('ephemeral harvester mode never writes session state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-harvester-'))
    const previous = process.env.MSRB_EPHEMERAL_RUN
    process.env.MSRB_EPHEMERAL_RUN = '1'

    try {
        await saveSessionData(root, [{ name: 'test', value: 'secret' }], 'test@example.com', true)
        await saveFingerprintData(root, 'test@example.com', true, { fingerprint: {}, headers: {} })
        await saveStorageState(root, [{ origin: 'https://example.com', localStorage: [] }], 'test@example.com', true)
        await saveDashboardVariant(root, 'test@example.com', true, 'next')

        assert.deepEqual(fs.readdirSync(root), [])
    } finally {
        if (previous === undefined) delete process.env.MSRB_EPHEMERAL_RUN
        else process.env.MSRB_EPHEMERAL_RUN = previous
        fs.rmSync(root, { recursive: true, force: true })
    }
})
