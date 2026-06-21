import type { Page } from 'patchright'
import type { DashboardVariant } from '../../types/Dashboard'

/**
 * Parameters for reporting a Rewards activity completion. The same shape is used
 * by both dashboard variants; each implementation reads what it needs.
 */
export interface ReportActivityParams {
    offerId: string
    hash: string
    /** Activity type. Legacy: the `type` form field. Next: forwarded to the Server Action. */
    type?: string | number
    /** Destination URL of the activity (used by the Next URL-navigation fallback / hash resolution). */
    destinationUrl?: string
    /**
     * Allow the Next strategy to fall back to navigating the destination URL when
     * the Server Action fails (UrlReward-style activities). Ignored by legacy.
     */
    allowUrlNavFallback?: boolean
}

/**
 * Variant-agnostic seam for "make Microsoft credit this activity".
 *
 * Tasks call these methods and never branch on the dashboard variant themselves.
 * Two implementations exist: {@link import('./legacy/LegacyDashboardActions')} (ASP.NET,
 * axios + `__RequestVerificationToken`) and {@link import('./next/NextDashboardActions')}
 * (Next.js, React Server Action via the browser). The active one is chosen by
 * {@link import('./DashboardActionsFactory').getDashboardActions} from `bot.dashboardVariant`.
 *
 * The task keeps all orchestration (balance polling, quiz loop, logging); only the
 * single network "report" call goes through this seam.
 */
export interface DashboardActions {
    readonly variant: DashboardVariant

    /**
     * Report a generic activity completion (UrlReward, FindClippy, Poll-as-url,
     * Double Search Points activation, Search-on-Bing activation).
     * Returns true when the report path executed (the caller then verifies the
     * balance delta), false when no report could be attempted.
     */
    reportActivity(page: Page | null, params: ReportActivityParams): Promise<boolean>

    /**
     * Report ONE quiz iteration. The retry loop stays in the Quiz task; this method
     * performs a single report and returns whether the report call succeeded.
     */
    reportQuizOnce(page: Page | null, params: ReportActivityParams): Promise<boolean>
}
