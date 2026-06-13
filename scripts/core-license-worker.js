const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

async function readInput() {
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) input += chunk
    return input ? JSON.parse(input) : {}
}

async function main() {
    const input = await readInput()
    const corePath = path.join(ROOT, 'plugins', 'core', 'index.js')
    if (!fs.existsSync(corePath)) {
        process.stdout.write(JSON.stringify({ clientReady: false, tier: 'free' }))
        return
    }

    const coreExports = require(corePath)
    if (typeof coreExports.DeskLicensingClient !== 'function') {
        process.stdout.write(JSON.stringify({ clientReady: false, tier: 'free' }))
        return
    }

    const client = new coreExports.DeskLicensingClient()
    if (input.action === 'activate') {
        process.stdout.write(JSON.stringify(await client.activate(String(input.key || ''))))
        return
    }
    if (input.action === 'deactivate') {
        process.stdout.write(JSON.stringify(await client.deactivate()))
        return
    }

    const cache = client.getCachedLicense()
    const active = Boolean(cache && (!cache.expiresAt || new Date(cache.expiresAt) > new Date()))
    process.stdout.write(
        JSON.stringify({
            clientReady: true,
            tier: active ? 'premium' : 'free',
            planType: active ? cache.planType || '' : '',
            expiresAt: active ? cache.expiresAt || null : null
        })
    )
}

main().catch(error => {
    process.stdout.write(
        JSON.stringify({
            success: false,
            clientReady: false,
            tier: 'free',
            message: error instanceof Error ? error.message : String(error)
        })
    )
    process.exitCode = 1
})
