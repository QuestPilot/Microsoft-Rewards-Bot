const { UpdateManager } = require('./UpdateManager')

const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force') || process.argv.includes('--repair')

new UpdateManager()
    .run({ dryRun, force })
    .then(result => {
        if (result.status === 'failed') process.exitCode = 1
    })
    .catch(error => {
        console.error(`[UPDATER] ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
    })
