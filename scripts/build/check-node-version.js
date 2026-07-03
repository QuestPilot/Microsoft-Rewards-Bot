const REQUIRED_VERSION = '24.15.0'

function normalizeVersion(version) {
    return String(version).replace(/^v/, '').trim()
}

function fail(message) {
    console.error('')
    console.error('Microsoft Rewards Bot cannot start.')
    console.error('')
    console.error(message)
    console.error('')
    console.error(`Required Node.js: ${REQUIRED_VERSION}`)
    console.error(`Current Node.js:  ${process.version}`)
    console.error('')
    console.error(`Install Node.js ${REQUIRED_VERSION}, then run:`)
    console.error('  npm install')
    console.error('  npm start')
    console.error('')
    console.error('Why this is strict:')
    console.error('  The official Core plugin is shipped as V8 bytecode.')
    console.error('  Bytecode must run on the same Node.js/V8 major version it was built for.')
    console.error('')
    process.exit(1)
}

const currentVersion = normalizeVersion(process.version)

if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
    fail('Unable to detect your Node.js version.')
}

if (currentVersion !== REQUIRED_VERSION) {
    fail(`Unsupported Node.js version ${currentVersion}.`)
}

console.log(`Node.js check passed: ${process.version}`)
