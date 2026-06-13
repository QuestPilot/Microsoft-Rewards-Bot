'use strict'

const crypto = require('crypto')
const fs = require('fs')

function readPublicKey(filePath) {
    const key = fs.readFileSync(filePath, 'utf8')
    const parsed = crypto.createPublicKey(key)
    if (parsed.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Signing key must be Ed25519: ${filePath}`)
    }
    return key
}

function verifySignedBytes(payload, signatureBase64, publicKey) {
    const signatureText = String(signatureBase64 || '').trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) {
        throw new Error('Manifest signature is not valid base64')
    }
    const signature = Buffer.from(signatureText, 'base64')
    if (signature.length !== 64 || !crypto.verify(null, payload, publicKey, signature)) {
        throw new Error('Manifest signature verification failed')
    }
}

function signBytes(payload, privateKey) {
    const parsed = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey)
    if (parsed.asymmetricKeyType !== 'ed25519') {
        throw new Error('Signing key must be Ed25519')
    }
    return crypto.sign(null, payload, parsed).toString('base64')
}

module.exports = {
    readPublicKey,
    signBytes,
    verifySignedBytes
}
