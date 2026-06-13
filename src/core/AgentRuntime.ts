import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import readline from 'readline'

import type { DashboardLog } from '../types/Dashboard'
import { writeJsonAtomic } from '../helpers/AtomicFile'

const STATE_DIR = '.core'
const STATE_FILE = 'agent.json'

export interface AgentRuntimeState {
    pid: number
    port: number
    token: string
    startedAt: string
    cwd: string
    version: 1
}

interface AgentClient {
    socket: net.Socket
    mode: 'logs'
}

export interface AgentStatus {
    active: boolean
    pid?: number
    runState: 'idle' | 'running'
    lastExitCode?: number | null
}

export class AgentRuntime {
    private server: net.Server | null = null
    private clients = new Set<AgentClient>()
    private state: AgentRuntimeState | null = null
    private runHandler: (() => Promise<number>) | null = null
    private stopHandler: (() => void) | null = null
    private runInFlight = false
    private lastExitCode: number | null = null

    setRunHandler(handler: () => Promise<number>): void {
        this.runHandler = handler
    }

    setStopHandler(handler: () => void): void {
        this.stopHandler = handler
    }

    async start(): Promise<void> {
        if (this.server) return

        await fs.promises.mkdir(agentStateDir(), { recursive: true })
        const token = crypto.randomBytes(24).toString('hex')
        const server = net.createServer(socket => this.handleSocket(socket, token))

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject)
                resolve()
            })
        })

        const address = server.address()
        if (!address || typeof address === 'string') {
            server.close()
            throw new Error('Agent IPC did not bind to a TCP port')
        }

        this.server = server
        this.state = {
            version: 1,
            pid: process.pid,
            port: address.port,
            token,
            startedAt: new Date().toISOString(),
            cwd: process.cwd()
        }

        await writeJsonAtomic(agentStatePath(), this.state)
    }

    async stop(): Promise<void> {
        const server = this.server
        this.server = null
        this.state = null

        for (const client of this.clients) {
            client.socket.end()
        }
        this.clients.clear()

        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
        await fs.promises.rm(agentStatePath(), { force: true }).catch(() => undefined)
    }

    publishLog(log: DashboardLog): void {
        const payload = JSON.stringify({ type: 'log', log }) + '\n'
        for (const client of this.clients) {
            if (client.mode === 'logs') client.socket.write(payload)
        }
    }

    private handleSocket(socket: net.Socket, token: string): void {
        socket.setEncoding('utf8')
        let buffer = ''
        let authed = false
        let client: AgentClient | null = null

        socket.on('data', chunk => {
            buffer += chunk
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                newline = buffer.indexOf('\n')

                const message = parseJson<Record<string, unknown>>(line)
                if (!message) {
                    socket.end()
                    return
                }

                if (!authed) {
                    if (message.token !== token) {
                        socket.end()
                        return
                    }
                    authed = true
                }

                if (message.type === 'ping') {
                    socket.write(
                        JSON.stringify({
                            type: 'pong',
                            pid: process.pid,
                            cwd: process.cwd(),
                            runState: this.runInFlight ? 'running' : 'idle',
                            lastExitCode: this.lastExitCode
                        }) + '\n'
                    )
                    socket.end()
                } else if (message.type === 'attach') {
                    client = { socket, mode: 'logs' }
                    this.clients.add(client)
                    socket.write(JSON.stringify({ type: 'attached', pid: process.pid }) + '\n')
                } else if (message.type === 'run_now') {
                    if (!this.runHandler) {
                        socket.write(JSON.stringify({ type: 'run_rejected', reason: 'Run handler unavailable' }) + '\n')
                        socket.end()
                    } else if (this.runInFlight) {
                        socket.write(JSON.stringify({ type: 'run_rejected', reason: 'A run is already in progress' }) + '\n')
                        socket.end()
                    } else {
                        this.runInFlight = true
                        this.lastExitCode = null
                        socket.write(JSON.stringify({ type: 'run_accepted', pid: process.pid }) + '\n')
                        socket.end()
                        void this.runHandler()
                            .then(exitCode => {
                                this.lastExitCode = exitCode
                            })
                            .catch(() => {
                                this.lastExitCode = 1
                            })
                            .finally(() => {
                                this.runInFlight = false
                            })
                    }
                } else if (message.type === 'stop_after_current') {
                    this.stopHandler?.()
                    socket.write(JSON.stringify({ type: 'stop_accepted' }) + '\n')
                    socket.end()
                } else if (message.type === 'shutdown') {
                    socket.write(JSON.stringify({ type: 'shutdown_ack' }) + '\n')
                    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
                }
            }
        })

        socket.on('close', () => {
            if (client) this.clients.delete(client)
        })
    }
}

