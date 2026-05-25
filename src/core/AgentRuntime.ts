import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import readline from 'readline'

import type { DashboardLog } from '../types/Dashboard'

const STATE_DIR = '.core'
const STATE_FILE = 'agent.json'

export interface AgentRuntimeState {
    pid: number
    port: number
    token: string
    startedAt: string
    cwd: string
}

interface AgentClient {
    socket: net.Socket
    mode: 'logs'
}

export class AgentRuntime {
    private server: net.Server | null = null
    private clients = new Set<AgentClient>()
    private state: AgentRuntimeState | null = null

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
            pid: process.pid,
            port: address.port,
            token,
            startedAt: new Date().toISOString(),
            cwd: process.cwd()
        }

        await fs.promises.writeFile(agentStatePath(), JSON.stringify(this.state, null, 2))
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

                if (message.type === 'attach') {
                    client = { socket, mode: 'logs' }
                    this.clients.add(client)
                    socket.write(JSON.stringify({ type: 'attached', pid: process.pid }) + '\n')
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
    if (!state || !state.port || !state.token || !state.pid) return null
    return state
}

export async function isAgentActive(state?: AgentRuntimeState | null): Promise<boolean> {
    const currentState = state ?? (await readAgentState())
    if (!currentState) return false
    return sendAgentMessage(currentState, { type: 'ping' }, 1000)
        .then(() => true)
        .catch(() => false)
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

function sendAgentMessage(state: AgentRuntimeState, message: Record<string, unknown>, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: state.port })
        const timeout = setTimeout(() => {
            socket.destroy()
            reject(new Error('Agent IPC timeout'))
        }, timeoutMs)

        socket.on('connect', () => {
            socket.write(JSON.stringify({ token: state.token, ...message }) + '\n')
            clearTimeout(timeout)
            socket.end()
            resolve()
        })
        socket.on('error', error => {
            clearTimeout(timeout)
            reject(error)
        })
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
