const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    AgentRuntime,
    agentStatePath,
    isAgentActive,
    readAgentState
} = require('../dist/core/AgentRuntime')

test('background agent IPC writes state, answers ping, and clears state on stop', async () => {
    const previousCwd = process.cwd()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-agent-'))
    const runtime = new AgentRuntime()

    try {
        process.chdir(tempDir)
        await runtime.start()

        const state = await readAgentState()
        assert.equal(state.version, 1)
        assert.equal(state.cwd, tempDir)
        assert.equal(await isAgentActive(state), true)

        await runtime.stop()
        assert.equal(fs.existsSync(agentStatePath()), false)
    } finally {
        await runtime.stop().catch(() => undefined)
        process.chdir(previousCwd)
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('background agent ignores stale state from a different project root', async () => {
    const previousCwd = process.cwd()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-agent-stale-'))

    try {
        process.chdir(tempDir)
        fs.mkdirSync(path.dirname(agentStatePath()), { recursive: true })
        fs.writeFileSync(
            agentStatePath(),
            JSON.stringify({
                version: 1,
                pid: 123,
                port: 456,
                token: 'token',
                startedAt: new Date().toISOString(),
                cwd: path.join(tempDir, 'other')
            })
        )

        assert.equal(await readAgentState(), null)
        assert.equal(fs.existsSync(agentStatePath()), false)
        assert.equal(await isAgentActive(), false)
    } finally {
        process.chdir(previousCwd)
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})
