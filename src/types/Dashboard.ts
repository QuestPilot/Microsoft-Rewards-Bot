export type DashboardLogLevel = 'info' | 'warn' | 'error' | 'debug'
export type DashboardPlatform = 'MAIN' | 'MOBILE' | 'DESKTOP'

/**
 * Which Microsoft Rewards dashboard a given account/device is currently served:
 *  - 'next'   → the new Next.js / React Server Components dashboard (default).
 *  - 'legacy' → the old ASP.NET dashboard (JSON `dashboard` object + `__RequestVerificationToken`).
 *
 * The whole legacy side is isolated so it can be deleted in one pass once
 * Microsoft finishes migrating everyone. See docs/LEGACY_REMOVAL.md.
 */
export type DashboardVariant = 'next' | 'legacy'

export interface DashboardLog {
    time: string
    userName: string
    level: DashboardLogLevel
    platform: DashboardPlatform
    title: string
    message: string
}
