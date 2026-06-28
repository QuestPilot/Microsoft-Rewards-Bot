import fs from 'fs/promises'
import path from 'path'

const DATA_DIR = 'data'
const MAX_AGE_DAYS = 90
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export function dataRoot(): string {
    return path.resolve(process.cwd(), DATA_DIR)
}

export function dataPath(...segments: string[]): string {
    return path.join(dataRoot(), ...segments)
}

export function todayDateString(): string {
    return new Date().toISOString().slice(0, 10)
}

/** data/run-summary/ */
export function runSummaryDir(): string {
    return dataPath('run-summary')
}

/** data/run-health/ */
export function runHealthDir(): string {
    return dataPath('run-health')
}

/** data/state/ */
export function stateDir(): string {
    return dataPath('state')
}

/**
 * Removes data older than 90 days from managed subdirectories.
 * Safe to call on every bot startup — errors are swallowed so they never block the run.
 */
export async function runDataCleanup(log?: (msg: string) => void): Promise<void> {
    const info = log ?? (() => undefined)
    const cutoff = Date.now() - MAX_AGE_MS

    await cleanupJsonlByDate(dataPath('run-summary', 'accounts.jsonl'), cutoff, info)
    await cleanupJsonlByDate(dataPath('run-summary', 'notifications.jsonl'), cutoff, info)
    await cleanupHealthHistory(dataPath('run-health', 'history.json'), cutoff, info)
    await cleanupDateJsonFiles(dataPath('stats', 'daily'), cutoff, info)
    await cleanupDateJsonFiles(dataPath('stats', 'searches'), cutoff, info)
}

/** Filters a JSONL file, keeping only entries newer than cutoff. Reads createdAt or recordedAt field. */
async function cleanupJsonlByDate(filePath: string, cutoff: number, info: (msg: string) => void): Promise<void> {
    let raw: string
    try {
        raw = await fs.readFile(filePath, 'utf8')
    } catch {
        return
    }

    const lines = raw.split('\n').filter(l => l.trim())
    const kept: string[] = []
    let removed = 0

    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as Record<string, unknown>
            const ts = String(entry.createdAt || entry.recordedAt || '')
            const time = ts ? new Date(ts).getTime() : NaN
            if (!Number.isNaN(time) && time < cutoff) {
                removed++
                continue
            }
        } catch {
            // Keep malformed lines (don't delete unexpected content)
        }
        kept.push(line)
    }

    if (removed > 0) {
        try {
            await fs.writeFile(filePath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
            info(`[DATA-CLEANUP] Removed ${removed} old entries from ${filePath}`)
        } catch {
            // non-critical
        }
    }
}

/** Deletes YYYY-MM-DD.json (or .jsonl) files in a flat directory whose date is older than cutoff. */
async function cleanupDateJsonFiles(dir: string, cutoff: number, info: (msg: string) => void): Promise<void> {
    let entries: string[]
    try {
        entries = await fs.readdir(dir)
    } catch {
        return
    }

    for (const entry of entries) {
        const match = entry.match(/^(\d{4}-\d{2}-\d{2})\.(json|jsonl)$/)
        if (!match || !match[1]) continue
        const entryTime = new Date(match[1]).getTime()
        if (!Number.isNaN(entryTime) && entryTime < cutoff) {
            try {
                await fs.rm(path.join(dir, entry), { force: true })
                info(`[DATA-CLEANUP] Removed old file: ${path.join(dir, entry)}`)
            } catch {
                // non-critical
            }
        }
    }
}

/** Filters run-health history.json, keeping only entries newer than cutoff. */
async function cleanupHealthHistory(filePath: string, cutoff: number, info: (msg: string) => void): Promise<void> {
    let raw: string
    try {
        raw = await fs.readFile(filePath, 'utf8')
    } catch {
        return
    }

    let history: Array<Record<string, unknown>>
    try {
        const parsed = JSON.parse(raw) as unknown
        history = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
    } catch {
        return
    }

    const kept = history.filter(entry => {
        const ts = String(entry.recordedAt || entry.createdAt || '')
        const time = ts ? new Date(ts).getTime() : NaN
        return Number.isNaN(time) || time >= cutoff
    })

    if (kept.length < history.length) {
        try {
            await fs.writeFile(filePath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8')
            info(`[DATA-CLEANUP] Removed ${history.length - kept.length} old entries from ${filePath}`)
        } catch {
            // non-critical
        }
    }
}
