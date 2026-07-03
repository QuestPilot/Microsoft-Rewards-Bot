'use strict'

const fs = require('fs')
const path = require('path')
const { signBytes } = require('../security/SignedManifest')

const root = path.resolve(__dirname, '..', '..')
const manifestPath = path.resolve(process.argv[2] || path.join(root, 'plugins', 'official-core.json'))
const outputPath = path.resolve(process.argv[3] || path.join(root, 'plugins', 'official-core.sig'))
const privateKeyPath = process.env.MSRB_CORE_PRIVATE_KEY_PATH
const privateKey = process.env.MSRB_CORE_PRIVATE_KEY
    || (privateKeyPath ? fs.readFileSync(path.resolve(privateKeyPath), 'utf8') : '')

if (!privateKey) {
    throw new Error('MSRB_CORE_PRIVATE_KEY or MSRB_CORE_PRIVATE_KEY_PATH is required')
}

const manifestPayload = fs.readFileSync(manifestPath, 'utf8').replace(/\r\n?/g, '\n')
fs.writeFileSync(manifestPath, manifestPayload, 'utf8')
const signature = signBytes(Buffer.from(manifestPayload, 'utf8'), privateKey)
fs.writeFileSync(outputPath, `${signature}\n`)
console.log(`[CORE-SIGN] Signed ${manifestPath}`)
