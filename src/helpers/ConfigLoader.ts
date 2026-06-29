import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs'
import type { Cookie } from 'patchright'
import path from 'path'

import type { Account, ConfigSaveFingerprint } from '../types/Account'
import type { Config } from '../types/Config'
import type { DashboardVariant } from '../types/Dashboard'
import { writeJsonAtomic } from './AtomicFile'
import { validateAccounts, validateConfig } from './SchemaValidator'

const { createAccountStorage } = require('../../scripts/account-storage') as {
    createAccountStorage(options: { root: string }): { readAccounts(): Account[]; encryptedPath: string }
}

let configCache: Config

function isEphemeralRun(): boolean {
    return process.env.MSRB_EPHEMERAL_RUN === '1'
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function readJsonFile<T>(filePath: string, label: string): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    } catch (error) {
        throw new Error(
            `[CONFIG] Could not read ${label} at ${path.relative(process.cwd(), filePath)}: ${errorMessage(error)}`
        )
    }
}

async function readJsonFileAsync<T>(filePath: string, label: string): Promise<T> {
    try {
        return JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as T
    } catch (error) {
        throw new Error(
            `[CONFIG] Could not read ${label} at ${path.relative(process.cwd(), filePath)}: ${errorMessage(error)}`
        )
    }
}

function getSessionDir(sessionPath: string, email: string): string {
    return path.resolve(process.cwd(), sessionPath, email)
}

function resolveSessionFile(sessionPath: string, email: string, fileName: string): string {
    return path.join(getSessionDir(sessionPath, email), fileName)
}

function resolveFirstExistingFile(candidates: string[], label: string): string {
    const primaryCandidate = candidates[0]

    for (const candidate of candidates) {
        const candidatePath = path.join(__dirname, '../', candidate)

        if (fs.existsSync(candidatePath)) {
            if (candidate !== primaryCandidate) {
                console.warn(`[CONFIG] ${primaryCandidate} not found, using ${candidate}`)
            }

            return candidatePath
        }
    }

    throw new Error(`[CONFIG] Missing ${label}. Expected one of: ${candidates.join(', ')}`)
}

