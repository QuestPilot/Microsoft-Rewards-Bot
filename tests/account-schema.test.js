const assert = require('node:assert/strict')
const test = require('node:test')

require('ts-node/register/transpile-only')
const { validateAccounts } = require('../src/helpers/SchemaValidator.ts')

function account(totpSecret) {
    return {
        email: 'user@example.com',
        password: 'password',
        ...(totpSecret !== undefined && { totpSecret }),
        recoveryEmail: '',
        geoLocale: 'auto',
        langCode: 'en',
        proxy: {
            proxyAxios: false,
            url: '',
            port: 0,
            password: '',
            username: ''
        },
        saveFingerprint: {
            mobile: false,
            desktop: false
        }
    }
}

test('blank and invisible TOTP values are treated as absent', () => {
    const [blank, invisible] = validateAccounts([account(''), account(' \u200B\uFEFF ')])

    assert.equal(blank.totpSecret, undefined)
    assert.equal(invisible.totpSecret, undefined)
})

test('TOTP values are normalized before use', () => {
    const [normalized] = validateAccounts([account('jbsw y3dp ehpk 3pxp====')])

    assert.equal(normalized.totpSecret, 'JBSWY3DPEHPK3PXP')
})

test('non-empty invalid TOTP values are rejected', () => {
    assert.throws(() => validateAccounts([account('not-a-valid-secret')]), /totpSecret appears invalid/)
})
