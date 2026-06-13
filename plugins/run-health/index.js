'use strict'

const fs = require('node:fs')
const path = require('node:path')

class RunHealthPlugin {
    constructor() {
        this.name = 'run-health'
        this.version = '1.0.0'
        this.botVersionRange = '>=4.0.0'
        this.capabilities = ['diagnostics']
        this.description = 'Tracks recent account outcomes and flags repeated failures or suspicious zero-point runs.'
        this.author = 'QuestPilot'
        this.license = 'MIT'
        this.outputDir = 'data/run-health'
        this.historyLimit = 50
        this.warnOnZeroPoints = true
        this.log = null
    }

    register(context) {
        this.log = context.log
        this.outputDir = stringConfig(context.config.outputDir, this.outputDir)
        this.historyLimit = integerConfig(context.config.historyLimit, 10, 500, this.historyLimit)
        this.warnOnZeroPoints = context.config.warnOnZeroPoints !== false

        context.registerDiagnostics(async () => {
            const history = await this.readHistory()
            if (!history.length) {
                return [{ level: 'info', message: 'Run Health is enabled. No account runs have been recorded yet.' }]
            }
            const failures = history.filter(entry => !entry.success)
            const zeroPointRuns = history.filter(entry => entry.success && entry.collectedPoints === 0)
            const latestFailures = consecutiveFailures(history)
            const level = latestFailures >= 2 || failures.length / history.length >= 0.25 ? 'warn' : 'info'
            return [{
                level,
                message: `${history.length} recent account run(s): ${failures.length} failed, ${zeroPointRuns.length} completed with zero points.`,
                details: {
                    recordedRuns: history.length,
                    failures: failures.length,
                    zeroPointRuns: zeroPointRuns.length,
                    consecutiveFailures: latestFailures,
                    averageDurationSeconds: average(history.map(entry => entry.durationSeconds))
                }
            }]
        })

        this.log.info('main', 'RUN-HEALTH', `Monitoring the last ${this.historyLimit} account runs`)
    }

    async onAccountEnd({ result }) {
        const history = await this.readHistory()
        const entry = {
            recordedAt: new Date().toISOString(),
            account: maskEmail(result.email),
            success: Boolean(result.success),
            collectedPoints: safeNumber(result.collectedPoints),
            durationSeconds: safeNumber(result.duration),
            error: result.error ? String(result.error).slice(0, 300) : null
        }
        history.push(entry)
        await atomicJsonWrite(this.historyPath(), history.slice(-this.historyLimit))

        if (!entry.success) {
            this.log.warn('main', 'RUN-HEALTH', `${entry.account} failed: ${entry.error || 'unknown error'}`)
        } else if (this.warnOnZeroPoints && entry.collectedPoints === 0) {
            this.log.warn('main', 'RUN-HEALTH', `${entry.account} completed but collected zero points`)
        }
    }

    historyPath() {
        return path.resolve(process.cwd(), this.outputDir, 'history.json')
    }

    async readHistory() {
        try {
            const value = JSON.parse(await fs.promises.readFile(this.historyPath(), 'utf8'))
            return Array.isArray(value) ? value : []
        } catch {
            return []
        }
    }
}

async function atomicJsonWrite(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(temporary, filePath)
}

function stringConfig(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function integerConfig(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(String(value), 10)
    return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function safeNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

function maskEmail(email) {
    const [name, domain] = String(email || '').split('@')
    if (!name || !domain) return 'account'
    return `${name.slice(0, 2)}***@${domain}`
}

function consecutiveFailures(history) {
    let count = 0
    for (let index = history.length - 1; index >= 0 && !history[index].success; index--) count++
    return count
}

function average(values) {
    if (!values.length) return 0
    return Math.round(values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length)
}

module.exports = RunHealthPlugin
