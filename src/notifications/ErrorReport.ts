import { sendBotErrorReport } from './DiscordWebhook'
import { getPackageMetadata } from '../helpers/PackageMetadata'

export type ErrorReportKind = 'account_failed' | 'account_zero_points' | 'run_fatal' | 'account_banned'

export interface ErrorReportInput {
    kind: ErrorReportKind
    email?: string
    error?: string
    hasCore: boolean
    coreVersion?: string
    durationSeconds?: number
}

function maskEmail(email: string): string {
    const at = email.indexOf('@')
    if (at < 0) return '***'
    const user = email.slice(0, at)
    const visible = Math.min(2, user.length)
    return `${user.slice(0, visible)}***${email.slice(at)}`
}

/**
 * Remove anything account-identifying or secret before a report leaves the machine:
 * emails, license keys, and key=value secrets (token/password/cookie/secret). The
 * result is also length-capped to keep the relay payload small.
 */
export function redact(text: string): string {
    return text
        // Mask any email address
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, m => maskEmail(m))
        // Mask Core license keys
        .replace(/MSRB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/gi, 'MSRB-****-****-****-****')
        // Mask key=value / key:value credential pairs
        .replace(/(token|password|secret|cookie|authorization|bearer|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=[redacted]')
        // Mask IPv4 addresses (could be proxy or home IP)
        .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
        // Mask URLs (could contain credentials or proxy addresses)
        .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
        // Mask absolute file paths that expose the OS username
        .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
        .replace(/\/home\/[^\s"']+/g, '[path]')
        .replace(/\/Users\/[^\s"']+/g, '[path]')
        .slice(0, 800)
}

/**
 * Best-effort anonymous failure report to the maintainer inbox (same Core-API
 * relay → Discord channel as the in-app feedback system). It is gated by the
 * single `analytics.enabled` switch at the call site, so there is no per-feature
 * config here. Never throws and never blocks the run — delivery failures are
 * surfaced by the underlying relay logger, not here.
 */
export async function reportError(input: ErrorReportInput): Promise<void> {
    try {
        const pkg = getPackageMetadata()
        await sendBotErrorReport({
            kind: input.kind,
            account: input.email ? maskEmail(input.email) : undefined,
            error: input.error ? redact(input.error) : undefined,
            botVersion: pkg.version,
            coreVersion: input.coreVersion,
            hasCore: input.hasCore,
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            durationSeconds: input.durationSeconds
        })
    } catch {
        // Reporting must never affect the run.
    }
}
