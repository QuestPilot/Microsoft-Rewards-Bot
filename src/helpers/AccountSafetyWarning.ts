import fs from 'fs'
import path from 'path'
import { writeJsonAtomic } from './AtomicFile'

export const ACCOUNT_SAFETY_WARNING_THRESHOLD = 4
export const ACCOUNT_SAFETY_WARNING_SUPPRESSION_DAYS = 30

const ACCOUNT_SAFETY_WARNING_SUPPRESSION_MS = ACCOUNT_SAFETY_WARNING_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000
const ACCOUNT_SAFETY_WARNING_STATE_DIR = '.tools'
const ACCOUNT_SAFETY_WARNING_STATE_FILE = 'account-safety-warning.json'

export type AccountSafetyWarningSuppressionMode = 'temporary' | 'permanent'

export interface AccountSafetyWarningState {
    version: 1
    dismissedAt: string
    mode: AccountSafetyWarningSuppressionMode
    expiresAt?: string
}

export function getAccountSafetyWarningStatePath(rootDir = process.cwd()): string {
    return path.resolve(rootDir, ACCOUNT_SAFETY_WARNING_STATE_DIR, ACCOUNT_SAFETY_WARNING_STATE_FILE)
}

export function createAccountSafetyWarningState(
    dismissedAt = new Date(),
    mode: AccountSafetyWarningSuppressionMode = 'temporary'
): AccountSafetyWarningState {
    const dismissedAtIso = dismissedAt.toISOString()

    if (mode === 'permanent') {
        return {
            version: 1,
            dismissedAt: dismissedAtIso,
            mode
        }
    }

    return {
        version: 1,
        dismissedAt: dismissedAtIso,
        mode,
        expiresAt: new Date(dismissedAt.getTime() + ACCOUNT_SAFETY_WARNING_SUPPRESSION_MS).toISOString()
    }
}

export function isAccountSafetyWarningSuppressed(
    state: AccountSafetyWarningState | null | undefined,
    now = new Date()
): boolean {
    if (!state) return false
    if (state.version !== 1) return false
    if (state.mode === 'permanent') return true
    if (typeof state.expiresAt !== 'string') return false

    const expiresAt = Date.parse(state.expiresAt)
    if (Number.isNaN(expiresAt)) return false

    return expiresAt > now.getTime()
}

export async function readAccountSafetyWarningState(
    filePath = getAccountSafetyWarningStatePath()
): Promise<AccountSafetyWarningState | null> {
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8')
        const value = JSON.parse(raw) as unknown

        if (isAccountSafetyWarningState(value)) {
            return value
        }
    } catch {
        await clearAccountSafetyWarningState(filePath).catch(() => {})
        return null
    }

    await clearAccountSafetyWarningState(filePath).catch(() => {})
    return null
}

export async function writeAccountSafetyWarningState(
    state: AccountSafetyWarningState,
    filePath = getAccountSafetyWarningStatePath()
): Promise<void> {
    await writeJsonAtomic(filePath, state)
}

export async function clearAccountSafetyWarningState(filePath = getAccountSafetyWarningStatePath()): Promise<void> {
    try {
        await fs.promises.unlink(filePath)
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error
        }
    }
}

function isAccountSafetyWarningState(value: unknown): value is AccountSafetyWarningState {
    if (!value || typeof value !== 'object') return false

    const candidate = value as Partial<AccountSafetyWarningState>
    if (candidate.version !== 1) return false
    if (typeof candidate.dismissedAt !== 'string') return false
    if (candidate.mode !== 'temporary' && candidate.mode !== 'permanent') return false
    if (candidate.mode === 'temporary' && typeof candidate.expiresAt !== 'string') return false

    return true
}

function isMissingFileError(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
    )
}
