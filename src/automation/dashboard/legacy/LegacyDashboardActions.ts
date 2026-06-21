import type { AxiosRequestConfig } from 'axios'
import type { Page } from 'patchright'

import type { MicrosoftRewardsBot } from '../../../index'
import { URLS } from '../../DashboardSelectors'
import type { DashboardActions, ReportActivityParams } from '../DashboardActions'

/**
 * LEGACY (ASP.NET) dashboard report strategy.
 *
 * All legacy network code lives here — this is the ONLY legacy report path in the
 * public bot. It uses axios + the `__RequestVerificationToken` extracted at login
 * (`bot.requestToken`). When Microsoft drops the legacy dashboard, deleting this
 * folder (plus the legacy branch in DashboardActionsFactory) removes it cleanly.
 *
 * Ground truth: the legacy-only reference bot (Microsoft-Rewards-Script).
 */
export class LegacyDashboardActions implements DashboardActions {
    public readonly variant = 'legacy' as const

    private readonly bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    private cookieHeader(): string {
        return this.bot.browser.func.buildCookieHeader(
            this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
            ['bing.com', 'live.com', 'microsoftonline.com']
        )
    }

    /**
     * UrlReward / FindClippy / DoubleSearch / SearchOnBing activation.
     * POST form to `rewards.bing.com/api/reportactivity` with the CSRF token.
     */
    async reportActivity(_page: Page | null, params: ReportActivityParams): Promise<boolean> {
        try {
            const formData = new URLSearchParams({
                id: params.offerId,
                hash: params.hash,
                timeZone: this.bot.userData.timezoneOffset,
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: params.type !== undefined ? String(params.type) : '',
                __RequestVerificationToken: this.bot.requestToken
            })

            const request: AxiosRequestConfig = {
                url: URLS.reportActivity,
                method: 'POST',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.cookieHeader(),
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                },
                data: formData
            }

            const response = await this.bot.axios.request(request)
            return response.status >= 200 && response.status < 400
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LEGACY-REPORT-ACTIVITY',
                `Error reporting activity | offerId=${params.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    /**
     * One quiz report iteration. POST JSON to `www.bing.com/bingqa/ReportActivity`.
     */
    async reportQuizOnce(_page: Page | null, params: ReportActivityParams): Promise<boolean> {
        try {
            const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete fingerprintHeaders['Cookie']
            delete fingerprintHeaders['cookie']

            const jsonData = {
                UserId: null,
                timeZone: this.bot.userData.timezoneOffset,
                OfferId: params.offerId,
                ActivityCount: 1,
                QuestionIndex: '-1'
            }

            const request: AxiosRequestConfig = {
                url: 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    cookie: this.cookieHeader(),
                    ...fingerprintHeaders
                },
                data: JSON.stringify(jsonData)
            }

            const response = await this.bot.axios.request(request)
            return response.status >= 200 && response.status < 400
        } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status
            // The bingqa endpoint returns HTTP 400 for offers it does not credit on
            // the legacy dashboard (e.g. Global_DailySet_* and pollscenarioid polls).
            // This is expected and matches the reference bot, which swallows it inside
            // its quiz loop. Treat as "no points, move on" — not a hard error.
            if (status === 400) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LEGACY-REPORT-QUIZ',
                    `bingqa returned 400 (offer not creditable via quiz endpoint) | offerId=${params.offerId}`
                )
                return false
            }
            this.bot.logger.error(
                this.bot.isMobile,
                'LEGACY-REPORT-QUIZ',
                `Error reporting quiz | offerId=${params.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }
}
