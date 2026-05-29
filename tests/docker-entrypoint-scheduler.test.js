const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('docker entrypoint lets the built-in scheduler run without CRON_SCHEDULE', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'scripts/docker/entrypoint.sh'), 'utf8')

    assert.match(entrypoint, /scheduler\.enabled===true/)
    assert.match(entrypoint, /exec node dist\/index\.js/)
    assert.match(entrypoint, /or enable scheduler\.enabled in dist\/config\.json/)

    const schedulerBranch = entrypoint.indexOf('scheduler.enabled===true')
    const cronValidation = entrypoint.indexOf('if [ -z "${CRON_SCHEDULE:-}" ]')
    assert.ok(schedulerBranch !== -1 && schedulerBranch < cronValidation)
})
