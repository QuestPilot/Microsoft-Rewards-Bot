import chalk from 'chalk'
import cluster from 'cluster'
import { errorDiagnostic } from '../helpers/ErrorDiagnostic'
import type { MicrosoftRewardsBot } from '../index'
import type { LogFilter } from '../types/Config'
import type { DashboardPlatform } from '../types/Dashboard'
import { sendDiscord } from './DiscordWebhook'
import { sendNtfy } from './NtfyWebhook'

export type Platform = boolean | 'main'
export type LogLevel = 'info' | 'warn' | 'error' | 'debug'
export type ColorKey = keyof typeof chalk
export interface IpcLog {
    content: string
    level: LogLevel
}

type ChalkFn = (msg: string) => string

function platformText(platform: Platform): DashboardPlatform {
    return platform === 'main' ? 'MAIN' : platform ? 'MOBILE' : 'DESKTOP'
}

function platformBadge(platform: Platform): string {
    let name = ''
    let colorFn = chalk.cyan
    if (platform === 'main') {
        name = 'SYSTEM '
        colorFn = chalk.cyan
    } else if (platform) {
        name = 'MOBILE '
        colorFn = chalk.blue
    } else {
        name = 'DESKTOP'
        colorFn = chalk.magenta
    }
    return `${chalk.gray('[')}${colorFn(name)}${chalk.gray(']')}`
}

function formatTimestamp(): string {
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const yyyy = now.getFullYear()
    const mm = pad(now.getMonth() + 1)
    const dd = pad(now.getDate())
    const hh = pad(now.getHours())
    const min = pad(now.getMinutes())
    const ss = pad(now.getSeconds())
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`
}

function getColorFn(color?: ColorKey): ChalkFn | null {
    return color && typeof chalk[color] === 'function' ? (chalk[color] as ChalkFn) : null
}

function consoleOut(level: LogLevel, msg: string, chalkFn: ChalkFn | null): void {
    const out = chalkFn ? chalkFn(msg) : msg
    switch (level) {
        case 'warn':
            return console.warn(out)
        case 'error':
            return console.error(out)
        default:
            return console.log(out)
    }
}

function formatMessage(message: string | Error): string {
    return message instanceof Error ? `${message.message}\n${message.stack || ''}` : message
}

export class LogService {
    constructor(private bot: MicrosoftRewardsBot) {}

    info(isMobile: Platform, title: string, message: string, color?: ColorKey) {
        return this.baseLog('info', isMobile, title, message, color)
    }

    warn(isMobile: Platform, title: string, message: string | Error, color?: ColorKey) {
        return this.baseLog('warn', isMobile, title, message, color)
    }

    error(isMobile: Platform, title: string, message: string | Error, color?: ColorKey) {
        return this.baseLog('error', isMobile, title, message, color)
    }

    debug(isMobile: Platform, title: string, message: string | Error, color?: ColorKey) {
        return this.baseLog('debug', isMobile, title, message, color)
    }

    private baseLog(
        level: LogLevel,
        isMobile: Platform,
        title: string,
        message: string | Error,
        color?: ColorKey
    ): void {
        const now = formatTimestamp()
        const formatted = formatMessage(message)

        const userName = this.bot.userData.userName ? this.bot.userData.userName : 'MAIN'

        const levelTag = level.toUpperCase()
        const cleanMsg = `[${now}] [${userName}] [${levelTag}] ${platformText(isMobile)} [${title}] ${formatted}`

        const config = this.bot.config

        if (level === 'debug' && !config.debugLogs && !process.argv.includes('-dev')) {
            return
        }

        this.bot.pushDashboardLog({
            time: new Date().toISOString(),
            userName,
            level,
            platform: platformText(isMobile),
            title,
            message: formatted
        })

        const badge = platformBadge(isMobile)

        let logColor: ColorKey | undefined = color

        if (!logColor) {
            switch (level) {
                case 'error':
                    logColor = 'red'
                    break
                case 'warn':
                    logColor = 'yellow'
                    break
                case 'debug':
                    logColor = 'magenta'
                    break
                default:
                    break
            }
        }

        // Format console output beautifully
        const timeStr = chalk.gray(`[${now}]`)
        const userStr = `${chalk.gray('[')}${chalk.cyan(userName)}${chalk.gray(']')}`
        
        let levelStr = ''
        switch (level) {
            case 'info':
                levelStr = chalk.bold.green('INFO ')
                break
            case 'warn':
                levelStr = chalk.bold.yellow('WARN ')
                break
            case 'error':
                levelStr = chalk.bold.red('ERROR')
                break
            case 'debug':
                levelStr = chalk.bold.magenta('DEBUG')
                break
        }
        levelStr = `${chalk.gray('[')}${levelStr}${chalk.gray(']')}`

        const titleStr = `${chalk.gray('[')}${chalk.bold.white(title)}${chalk.gray(']')}`
        const platformStr = badge
        
        const colorFn = getColorFn(logColor)
        const msgStr = colorFn ? colorFn(formatted) : formatted

        const consoleStr = `${timeStr} ${userStr} ${levelStr} ${platformStr} ${titleStr} ${msgStr}`

        if (level === 'error' && config.errorDiagnostics) {
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            const error = message instanceof Error ? message : new Error(String(message))
            errorDiagnostic(page, error, (msg) => this.warn(isMobile, 'DIAGNOSTIC', msg))
        }

        const consoleAllowed = this.shouldPassFilter(config.consoleLogFilter, level, cleanMsg)
        const webhookAllowed = this.shouldPassFilter(config.webhook.webhookLogFilter, level, cleanMsg)

        if (consoleAllowed) {
            consoleOut(level, consoleStr, null)
        }

        if (!webhookAllowed) {
            return
        }

        if (cluster.isPrimary) {
            if (config.webhook.discord?.enabled && config.webhook.discord.url) {
                if (level === 'debug') return
                sendDiscord(config.webhook.discord.url, cleanMsg, level)
            }

            if (config.webhook.ntfy?.enabled && config.webhook.ntfy.url) {
                if (level === 'debug') return
                sendNtfy(config.webhook.ntfy, cleanMsg, level)
            }
        } else {
            process.send?.({ __ipcLog: { content: cleanMsg, level } })
        }
    }

    private shouldPassFilter(filter: LogFilter | undefined, level: LogLevel, message: string): boolean {
        // If disabled or not, let all logs pass
        if (!filter || !filter.enabled) {
            return true
        }

        const { mode, levels, keywords, regexPatterns } = filter

        const hasLevelRule = Array.isArray(levels) && levels.length > 0
        const hasKeywordRule = Array.isArray(keywords) && keywords.length > 0
        const hasPatternRule = Array.isArray(regexPatterns) && regexPatterns.length > 0

        if (!hasLevelRule && !hasKeywordRule && !hasPatternRule) {
            return mode === 'blacklist'
        }

        const lowerMessage = message.toLowerCase()
        let isMatch = false

        if (hasLevelRule && levels!.includes(level)) {
            isMatch = true
        }

        if (!isMatch && hasKeywordRule) {
            if (keywords!.some(k => lowerMessage.includes(k.toLowerCase()))) {
                isMatch = true
            }
        }

        // Fancy regex filtering if set!
        if (!isMatch && hasPatternRule) {
            for (const pattern of regexPatterns!) {
                try {
                    const regex = new RegExp(pattern, 'i')
                    if (regex.test(message)) {
                        isMatch = true
                        break
                    }
                } catch {}
            }
        }

        return mode === 'whitelist' ? isMatch : !isMatch
    }
}
