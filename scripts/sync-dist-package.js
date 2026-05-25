const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const packageTarget = path.join(root, 'node_modules', 'microsoft-rewards-bot')

fs.rmSync(packageTarget, { recursive: true, force: true })
fs.cpSync(dist, packageTarget, { recursive: true })
fs.copyFileSync(path.join(root, 'package.json'), path.join(packageTarget, 'package.json'))

console.log('Copied dist/ and package.json to node_modules/microsoft-rewards-bot/')