export async function readAgentState(): Promise<AgentRuntimeState | null> {
    const state = parseJson<AgentRuntimeState>(await fs.promises.readFile(agentStatePath(), 'utf8').catch(() => ''))
    if (!state || state.version !== 1 || !state.port || !state.token || !state.pid || state.cwd !== process.cwd()) {
        await fs.promises.rm(agentStatePath(), { force: true }).catch(() => undefined)
        return null
    }
    return state
}

export async function isAgentActive(state?: AgentRuntimeState | null): Promise<boolean> {
    const currentState = state ?? (await readAgentState())
    if (!currentState) return false
    const active = await sendAgentMessage<{ type?: string; pid?: number; cwd?: string }>(
        currentState,
        { type: 'ping' },
        1000
    )
        .then(response => response?.type === 'pong' && response.pid === currentState.pid && response.cwd === currentState.cwd)
        .catch(() => false)

    if (!active && currentState.cwd === process.cwd()) {
        await fs.promises.rm(agentStatePath(), { force: true }).catch(() => undefined)
    }

    return active
}

export async function getAgentStatus(): Promise<AgentStatus> {
    const state = await readAgentState()
    if (!state) return { active: false, runState: 'idle' }
    const response = await sendAgentMessage<{
        type?: string
        pid?: number
        cwd?: string
        runState?: 'idle' | 'running'
        lastExitCode?: number | null
    }>(state, { type: 'ping' }, 1000).catch(() => null)
    if (response?.type !== 'pong' || response.pid !== state.pid || response.cwd !== state.cwd) {
        return { active: false, runState: 'idle' }
    }
    return {
        active: true,
        pid: response.pid,
        runState: response.runState === 'running' ? 'running' : 'idle',
        lastExitCode: response.lastExitCode
    }
}

export async function requestAgentRun(): Promise<{ accepted: boolean; reason?: string }> {
    const state = await readAgentState()
    if (!state || !(await isAgentActive(state))) return { accepted: false, reason: 'No active Core agent' }
    const response = await sendAgentMessage<{ type?: string; reason?: string }>(state, { type: 'run_now' }, 1500)
    return response?.type === 'run_accepted'
        ? { accepted: true }
        : { accepted: false, reason: response?.reason || 'The Core agent rejected the run' }
}

export async function requestAgentStop(): Promise<boolean> {
    const state = await readAgentState()
    if (!state || !(await isAgentActive(state))) return false
    const response = await sendAgentMessage<{ type?: string }>(state, { type: 'stop_after_current' }, 1500)
    return response?.type === 'stop_accepted'
}

export async function subscribeToAgentLogs(
    onLog: (log: DashboardLog) => void,
    onClose?: () => void
): Promise<() => void> {
    const state = await readAgentState()
    if (!state || !(await isAgentActive(state))) throw new Error('No active Core agent')

    const socket = net.connect({ host: '127.0.0.1', port: state.port })
    socket.setEncoding('utf8')
    let buffer = ''
    let attached = false
    let resolveAttached: (() => void) | null = null
    let rejectAttached: ((error: Error) => void) | null = null
    const attachedPromise = new Promise<void>((resolve, reject) => {
        resolveAttached = resolve
        rejectAttached = reject
    })
    const attachTimeout = setTimeout(() => {
        rejectAttached?.(new Error('Timed out while attaching to Core agent logs'))
        socket.destroy()
    }, 1500)
    socket.on('connect', () => {
        socket.write(JSON.stringify({ token: state.token, type: 'attach' }) + '\n')
    })
    socket.on('data', chunk => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            const message = parseJson<{ type?: string; log?: DashboardLog }>(line)
            if (message?.type === 'attached' && !attached) {
                attached = true
                clearTimeout(attachTimeout)
                resolveAttached?.()
            }
            if (message?.type === 'log' && message.log) onLog(message.log)
            newline = buffer.indexOf('\n')
        }
    })
    socket.on('error', error => {
        if (!attached) {
            clearTimeout(attachTimeout)
            rejectAttached?.(error)
        }
    })
    socket.on('close', () => {
        if (!attached) {
            clearTimeout(attachTimeout)
            rejectAttached?.(new Error('Core agent log connection closed before attachment'))
        }
        onClose?.()
    })
    await attachedPromise
    return () => socket.destroy()
}

