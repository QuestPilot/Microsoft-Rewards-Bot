const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('Core documentation stays public-facing and current', () => {
    const overview = read('docs/core-plugin.md')
    const reference = read('docs/core-plugin-reference.md')
    const dashboard = read('docs/dashboard.md')

    assert.match(overview, /Official Core Plugin/)
    assert.match(overview, /Core Panel/)
    assert.match(overview, /Rewards Desk/)
    assert.match(overview, /Dashboard coupons/)
    assert.match(overview, /name and expiry/)
    assert.match(reference, /skips cards already marked `Applied`/)
    assert.match(reference, /Core remains a paid proprietary plugin/)
    assert.match(dashboard, /open the `Core Panel` channel/)
})
