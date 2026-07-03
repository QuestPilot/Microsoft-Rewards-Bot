/**
 * Typed authentication errors so callers can react to specific failure modes
 * (e.g. an account ban) without fragile error-message string matching.
 */

export type AccountLockedReason =
    | 'service_abuse'   // Microsoft "serviceAbuseLandingTitle" — flagged for abuse / banned
    | 'unknown'

/**
 * Thrown when Microsoft has locked the account (the bot cannot proceed and the
 * user must remove it from the config). Detected from the account-locked landing
 * page during login. index.ts catches this to emit a dedicated `account_banned`
 * telemetry event with the run configuration that preceded the ban.
 */
export class AccountLockedError extends Error {
    readonly reason: AccountLockedReason

    constructor(message: string, reason: AccountLockedReason = 'service_abuse') {
        super(message)
        this.name = 'AccountLockedError'
        this.reason = reason
        // Restore prototype chain for `instanceof` across the transpilation target.
        Object.setPrototypeOf(this, AccountLockedError.prototype)
    }
}
