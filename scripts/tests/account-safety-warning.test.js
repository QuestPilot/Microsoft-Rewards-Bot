const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    ACCOUNT_SAFETY_WARNING_SUPPRESSION_DAYS,
    createAccountSafetyWarningState,
    isAccountSafetyWarningSuppressed,
    readAccountSafetyWarningState,
    writeAccountSafetyWarningState,
    clearAccountSafetyWarningState
} = require('../../dist/helpers/AccountSafetyWarning')

const root = path.join(__dirname, '..', '..')

test('account safety warning threshold is documented as more than 6 accounts', () => {
    const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')

    assert.match(source, /ACCOUNT_SAFETY_WARNING_THRESHOLD/)
    assert.match(source, /more than 6 accounts/)
    assert.match(source, /show again/)
})

test('temporary suppression expires after 30 days', () => {
    const dismissedAt = new Date('2026-05-23T12:00:00.000Z')
    const state = createAccountSafetyWarningState(dismissedAt)

    assert.equal(state.mode, 'temporary')
    assert.equal(
        state.expiresAt,
        new Date(dismissedAt.getTime() + ACCOUNT_SAFETY_WARNING_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    )
    assert.equal(isAccountSafetyWarningSuppressed(state, new Date('2026-06-01T12:00:00.000Z')), true)
    assert.equal(isAccountSafetyWarningSuppressed(state, new Date('2026-07-01T12:00:00.000Z')), false)
})

test('permanent suppression never expires', () => {
    const state = createAccountSafetyWarningState(new Date('2026-05-23T12:00:00.000Z'), 'permanent')

    assert.equal(state.mode, 'permanent')
    assert.equal(Object.hasOwn(state, 'expiresAt'), false)
    assert.equal(isAccountSafetyWarningSuppressed(state, new Date('2030-01-01T00:00:00.000Z')), true)
})

test('account safety warning state round-trips through disk', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-account-warning-'))
    const stateFile = path.join(tempDir, 'account-safety-warning.json')
    const state = createAccountSafetyWarningState(new Date('2026-05-23T12:00:00.000Z'), 'permanent')

    await writeAccountSafetyWarningState(state, stateFile)

    const loaded = await readAccountSafetyWarningState(stateFile)
    assert.deepEqual(loaded, state)

    await clearAccountSafetyWarningState(stateFile)
    assert.equal(await readAccountSafetyWarningState(stateFile), null)
})
