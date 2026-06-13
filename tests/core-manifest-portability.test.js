const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('official Core manifest uses portable LF bytes and has a valid signature', () => {
    const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')
    const manifest = fs.readFileSync(path.join(root, 'plugins', 'official-core.json'))
    const signature = Buffer.from(fs.readFileSync(path.join(root, 'plugins', 'official-core.sig'), 'utf8').trim(), 'base64')
    const publicKey = crypto.createPublicKey(
        fs.readFileSync(path.join(root, 'scripts', 'security', 'core-public-key.pem'), 'utf8')
    )

    assert.match(attributes, /plugins\/official-core\.json text eol=lf/)
    assert.match(attributes, /plugins\/official-core\.sig text eol=lf/)
    assert.equal(manifest.includes(Buffer.from('\r\n')), false)
    assert.equal(crypto.verify(null, manifest, publicKey, signature), true)
})
