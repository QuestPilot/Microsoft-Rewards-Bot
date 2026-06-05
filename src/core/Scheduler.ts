import type { ConfigScheduler } from '../types/Config'
import Helpers from '../helpers/Helpers'

const helpers = new Helpers()

export interface ScheduledRun {
    target: Date
    baseTarget: Date
    jitterMs: number
}

export function isSchedulerEnabled(config?: ConfigScheduler): config is ConfigScheduler {
    return Boolean(config?.enabled)
}

export function getNextScheduledRun(config: ConfigScheduler, now = new Date()): ScheduledRun {
    const [hour, minute] = parseStartTime(config.startTime)
    const currentParts = getZonedParts(now, config.timezone)
    let baseTarget = zonedTimeToDate(
        currentParts.year,
        currentParts.month,
        currentParts.day,
        hour,
        minute,
        config.timezone
    )

    if (baseTarget <= now) {
        baseTarget = nextZonedDayTarget(currentParts, hour, minute, config.timezone)
    }

    const minDelay = helpers.stringToNumber(config.randomDelay.min)
    const maxDelay = helpers.stringToNumber(config.randomDelay.max)
    const safeMin = Math.max(0, Math.min(minDelay, maxDelay))
    const safeMax = Math.max(safeMin, maxDelay)
    let jitterMs = randomJitter(safeMin, safeMax)
    let target = new Date(baseTarget.getTime() + jitterMs)

    if (target <= now) {
        baseTarget = nextZonedDayTarget(currentParts, hour, minute, config.timezone)
        jitterMs = randomJitter(safeMin, safeMax)
        target = new Date(baseTarget.getTime() + jitterMs)
    }

    return {
        baseTarget,
        jitterMs,
        target
    }
}

export function formatScheduledRun(run: ScheduledRun, timezone: string): string {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })

    return `${formatter.format(run.target)} ${timezone}`
}

export function waitUntil(target: Date, abortSignal?: AbortSignal): Promise<void> {
    const delay = Math.max(0, target.getTime() - Date.now())

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, delay)

        if (abortSignal) {
            abortSignal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timeout)
                    reject(new Error('Scheduler wait aborted'))
                },
                { once: true }
            )
        }
    })
}

function parseStartTime(value: string): [number, number] {
    const match = value.match(/^(\d{2}):(\d{2})$/)
    if (!match) throw new Error(`Invalid scheduler startTime "${value}". Expected HH:mm.`)

    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) {
        throw new Error(`Invalid scheduler startTime "${value}". Expected HH:mm.`)
    }

    return [hour, minute]
}

function getZonedParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date)

    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value)

    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
        second: value('second')
    }
}

function nextZonedDayTarget(
    currentParts: ReturnType<typeof getZonedParts>,
    hour: number,
    minute: number,
    timeZone: string
): Date {
    const nextDay = new Date(Date.UTC(currentParts.year, currentParts.month - 1, currentParts.day + 1))
    const nextParts = getZonedParts(nextDay, timeZone)
    return zonedTimeToDate(nextParts.year, nextParts.month, nextParts.day, hour, minute, timeZone)
}

function randomJitter(safeMin: number, safeMax: number): number {
    return safeMax === safeMin ? safeMin : helpers.randomNumber(safeMin, safeMax)
}

function zonedTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute)
    const guessedParts = getZonedParts(new Date(utcGuess), timeZone)
    const guessedAsUtc = Date.UTC(
        guessedParts.year,
        guessedParts.month - 1,
        guessedParts.day,
        guessedParts.hour,
        guessedParts.minute,
        guessedParts.second
    )
    const offset = guessedAsUtc - utcGuess

    return new Date(utcGuess - offset)
}
