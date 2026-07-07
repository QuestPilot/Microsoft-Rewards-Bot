const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('interface mode is documented as an app window with terminal override', () => {
    const updates = read('docs/updates.md')
    const troubleshooting = read('docs/troubleshooting.md')

    assert.match(updates, /App window or terminal/i)
    assert.match(updates, /`terminal\.enabled`/)
    assert.match(updates, /MSRB_NO_APP_WINDOW=1/)
    assert.match(updates, /npm start -- --terminal/)
    assert.match(troubleshooting, /App Window Or Terminal/)
    assert.match(troubleshooting, /app window mode by default/)
    assert.match(troubleshooting, /forced-headless/)
    assert.match(troubleshooting, /developer diagnostics/)
})
