import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs'
import type { Cookie } from 'patchright'
import path from 'path'

import type { Account, ConfigSaveFingerprint } from '../types/Account'
import type { Config } from '../types/Config'
import { writeJsonAtomic } from './AtomicFile'
import { validateAccounts, validateConfig } from './SchemaValidator'

const { createAccountStorage } = require('../../scripts/account-storage') as {
    createAccountStorage(options: { root: string }): { readAccounts(): Account[]; encryptedPath: string }
}

let configCache: Config

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function readJsonFile<T>(filePath: string, label: string): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    } catch (error) {
        throw new Error(`[CONFIG] Could not read ${label} at ${path.relative(process.cwd(), filePath)}: ${errorMessage(error)}`)
    }
}

async function readJsonFileAsync<T>(filePath: string, label: string): Promise<T> {
    try {
        return JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as T
    } catch (error) {
        throw new Error(`[CONFIG] Could not read ${label} at ${path.relative(process.cwd(), filePath)}: ${errorMessage(error)}`)
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
                validateAccounts(accountsData)
                return accountsData
            }
        }

        const accountCandidates = process.argv.includes('-dev')
            ? ['accounts.dev.json', 'accounts.json', 'accounts.example.json']
            : ['accounts.json', 'accounts.example.json']

        const accountDir = resolveFirstExistingFile(accountCandidates, 'accounts file')
        const accountsData = readJsonFile<Account[]>(accountDir, 'accounts file')

        validateAccounts(accountsData)

        return accountsData
    } catch (error) {
        throw new Error(errorMessage(error))
    }
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        const configDir = resolveFirstExistingFile(['config.json', 'config.example.json'], 'config file')
        const configData = readJsonFile<Config>(configDir, 'config file')
        validateConfig(configData)

        configCache = configData

        return configData
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
