'use strict'

const fs = require('node:fs')
const path = require('node:path')

class SessionHealthPlugin {
    constructor() {
        this.name = 'session-health'
        this.version = '1.0.0'
        this.botVersionRange = '>=4.0.0'
        this.capabilities = ['diagnostics']
        this.description = 'Checks the official sessions directory for missing, empty, or stale account sessions.'
        this.author = 'QuestPilot'
        this.license = 'MIT'
        this.sessionPath = 'sessions'
        this.staleDays = 30
        this.log = null
    }

    register(context) {
        this.log = context.log
        this.sessionPath = stringConfig(context.config.sessionPath, this.sessionPath)
        this.staleDays = integerConfig(context.config.staleDays, 1, 365, this.staleDays)

        context.registerDiagnostics(async () => {
            const report = await inspectSessions(path.resolve(process.cwd(), this.sessionPath), this.staleDays)
            if (!report.exists) {
                return [{
                    level: 'info',
                    message: `No sessions directory exists yet at ${this.sessionPath}. It will be created after the first login.`
                }]
            }
            const level = report.emptySessions > 0 || report.staleSessions > 0 ? 'warn' : 'info'
            return [{
                level,
                message: `${report.totalSessions} session(s): ${report.staleSessions} stale, ${report.emptySessions} empty.`,
                details: report
            }]
        })

        this.log.info('main', 'SESSION-HEALTH', `Checking ${this.sessionPath} for sessions older than ${this.staleDays} days`)
    }
}

async function inspectSessions(sessionRoot, staleDays) {
    let entries
    try {
        entries = await fs.promises.readdir(sessionRoot, { withFileTypes: true })
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, totalSessions: 0, staleSessions: 0, emptySessions: 0, staleDays }
        }
        throw error
    }

    const sessionDirectories = entries.filter(entry => entry.isDirectory())
    let staleSessions = 0
    let emptySessions = 0
    const staleBefore = Date.now() - staleDays * 24 * 60 * 60 * 1000

    for (const entry of sessionDirectories) {
        const directory = path.join(sessionRoot, entry.name)
        const children = await fs.promises.readdir(directory)
        if (!children.length) {
            emptySessions++
            continue
        }
        const stats = await Promise.all(children.map(child => fs.promises.stat(path.join(directory, child))))
        const newestMtime = Math.max(...stats.map(stat => stat.mtimeMs))
        if (newestMtime < staleBefore) staleSessions++
    }

    return {
        exists: true,
        totalSessions: sessionDirectories.length,
        staleSessions,
        emptySessions,
        staleDays
    }
}

function stringConfig(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function integerConfig(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(String(value), 10)
    return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

module.exports = SessionHealthPlugin
