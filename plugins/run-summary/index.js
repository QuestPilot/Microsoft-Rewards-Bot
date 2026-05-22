'use strict'

const fs = require('node:fs')
const path = require('node:path')

class RunSummaryPlugin {
    constructor() {
        this.name = 'run-summary'
        this.version = '1.0.0'
        this.botVersionRange = '>=4.0.0'
        this.capabilities = ['diagnostics', 'notifications']
        this.description = 'Writes local account run summaries for quick review after a bot run.'
        this.author = 'QuestPilot'
        this.license = 'MIT'
        this.outputDir = 'diagnostics/run-summary'
        this.includeEmails = false
        this.writeMarkdown = true
        this.log = null
    }

    register(context) {
        this.log = context.log
        this.outputDir = stringConfig(context.config.outputDir, this.outputDir)
        this.includeEmails = Boolean(context.config.includeEmails)
        this.writeMarkdown = context.config.writeMarkdown !== false

        context.registerDiagnostics(async () => {
            const summary = await this.readLatestSummary()
            if (!summary) {
                return [{ level: 'info', message: 'Run Summary is enabled. No account results have been recorded yet.' }]
            }

            return [{
                level: summary.failedAccounts > 0 ? 'warn' : 'info',
                message: `Last recorded run summary: ${summary.totalAccounts} account(s), +${summary.totalCollectedPoints} points, ${summary.failedAccounts} failed.`,
                details: summary
            }]
        })

        context.registerNotificationSink(async notification => {
            await this.appendJsonl('notifications.jsonl', {
                createdAt: new Date().toISOString(),
                title: notification.title,
                message: notification.message,
                level: notification.level || 'info'
            })
        })

        this.log.info('main', 'RUN-SUMMARY', `Writing summaries to ${this.outputDir}`)
    }

    async onAccountEnd({ result }) {
        const entry = {
            createdAt: new Date().toISOString(),
            email: this.includeEmails ? result.email : maskEmail(result.email),
            initialPoints: safeNumber(result.initialPoints),
            finalPoints: safeNumber(result.finalPoints),
            collectedPoints: safeNumber(result.collectedPoints),
            durationSeconds: safeNumber(result.duration),
            success: Boolean(result.success),
            error: result.error || null
        }

        await this.appendJsonl('accounts.jsonl', entry)
        await this.writeLatestSummary(entry)

        const status = entry.success ? 'ok' : 'failed'
        this.log.info('main', 'RUN-SUMMARY', `${entry.email}: ${status} | +${entry.collectedPoints} points`)
    }

    async appendJsonl(fileName, entry) {
        const dir = path.resolve(process.cwd(), this.outputDir)
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.appendFile(path.join(dir, fileName), `${JSON.stringify(entry)}\n`, 'utf8')
    }

    async writeLatestSummary(entry) {
        const dir = path.resolve(process.cwd(), this.outputDir)
        await fs.promises.mkdir(dir, { recursive: true })

        const latestPath = path.join(dir, 'latest.json')
        const latest = await this.readLatestSummary() || {
            startedAt: entry.createdAt,
            totalAccounts: 0,
            successfulAccounts: 0,
            failedAccounts: 0,
            totalCollectedPoints: 0,
            totalDurationSeconds: 0,
            accounts: []
        }

        latest.updatedAt = entry.createdAt
        latest.totalAccounts += 1
        latest.successfulAccounts += entry.success ? 1 : 0
        latest.failedAccounts += entry.success ? 0 : 1
        latest.totalCollectedPoints += entry.collectedPoints
        latest.totalDurationSeconds += entry.durationSeconds
        latest.accounts.push(entry)
        latest.accounts = latest.accounts.slice(-100)

        await fs.promises.writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`, 'utf8')
        if (this.writeMarkdown) {
            await fs.promises.writeFile(path.join(dir, 'latest.md'), renderMarkdown(latest), 'utf8')
        }
    }

    async readLatestSummary() {
        try {
            const latestPath = path.resolve(process.cwd(), this.outputDir, 'latest.json')
            return JSON.parse(await fs.promises.readFile(latestPath, 'utf8'))
        } catch {
            return null
        }
    }
}

function stringConfig(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function safeNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

function maskEmail(email) {
    const [name, domain] = String(email || '').split('@')
    if (!name || !domain) return String(email || '')
    return `${name.slice(0, 2)}***@${domain}`
}

function renderMarkdown(summary) {
    const rows = summary.accounts
        .slice(-25)
        .map(account => `| ${account.createdAt} | ${account.email} | ${account.success ? 'yes' : 'no'} | ${account.collectedPoints} | ${account.durationSeconds}s | ${account.error || ''} |`)
        .join('\n')

    return [
        '# Run Summary',
        '',
        `Updated: ${summary.updatedAt || summary.startedAt}`,
        '',
        `- Accounts: ${summary.totalAccounts}`,
        `- Successful: ${summary.successfulAccounts}`,
        `- Failed: ${summary.failedAccounts}`,
        `- Points collected: ${summary.totalCollectedPoints}`,
        `- Duration: ${Math.round(summary.totalDurationSeconds)}s`,
        '',
        '| Time | Account | Success | Points | Duration | Error |',
        '| --- | --- | --- | ---: | ---: | --- |',
        rows || '| - | - | - | 0 | 0s | - |',
        ''
    ].join('\n')
}

module.exports = RunSummaryPlugin

