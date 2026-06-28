'use strict'

// Signs the marketplace catalog (plugins/marketplace.json) with the MARKETPLACE
// Ed25519 private key, producing plugins/marketplace.sig. This runs server-side
// (core-api / a maintainer machine) — the private key must NEVER ship to clients.
// Mirrors scripts/sign-core-manifest.js: signs the exact LF-normalized bytes.
//
//   MSRB_MARKETPLACE_PRIVATE_KEY=<pem>            node scripts/sign-marketplace-catalog.js
//   MSRB_MARKETPLACE_PRIVATE_KEY_PATH=key.pem     node scripts/sign-marketplace-catalog.js [in.json] [out.sig]

const fs = require('fs')
const path = require('path')
const { signBytes } = require('../security/SignedManifest')

const root = path.resolve(__dirname, '..', '..')
const catalogPath = path.resolve(process.argv[2] || path.join(root, 'plugins', 'marketplace.json'))
const outputPath = path.resolve(process.argv[3] || path.join(root, 'plugins', 'marketplace.sig'))
const privateKeyPath = process.env.MSRB_MARKETPLACE_PRIVATE_KEY_PATH
const privateKey =
    process.env.MSRB_MARKETPLACE_PRIVATE_KEY || (privateKeyPath ? fs.readFileSync(path.resolve(privateKeyPath), 'utf8') : '')

if (!privateKey) {
    throw new Error('MSRB_MARKETPLACE_PRIVATE_KEY or MSRB_MARKETPLACE_PRIVATE_KEY_PATH is required')
}

const payload = fs.readFileSync(catalogPath, 'utf8').replace(/\r\n?/g, '\n')
fs.writeFileSync(catalogPath, payload, 'utf8')
const signature = signBytes(Buffer.from(payload, 'utf8'), privateKey)
fs.writeFileSync(outputPath, `${signature}\n`)
console.log(`[MARKETPLACE-SIGN] Signed ${catalogPath} -> ${outputPath}`)
