const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { writeFileAtomic, writeJsonAtomic } = require('../../dist/helpers/AtomicFile')

test('atomic file helper writes through temp file and leaves final content only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-atomic-'))
    const filePath = path.join(dir, 'state.json')

    await writeJsonAtomic(filePath, { ok: true })

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ok: true })
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('atomic file helper supports binary diagnostics', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-atomic-bin-'))
    const filePath = path.join(dir, 'screenshot.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    await writeFileAtomic(filePath, bytes)

    assert.deepEqual(fs.readFileSync(filePath), bytes)
})

test('runtime session and diagnostics writers use atomic file helper', () => {
    const root = path.join(__dirname, '..', '..')
    const configLoader = fs.readFileSync(path.join(root, 'src/helpers/ConfigLoader.ts'), 'utf8')
    const agentRuntime = fs.readFileSync(path.join(root, 'src/core/AgentRuntime.ts'), 'utf8')
    const diagnostics = fs.readFileSync(path.join(root, 'src/helpers/ErrorDiagnostic.ts'), 'utf8')

    assert.match(configLoader, /writeJsonAtomic/)
    assert.match(configLoader, /Could not read \$\{label\}/)
    assert.doesNotMatch(configLoader, /new Error\(error as string\)/)
    assert.match(agentRuntime, /writeJsonAtomic/)
    assert.match(diagnostics, /writeFileAtomic/)
})
