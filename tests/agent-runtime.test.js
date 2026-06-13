const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    AgentRuntime,
    agentStatePath,
    getAgentStatus,
    isAgentActive,
    readAgentState,
    requestAgentRun,
    requestAgentStop,
    subscribeToAgentLogs
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

test('Rewards Desk can request runs, receive logs, and stop through authenticated agent IPC', async () => {
    const previousCwd = process.cwd()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-agent-desk-'))
    const runtime = new AgentRuntime()
    let stopRequested = false
    let finishRun

    try {
        process.chdir(tempDir)
        runtime.setRunHandler(() => new Promise(resolve => { finishRun = resolve }))
        runtime.setStopHandler(() => { stopRequested = true })
        await runtime.start()

        const logs = []
        const unsubscribe = await subscribeToAgentLogs(log => logs.push(log))
        assert.deepEqual(await requestAgentRun(), { accepted: true })
        assert.equal((await getAgentStatus()).runState, 'running')
        assert.equal((await requestAgentRun()).accepted, false)

        runtime.publishLog({
            time: new Date().toISOString(),
            userName: 'MAIN',
            level: 'info',
            platform: 'MAIN',
            title: 'TEST',
            message: 'Desk received this log'
        })
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(logs.at(-1).message, 'Desk received this log')

        assert.equal(await requestAgentStop(), true)
        assert.equal(stopRequested, true)
        finishRun(0)
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal((await getAgentStatus()).lastExitCode, 0)
        unsubscribe()
    } finally {
        await runtime.stop().catch(() => undefined)
        process.chdir(previousCwd)
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})