export function loadAccounts(): Account[] {
    try {
        if (!process.argv.includes('-dev')) {
            const projectRoot = path.resolve(__dirname, '../..')
            const storage = createAccountStorage({ root: projectRoot })
            if (fs.existsSync(storage.encryptedPath) || fs.existsSync(path.join(projectRoot, 'src', 'accounts.json'))) {
                const accountsData = storage.readAccounts()
                return validateAccounts(accountsData)
            }
        }

        const accountCandidates = process.argv.includes('-dev')
            ? ['accounts.dev.json', 'accounts.json', 'accounts.example.json']
            : ['accounts.json', 'accounts.example.json']

        const accountDir = resolveFirstExistingFile(accountCandidates, 'accounts file')
        const accountsData = readJsonFile<Account[]>(accountDir, 'accounts file')

        return validateAccounts(accountsData)
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

/**
 * Resolve the active config file path the SAME way {@link loadConfig} does
 * (`config.json`, else `config.example.json`). Callers that need to rewrite the
 * config on disk (e.g. the Desk capture toggle) must use this rather than
 * hardcoding `src/config.json`, which is wrong once the bot runs from `dist/`.
 */
export function resolveConfigPath(): string {
    return resolveFirstExistingFile(['config.json', 'config.example.json'], 'config file')
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        const configDir = resolveConfigPath()
        const configData = readJsonFile<unknown>(configDir, 'config file')

        // Cache the PARSED schema output so the schema's `.default()`s and coercions
        // are authoritative (e.g. doApplyCoupons/doPunchCards default true). ConfigSchema
        // is `.passthrough()`, so unknown top-level keys such as `plugins` survive — which
        // is why caching the parsed result (instead of the raw JSON) no longer drops them.
        configCache = validateConfig(configData)

        return configCache
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

export interface StorageOrigin {
    origin: string
    localStorage: Array<{ name: string; value: string }>
}

export async function loadSessionData(
    sessionPath: string,
    email: string,
    saveFingerprint: ConfigSaveFingerprint,
    isMobile: boolean
) {
    try {
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'
        const cookieFile = resolveSessionFile(sessionPath, email, cookiesFileName)

        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            cookies = await readJsonFileAsync<Cookie[]>(cookieFile, cookiesFileName)
        }

        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        const fingerprintFile = resolveSessionFile(sessionPath, email, fingerprintFileName)

        let fingerprint!: BrowserFingerprintWithHeaders
        const shouldLoadFingerprint = isMobile ? saveFingerprint.mobile : saveFingerprint.desktop
        if (shouldLoadFingerprint && fs.existsSync(fingerprintFile)) {
            fingerprint = await readJsonFileAsync<BrowserFingerprintWithHeaders>(fingerprintFile, fingerprintFileName)
        }

        // Load localStorage/sessionStorage data
        const storageFileName = isMobile ? 'session_storage_mobile.json' : 'session_storage_desktop.json'
        const storageFile = resolveSessionFile(sessionPath, email, storageFileName)

        let storageState: StorageOrigin[] | undefined
        if (fs.existsSync(storageFile)) {
            storageState = await readJsonFileAsync<StorageOrigin[]>(storageFile, storageFileName)
        }

        return {
            cookies: cookies,
            fingerprint: fingerprint,
            storageState: storageState
        }
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

export async function saveSessionData(
    sessionPath: string,
    cookies: Cookie[],
    email: string,
    isMobile: boolean
): Promise<string> {
    if (isEphemeralRun()) return getSessionDir(sessionPath, email)
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await writeJsonAtomic(path.join(sessionDir, cookiesFileName), cookies, 0)

        return sessionDir
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

export async function saveFingerprintData(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    fingerpint: BrowserFingerprintWithHeaders
): Promise<string> {
    if (isEphemeralRun()) return getSessionDir(sessionPath, email)
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await writeJsonAtomic(path.join(sessionDir, fingerprintFileName), fingerpint, 0)

        return sessionDir
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

export async function saveStorageState(
    sessionPath: string,
    storageState: StorageOrigin[],
    email: string,
    isMobile: boolean
): Promise<void> {
    if (isEphemeralRun()) return
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const storageFileName = isMobile ? 'session_storage_mobile.json' : 'session_storage_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await writeJsonAtomic(path.join(sessionDir, storageFileName), storageState, 0)
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

/**
 * Persist the last-detected dashboard variant per device for an account, at
 * `sessions/<email>/dashboard-variant.json`. This is a COSMETIC hint consumed only
 * by the Rewards Desk (to badge auto-detected accounts as ASP/NEW) — the bot's own
 * logic never reads it back, so failures are swallowed and never block login. The
 * other device's value is preserved (mobile/desktop runs persist independently).
 *
 * Removable with legacy support: a single-variant future drops the ASP badge.
 */
export async function saveDashboardVariant(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    variant: DashboardVariant
): Promise<void> {
    if (isEphemeralRun()) return
    try {
        const sessionDir = getSessionDir(sessionPath, email)
        const file = path.join(sessionDir, 'dashboard-variant.json')

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        let current: { mobile?: DashboardVariant | null; desktop?: DashboardVariant | null; updatedAt?: string } = {}
        if (fs.existsSync(file)) {
            try {
                current = JSON.parse(await fs.promises.readFile(file, 'utf-8'))
            } catch {
                current = {}
            }
        }

        if (isMobile) current.mobile = variant
        else current.desktop = variant
        current.updatedAt = new Date().toISOString()

        await writeJsonAtomic(file, current, 0)
    } catch {
        // Cosmetic Desk hint only — never fail login over it.
    }
}
