const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..', '..')
const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
const readText = rel => fs.readFileSync(path.join(root, rel), 'utf8')

// Guards the dual-dashboard config surface so a flag added in one place but not the
// others (config.json / config.example.json / Zod schema / TS types) fails CI instead
// of silently shipping a half-wired option.

test('config.json and config.example.json expose the same core.* feature flags', () => {
    const config = readJson('src/config.json')
    const example = readJson('src/config.example.json')

    assert.ok(config.core && typeof config.core === 'object', 'config.json must have a core section')
    assert.ok(example.core && typeof example.core === 'object', 'config.example.json must have a core section')

    assert.deepEqual(
        Object.keys(config.core).sort(),
        Object.keys(example.core).sort(),
        'core.* keys must match across config.json and config.example.json'
    )
})

test('doPunchCards (dual-dashboard worker) is present in both config files, the schema, and the types', () => {
    const config = readJson('src/config.json')
    const example = readJson('src/config.example.json')
    const schema = readText('src/helpers/SchemaValidator.ts')
    const types = readText('src/types/Config.ts')

    assert.equal(Object.hasOwn(config.workers, 'doPunchCards'), true, 'config.json workers.doPunchCards')
    assert.equal(Object.hasOwn(example.workers, 'doPunchCards'), true, 'config.example.json workers.doPunchCards')
    assert.match(schema, /doPunchCards:\s*z\.boolean\(\)/, 'SchemaValidator workers.doPunchCards')
    assert.match(types, /doPunchCards:\s*boolean/, 'Config.ts ConfigWorkers.doPunchCards')
})

test('account dashboardMode override is schema-validated and typed (legacy support)', () => {
    const schema = readText('src/helpers/SchemaValidator.ts')
    const account = readText('src/types/Account.ts')

    assert.match(schema, /dashboardMode:\s*z\.enum\(\['auto', 'next', 'legacy'\]\)\.optional\(\)/)
    assert.match(account, /dashboardMode\?:\s*'auto'\s*\|\s*'next'\s*\|\s*'legacy'/)
})

test('account strictProxy override is schema-validated, typed, and wired in the Desk account editor', () => {
    const schema = readText('src/helpers/SchemaValidator.ts')
    const account = readText('src/types/Account.ts')
    const desk = readText('scripts/desk/app-window.js')

    assert.match(schema, /strictProxy:\s*z\.enum\(\['auto', 'require', 'exempt'\]\)\.optional\(\)/)
    assert.match(account, /strictProxy\?:\s*'auto'\s*\|\s*'require'\s*\|\s*'exempt'/)
    assert.match(desk, /id="acc-strict-proxy"/)
    assert.match(desk, /acc\.strictProxy\s*=\s*sp/)
})
