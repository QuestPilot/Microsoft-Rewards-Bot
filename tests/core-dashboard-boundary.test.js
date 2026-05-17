const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('open-source runtime does not ship the local dashboard server', () => {
    assert.equal(fs.existsSync(path.join(root, 'src/core/DashboardServer.ts')), false)
    assert.doesNotMatch(read('src/index.ts'), /DashboardServer|startDashboard|stopDashboard/)
})

test('public config no longer exposes dashboard host or write controls', () => {
    const config = JSON.parse(read('src/config.example.json'))
    assert.equal(Object.hasOwn(config, 'dashboard'), false)
    assert.doesNotMatch(read('src/helpers/SchemaValidator.ts'), /allowConfigWrite|openOnStart|0\.0\.0\.0/)
})

test('public docs describe dashboard as Core-only', () => {
    const docs = read('docs/dashboard.md')
    assert.match(docs, /official Core feature/i)
    assert.match(docs, /Local HTTP dashboard \| No \| No/)
    assert.doesNotMatch(read('README.md'), /local dashboard/i)
})