export async function stopExistingAgent(): Promise<boolean> {
    const state = await readAgentState()
    if (!state) return false
    await sendAgentMessage(state, { type: 'shutdown' }, 1500).catch(() => undefined)
    for (let index = 0; index < 20; index++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        if (!(await isAgentActive(state))) return true
    }
    return false
}

export async function attachToAgent(): Promise<number> {
    const state = await readAgentState()
    if (!state) {
        console.error('[AGENT] No running background instance found.')
        return 1
    }
    if (!(await isAgentActive(state))) {
        console.error('[AGENT] Background instance state was stale and has been cleared.')
        return 1
    }

    return new Promise<number>(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port: state.port })
        socket.setEncoding('utf8')
        socket.on('connect', () => {
            socket.write(JSON.stringify({ token: state.token, type: 'attach' }) + '\n')
        })
        socket.on('data', chunk => {
            for (const line of String(chunk).split('\n')) {
                const message = parseJson<{ type?: string; log?: DashboardLog; pid?: number }>(line)
                if (!message) continue
                if (message.type === 'attached') console.log(`[AGENT] Attached to process ${message.pid}.`)
                if (message.type === 'log' && message.log) {
                    console.log(formatAttachedLog(message.log))
                }
            }
        })
        socket.on('error', error => {
            console.error(`[AGENT] Attach failed: ${error.message}`)
            resolve(1)
        })
        socket.on('close', () => resolve(0))
    })
}

export async function confirmReplaceExistingAgent(): Promise<boolean> {
    if (!process.stdin.isTTY || process.argv.includes('--background')) return false

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => {
        rl.question('A Microsoft Rewards Bot instance is already running. Close it and continue? [y/N] ', resolve)
    })
    rl.close()
    return answer.trim().toLowerCase() === 'y'
}

export function agentStatePath(): string {
    return path.join(agentStateDir(), STATE_FILE)
}

export function agentStateDir(): string {
    return path.resolve(process.cwd(), STATE_DIR)
}

function sendAgentMessage<T = unknown>(
    state: AgentRuntimeState,
    message: Record<string, unknown>,
    timeoutMs: number
): Promise<T | null> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: state.port })
        socket.setEncoding('utf8')
        let buffer = ''
        let settled = false
        const timeout = setTimeout(() => {
            settled = true
            socket.destroy()
            reject(new Error('Agent IPC timeout'))
        }, timeoutMs)

        const finish = (value: T | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            socket.end()
            resolve(value)
        }

        socket.on('connect', () => {
            socket.write(JSON.stringify({ token: state.token, ...message }) + '\n')
            if (message.type === 'shutdown') {
                finish(null)
            }
        })
        socket.on('data', chunk => {
            buffer += chunk
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                const response = parseJson<T>(line)
                finish(response)
                newline = buffer.indexOf('\n')
            }
        })
        socket.on('error', error => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
        })
        socket.on('close', () => finish(null))
    })
}

function formatAttachedLog(log: DashboardLog): string {
    const time = log.time ? new Date(log.time).toLocaleTimeString() : new Date().toLocaleTimeString()
    return `[${time}] [${log.userName || 'MAIN'}] [${(log.level || 'info').toUpperCase()}] ${log.platform || 'MAIN'} [${log.title || 'LOG'}] ${log.message || ''}`
}

function parseJson<T>(value: string): T | null {
    try {
        return JSON.parse(value) as T
    } catch {
        return null
    }
}

export function isInteractiveTerminal(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function platformAutostartName(): string {
    return `${os.userInfo().username || 'user'} Microsoft Rewards Bot`
}
