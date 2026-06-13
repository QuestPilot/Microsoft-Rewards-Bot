import type { AxiosRequestConfig } from 'axios'
import type { BrowserContext, Cookie, Page } from 'patchright'

import type { StorageOrigin } from '../helpers/ConfigLoader'
import { saveSessionData, saveStorageState } from '../helpers/ConfigLoader'
import type { MicrosoftRewardsBot } from '../index'

import type { AppDashboardData } from '../types/AppDashboardData'
import type { AppUserData } from '../types/AppUserData'
import type { Counters, DashboardData } from '../types/DashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../types/Points'
import type { XboxDashboardData } from '../types/XboxDashboardData'
import { URLS } from './DashboardSelectors'

export default class PageController {
    private bot: MicrosoftRewardsBot
    private static readonly BROWSER_CLOSE_TIMEOUT_MS = 10_000

    /**
     * Once the legacy JSON dashboard API (`/api/getuserinfo`) fails, Microsoft has
     * almost certainly migrated the account to the Next.js dashboard for this session.
     * Re-hitting the dead endpoint on every points lookup wastes axios retries and
     * floods the logs with identical warnings, so we remember the outage and route
     * straight to the HTML dashboard for the remainder of the run.
     */
    private dashboardApiUnavailable = false

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Fetch user desktop dashboard data.
     *
     * Primary path: JSON API at rewards.bing.com/api/getuserinfo?type=1
     * Fallback path: Parse dashboard HTML – supports both the legacy
     *   `var dashboard = {...}` embed AND the new Next.js SPA
     *   (`self.__next_f.push` hydration chunks).
     *
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(): Promise<DashboardData> {
        // Skip the legacy JSON API entirely once it has failed this session (Next.js migration).
        if (!this.dashboardApiUnavailable) {
            try {
                const request: AxiosRequestConfig = {
                    url: URLS.dashboardApi,
                    method: 'GET',
                    timeout: 15_000,
                    'axios-retry': { retries: 2 },
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                            'bing.com',
                            'live.com',
                            'microsoftonline.com'
                        ]),
                        Referer: 'https://rewards.bing.com/',
                        Origin: 'https://rewards.bing.com'
                    }
                } as AxiosRequestConfig & { 'axios-retry'?: { retries: number } }

                const response = await this.bot.axios.request(request)

                if (response.data?.dashboard) {
                    return response.data.dashboard as DashboardData
                }
                throw new Error('Dashboard data missing from API response')
            } catch {
                this.dashboardApiUnavailable = true
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    'Direct JSON API unavailable (account migrated to Next.js dashboard) — using HTML parser for the rest of this session'
                )
            }
        }

            try {
                const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                await page
                    .goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
                    .catch(() => {})
                const html = await page.content()
                return this.parseDashboardHtml(html)
            } catch (fallbackError) {
                this.bot.logger.error(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Failed to get dashboard data')
                throw fallbackError
            }
        return this.getDashboardDataFromHtml()
    }

    /**
     * Recover dashboard data without the legacy JSON API: first by fetching the
     * dashboard HTML over axios, then (if that fails) by reading the already-open
     * browser page. Both paths feed {@link parseDashboardHtml}.
     */
    private async getDashboardDataFromHtml(): Promise<DashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: this.bot.config.baseURL,
                method: 'GET',
                timeout: 15_000,
                'axios-retry': { retries: 2 },
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.buildCookieHeader(this.bot.cookies.mobile),
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            } as AxiosRequestConfig & { 'axios-retry'?: { retries: number } }

            const response = await this.bot.axios.request(request)
            return this.parseDashboardHtml(String(response.data))
        } catch {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                'HTML fetch failed, trying browser session fallback'
            )
        }

        try {
            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
            await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            const html = await page.content()
            return this.parseDashboardHtml(html)
        } catch (fallbackError) {
            this.bot.logger.error(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Failed to get dashboard data')
            throw fallbackError
        }
    }

    private parseDashboardHtml(html: string): DashboardData {
        const legacyMatch = html.match(/var\s+dashboard\s*=\s*({.*?});/s)
        if (legacyMatch?.[1]) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                'Extracted dashboard data from legacy HTML embed'
            )
            return JSON.parse(legacyMatch[1]) as DashboardData
        }

        const nextData = this.extractNextData(html)
        if (nextData) {
            const parsed = this.findDashboardData(nextData)
            if (parsed) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    'Extracted dashboard data from Next.js data script'
                )
                return parsed
            }
        }

        for (const chunk of this.extractNextFlightChunks(html)) {
            const parsed = this.findDashboardData(chunk)
            if (parsed) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'GET-DASHBOARD-DATA',
                    'Extracted dashboard data from Next.js hydration chunk'
                )
                return parsed
            }
        }

        const rewardsNextData = this.buildDashboardDataFromRewardsNextHtml(html)
        if (rewardsNextData) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                'Extracted minimal dashboard data from Rewards Next.js RSC models'
            )
            return rewardsNextData
        }

        throw new Error('Dashboard data not found in HTML (tried legacy embed + Next.js chunks)')
    }

    private extractNextData(html: string): string | null {
        const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/s)
        return match?.[1] ? this.decodeHtmlEntities(match[1]) : null
    }

    private extractNextFlightChunks(html: string): string[] {
        const chunks: string[] = []
        const marker = 'self.__next_f.push('
        let searchFrom = 0

        while (searchFrom < html.length) {
            const start = html.indexOf(marker, searchFrom)
            if (start === -1) break

            const argsStart = start + marker.length
            const argsEnd = this.findBalancedEnd(html, argsStart - 1, '(', ')')
            if (argsEnd === -1) {
                searchFrom = argsStart
                continue
            }

            const callArgs = html.slice(argsStart, argsEnd)
            const decoded = this.decodeNextFlightCall(callArgs)
            if (decoded) chunks.push(decoded)
            searchFrom = argsEnd + 1
        }

        return chunks
    }

    private decodeNextFlightCall(callArgs: string): string | null {
        try {
            const parsed = JSON.parse(callArgs) as unknown
            if (!Array.isArray(parsed)) return null

            return parsed.filter((part): part is string => typeof part === 'string').join('\n')
        } catch {
            const stringValues: string[] = []
            const stringPattern = /"((?:\\.|[^"\\])*)"/gs

            for (const match of callArgs.matchAll(stringPattern)) {
                if (!match[1]) continue
                try {
                    stringValues.push(JSON.parse(`"${match[1]}"`) as string)
                } catch {
                    stringValues.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
                }
            }

            return stringValues.length > 0 ? stringValues.join('\n') : null
        }
    }

    private findDashboardData(text: string): DashboardData | null {
        const normalized = this.decodeHtmlEntities(text)
        const markers = ['"userStatus"', '\\"userStatus\\"', 'userStatus']

        for (const marker of markers) {
            let markerIndex = normalized.indexOf(marker)
            while (markerIndex !== -1) {
                const parsed = this.parseObjectContainingMarker(normalized, markerIndex)
                if (parsed?.userStatus) return parsed as unknown as DashboardData
                markerIndex = normalized.indexOf(marker, markerIndex + marker.length)
            }
        }

        return null
    }

    private buildDashboardDataFromRewardsNextHtml(html: string): DashboardData | null {
        const flightText = this.extractNextFlightChunks(html).join('\n')
        if (!flightText || !/"dailySetItems"|"balance"|"country"/.test(flightText)) return null

        const availablePoints = this.readNumberFromText(flightText, 'balance') ?? 0
        const country = this.readStringFromText(flightText, 'country') ?? 'us'
        const dailySetPromotions = this.extractRewardsNextDailySetPromotions(flightText)
        const morePromotions = this.extractRewardsNextOfferPromotions(flightText)

        return {
            userStatus: {
                availablePoints,
                counters: {
                    pcSearch: [],
                    mobileSearch: [],
                    activityAndQuiz: [],
                    dailyPoint: []
                }
            },
            dailySetPromotions,
            morePromotions,
            morePromotionsWithoutPromotionalItems: [],
            promotionalItems: [],
            userProfile: {
                attributes: {
                    country
                }
            }
        } as unknown as DashboardData
    }

    private extractRewardsNextDailySetPromotions(text: string): DashboardData['dailySetPromotions'] {
        const grouped: Record<string, unknown[]> = {}

        for (const items of this.extractJsonArraysAfterKey(text, 'dailySetItems')) {
            for (const item of items) {
                if (!this.isRecord(item)) continue
                const offerId = this.stringValue(item.offerId)
                const hash = this.stringValue(item.hash)
                const date = this.stringValue(item.date)
                if (!offerId || !hash || !date) continue

                const promotion = this.createRewardsNextPromotion(item)
                grouped[date] = grouped[date] ?? []
                grouped[date]!.push(promotion)
            }
        }

        return grouped as DashboardData['dailySetPromotions']
    }

    private extractRewardsNextOfferPromotions(text: string): DashboardData['morePromotions'] {
        const promotions = new Map<string, DashboardData['morePromotions'][number]>()
        const offerMatches = text.matchAll(/"offerId"\s*:\s*"([^"]+)"/g)

        for (const match of offerMatches) {
            if (match.index === undefined || !match[1] || promotions.has(match[1])) continue

            const objectStart = text.lastIndexOf('{', match.index)
            if (objectStart === -1) continue

            const objectEnd = this.findBalancedEnd(text, objectStart, '{', '}')
            if (objectEnd === -1 || objectEnd < match.index) continue

            const parsed = this.parseJsonLike(text.slice(objectStart, objectEnd + 1))
            if (!this.isRecord(parsed)) continue

            const offerId = this.stringValue(parsed.offerId)
            const hash = this.stringValue(parsed.hash)
            const destination = this.stringValue(parsed.destination)
            if (!offerId || !hash || !destination) continue

            promotions.set(offerId, this.createRewardsNextPromotion(parsed))
        }

        return [...promotions.values()]
    }

    private createRewardsNextPromotion(item: Record<string, unknown>): DashboardData['morePromotions'][number] {
        const points = this.numberValue(item.points)
        const completed = this.booleanValue(item.isCompleted)
        const destination = this.stringValue(item.destination)
        const title = this.stringValue(item.title)
        const description = this.stringValue(item.description)
        const offerId = this.stringValue(item.offerId)
        const hash = this.stringValue(item.hash)
        const name = this.stringValue(item.name) ?? offerId ?? ''
        const promotionType = this.inferRewardsNextPromotionType(destination, title)
        const pointProgress = completed ? points : 0

        return {
            name,
            offerId,
            hash,
            title: title ?? '',
            description: description ?? title ?? '',
            destinationUrl: destination ?? '',
            promotionType,
            complete: completed,
            pointProgress,
            pointProgressMax: points,
            activityProgress: pointProgress,
            activityProgressMax: points,
            exclusiveLockedFeatureStatus: 'unlocked'
        } as unknown as DashboardData['morePromotions'][number]
    }

    private inferRewardsNextPromotionType(destination?: string, title?: string): string {
        const value = `${destination ?? ''} ${title ?? ''}`.toLowerCase()
        if (value.includes('findclippy')) return 'findclippy'
        if (value.includes('pollscenarioid')) return 'quiz'
        return 'urlreward'
    }

    private extractJsonArraysAfterKey(text: string, key: string): unknown[][] {
        const arrays: unknown[][] = []
        const marker = `"${key}":[`
        let searchFrom = 0

        while (searchFrom < text.length) {
            const markerIndex = text.indexOf(marker, searchFrom)
            if (markerIndex === -1) break

            const start = markerIndex + `"${key}":`.length
            const end = this.findBalancedEnd(text, start, '[', ']')
            if (end === -1) {
                searchFrom = markerIndex + marker.length
                continue
            }

            const parsed = this.parseJsonLike(text.slice(start, end + 1))
            if (Array.isArray(parsed)) arrays.push(parsed)
            searchFrom = end + 1
        }

        return arrays
    }

    private parseJsonLike(value: string): unknown {
        try {
            return JSON.parse(value)
        } catch {
            return null
        }
    }

    private readNumberFromText(text: string, field: string): number | null {
        const match = text.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`))
        return match?.[1] ? Number(match[1]) : null
    }

    private readStringFromText(text: string, field: string): string | null {
        const match = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`))
        return match?.[1] && match[1] !== '$undefined' ? match[1] : null
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    }

    private stringValue(value: unknown): string | undefined {
        return typeof value === 'string' && value !== '$undefined' ? value : undefined
    }

    private numberValue(value: unknown): number {
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    private booleanValue(value: unknown): boolean {
        return value === true
    }

    private parseObjectContainingMarker(text: string, markerIndex: number): Record<string, unknown> | null {
        for (let start = markerIndex; start >= 0; start--) {
            if (text[start] !== '{') continue

            const end = this.findBalancedEnd(text, start, '{', '}')
            if (end === -1 || end < markerIndex) continue

            const candidate = text.slice(start, end + 1)
            try {
                const parsed = JSON.parse(candidate) as unknown
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>
                }
            } catch {
                // Keep walking outward; flight payloads can contain nested objects before the dashboard root.
            }
        }

        return null
    }

    private findBalancedEnd(text: string, start: number, open: string, close: string): number {
        let depth = 0
        let inString = false
        let escaped = false

        for (let i = start; i < text.length; i++) {
            const char = text[i]

            if (inString) {
                if (escaped) {
                    escaped = false
                } else if (char === '\\') {
                    escaped = true
                } else if (char === '"') {
                    inString = false
                }
                continue
            }

            if (char === '"') {
                inString = true
            } else if (char === open) {
                depth++
            } else if (char === close) {
                depth--
                if (depth === 0) return i
            }
        }

        return -1
    }

    private decodeHtmlEntities(value: string): string {
        return value
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&#x22;/gi, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
    }

    /**
     * Fetch user app dashboard data
     * @returns {AppDashboardData} Object of user bing rewards dashboard data
     */
    async getAppDashboardData(): Promise<AppDashboardData> {
        try {
            if (!this.bot.accessToken) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-APP-DASHBOARD-DATA',
                    'No mobile access token available, skipping app dashboard data'
                )
                return this.emptyAppDashboardData()
            }

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAIOS&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            return this.emptyAppDashboardData()
        }
    }

    /**
     * Fetch user xbox dashboard data
     * @returns {XboxDashboardData} Object of user bing rewards dashboard data
     */
    async getXBoxDashboardData(): Promise<XboxDashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=xboxapp&options=6',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One X) AppleWebKit/537.36 (KHTML, like Gecko) Edge/18.19041'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as XboxDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-XBOX-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Get search point counters
     */
    async getSearchPoints(): Promise<Counters> {
        const dashboardData = await this.getDashboardData() // Always fetch newest data

        return dashboardData.userStatus.counters
    }

    missingSearchPoints(counters: Counters, isMobile: boolean): MissingSearchPoints {
        const mobileData = counters.mobileSearch?.[0]
        const desktopData = counters.pcSearch?.[0]
        const edgeData = counters.pcSearch?.[1]

        const mobilePoints = mobileData ? Math.max(0, mobileData.pointProgressMax - mobileData.pointProgress) : 0
        const desktopPoints = desktopData ? Math.max(0, desktopData.pointProgressMax - desktopData.pointProgress) : 0
        const edgePoints = edgeData ? Math.max(0, edgeData.pointProgressMax - edgeData.pointProgress) : 0

        const totalPoints = isMobile ? mobilePoints : desktopPoints + edgePoints

        return { mobilePoints, desktopPoints, edgePoints, totalPoints }
    }

    /**
     * Whether the dashboard actually exposed usable search-point counters.
     * Microsoft's Next.js dashboard omits them; when this returns false, callers
     * fall back to a balance-driven search run instead of the counter-delta logic.
     */
    hasSearchCounters(counters: Counters): boolean {
        return (counters.pcSearch?.length ?? 0) > 0 || (counters.mobileSearch?.length ?? 0) > 0
    }

    /**
     * Get total earnable points with web browser
     */
    async getBrowserEarnablePoints(): Promise<BrowserEarnablePoints> {
        try {
            const data = await this.getDashboardData()

            const desktopSearchPoints =
                data.userStatus.counters.pcSearch?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const mobileSearchPoints =
                data.userStatus.counters.mobileSearch?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetPoints =
                data.dailySetPromotions[todayDate]?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const morePromotionsPoints =
                data.morePromotions?.reduce((sum, x) => {
                    if (
                        ['quiz', 'urlreward'].includes(x.promotionType) &&
                        x.exclusiveLockedFeatureStatus !== 'locked'
                    ) {
                        return sum + (x.pointProgressMax - x.pointProgress)
                    }
                    return sum
                }, 0) ?? 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Get total earnable points with mobile app
     */
    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            if (!this.bot.accessToken) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-APP-EARNABLE-POINTS',
                    'No mobile access token available, app-only points will be skipped'
                )
                return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
            }

            // Match by promotion `type` rather than a hardcoded offerid. The
            // read-to-earn offerid is locale-prefixed (e.g. ENUS_/FRFR_), so an
            // offerid allowlist silently excluded every non-US account. The loop
            // below already discriminates by `attrs.type`, making this the safe,
            // locale-agnostic source of truth.
            const eligibleTypes = ['msnreadearn', 'checkin']

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.axios.request(request)
            const userData: AppUserData = response.data
            const eligibleActivities = userData.response.promotions.filter(x =>
                eligibleTypes.includes(x.attributes?.type ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0')
                    const pointProgress = parseInt(attrs.pointprogress ?? '0')
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0')
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
        }
    }

    private emptyAppDashboardData(): AppDashboardData {
        return {
            response: {
                profile: {
                    ruid: '',
                    attributes: {
                        ismsaautojoined: '',
                        created: new Date(0),
                        creative: '',
                        publisher: '',
                        program: '',
                        country: '',
                        target: '',
                        epuid: '',
                        level: '',
                        level_upd: new Date(0),
                        iris_segmentation: '',
                        iris_segmentation_upd: new Date(0),
                        waitlistattributes: '',
                        waitlistattributes_upd: new Date(0)
                    },
                    offline_attributes: {}
                },
                balance: 0,
                counters: null,
                promotions: [],
                catalog: null,
                goal_item: {
                    name: '',
                    provider: '',
                    price: 0,
                    attributes: {} as AppDashboardData['response']['goal_item']['attributes'],
                    config: { isHidden: 'true' }
                },
                activities: null,
                cashback: null,
                orders: [],
                rebateProfile: null,
                rebatePayouts: null,
                giveProfile: null,
                autoRedeemProfile: null,
                autoRedeemItem: null,
                thirdPartyProfile: null,
                notifications: null,
                waitlist: null,
                autoOpenFlyout: null,
                coupons: null,
                recommendedAffordableCatalog: null,
                generativeAICreditsBalance: null,
                requestCountryCatalog: null,
                donationCatalog: null
            },
            correlationId: '',
            code: 0
        }
    }
    /**
     * Get current point amount
     * @returns {number} Current total point amount
     */
    async getCurrentPoints(): Promise<number> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'GET-CURRENT-POINTS', 'Fetching current points...')
            const data = await this.getDashboardData()
            const points = data.userStatus.availablePoints
            this.bot.logger.debug(this.bot.isMobile, 'GET-CURRENT-POINTS', `Current points: ${points}`)
            return points
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            // Return last known points instead of crashing the flow
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `Returning last known points: ${this.bot.userData.currentPoints}`
            )
            return this.bot.userData.currentPoints
        }
    }

    async closeBrowser(context: BrowserContext, email: string) {
        try {
            const cookies = await context.cookies()

            // Save cookies
            this.bot.logger.debug(
                this.bot.isMobile,
                'CLOSE-BROWSER',
                `Saving ${cookies.length} cookies to session folder!`
            )
            await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)

            // Save localStorage from all open pages (rewards.bing.com, bing.com)
            try {
                const storageOrigins: StorageOrigin[] = []
                const pages = context.pages()
                const seenOrigins = new Set<string>()

                for (const page of pages) {
                    try {
                        const url = new URL(page.url())
                        const origin = url.origin
                        if (seenOrigins.has(origin) || origin === 'about:' || origin === 'chrome:') continue
                        seenOrigins.add(origin)

                        const items: Array<{ name: string; value: string }> = await page
                            .evaluate(() => {
                                const result: Array<{ name: string; value: string }> = []
                                for (let i = 0; i < localStorage.length; i++) {
                                    const key = localStorage.key(i)
                                    if (key) {
                                        result.push({ name: key, value: localStorage.getItem(key) ?? '' })
                                    }
                                }
                                return result
                            })
                            .catch(() => [])

                        if (items.length > 0) {
                            storageOrigins.push({ origin, localStorage: items })
                        }
                    } catch {
                        // Skip pages that can't be accessed
                    }
                }

                if (storageOrigins.length > 0) {
                    await saveStorageState(this.bot.config.sessionPath, storageOrigins, email, this.bot.isMobile)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        `Saved localStorage for ${storageOrigins.length} origin(s)`
                    )
                }
            } catch (storageError) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `Could not save localStorage: ${storageError instanceof Error ? storageError.message : String(storageError)}`
                )
            }

            await this.bot.utils.wait(2000)

            await this.closeWithTimeout(() => context.close(), 'context')
            this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', 'Browser closed cleanly!')
        } catch (error) {
            await this.closeWithTimeout(() => context.close(), 'context').catch(() => {})
            this.bot.logger.error(
                this.bot.isMobile,
                'CLOSE-BROWSER',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async closeWithTimeout(close: () => Promise<void>, label: string): Promise<void> {
        let timeout: NodeJS.Timeout | undefined
        try {
            await Promise.race([
                close(),
                new Promise<void>((_, reject) => {
                    timeout = setTimeout(
                        () =>
                            reject(
                                new Error(`${label} close timed out after ${PageController.BROWSER_CLOSE_TIMEOUT_MS}ms`)
                            ),
                        PageController.BROWSER_CLOSE_TIMEOUT_MS
                    )
                })
            ])
        } finally {
            if (timeout) clearTimeout(timeout)
        }
    }

    /**
     * Report an activity completion via `fetch()` executed inside the browser page.
     *
     * The new Next.js dashboard no longer embeds a `__RequestVerificationToken`
     * in the HTML.  Instead it uses React Server Actions, making the old
     * axios-based POST with the token impossible.
     *
     * The new Next.js dashboard (React Server Components) replaced the legacy
     * `/api/reportactivity` REST endpoint with a React Server Action called
     * `reportActivity`.  This method:
     *
     * 1. Extracts the Server Action ID from loaded webpack chunks at runtime
     *    (the ID is a content hash that changes on every deployment).
     * 2. POSTs a JSON-encoded argument array to the page URL with the
     *    `Next-Action` header, matching the React Server Action protocol.
     *
     * Runs inside the Playwright page context so session cookies are attached
     * automatically — no CSRF token is needed.
     *
     * **Important**: The new Next.js dashboard uses DIFFERENT hash/offerId
     * values than the legacy `getuserinfo?type=1` API.  When `destinationUrl`
     * is provided, this method first extracts activity data from the browser's
     * RSC flight data (`__next_f`) and resolves the correct RSC hash/offerId
     * by matching the destination URL.
     *
     * @returns `true` if the Server Action returned `true`, `false` otherwise.
     */
    async reportActivityViaBrowser(
        page: Page,
        params: {
            offerId: string
            hash: string
            type?: number | string
            isPromotional?: boolean
            destinationUrl?: string
        }
    ): Promise<boolean> {
        try {
            // ── Step 1: Extract Server Action ID ──────────────────────
            // The dashboard navigates with waitUntil:'domcontentloaded',
            // so async webpack chunks may not yet be loaded when this runs.
            // Poll the global chunk array until the reportActivity module
            // appears, then fall back to fetching script sources directly.
            let actionId: string | null = null
            let actionModuleKey: string | null = null

            // ─ Primary: poll webpackChunk_N_E until chunk is registered ─
            // Also capture the webpack module key so Strategy A can force-
            // require it (the module factory may not have been executed yet).
            try {
                const handle = await page.waitForFunction(
                    () => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const chunks: any[][] = (self as any).webpackChunk_N_E ?? []
                            for (const chunk of chunks) {
                                const modules = chunk[1]
                                if (!modules || typeof modules !== 'object') continue
                                for (const key of Object.keys(modules)) {
                                    const factory = modules[key]
                                    if (typeof factory !== 'function') continue
                                    const src = factory.toString()
                                    if (!src.includes('reportActivity')) continue
                                    const m = src.match(/createServerReference\)?\s*\(\s*"([a-f0-9]+)"/)
                                    if (m?.[1]) return { actionId: m[1], moduleKey: key }
                                }
                            }
                        } catch {
                            /* chunk inspection failed */
                        }
                        return null
                    },
                    { polling: 500, timeout: 15_000 }
                )
                const extracted = (await handle.jsonValue()) as { actionId: string; moduleKey: string } | null
                if (extracted) {
                    actionId = extracted.actionId
                    actionModuleKey = extracted.moduleKey
                }
            } catch {
                // waitForFunction timed out — will try script source fallback
            }

            // ─ Fallback: fetch /_next/ script sources and search text ───
            if (!actionId) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    'Webpack chunk poll timed out, falling back to script source fetch'
                )
                actionId = await page.evaluate(async () => {
                    try {
                        const scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="/_next/"]')
                        for (const el of scripts) {
                            if (!el.src) continue
                            try {
                                const resp = await fetch(el.src)
                                const text = await resp.text()
                                if (!text.includes('reportActivity')) continue
                                const m = text.match(/createServerReference\)?\s*\(\s*"([a-f0-9]+)"/)
                                if (m?.[1]) return m[1]
                            } catch {
                                continue
                            }
                        }
                    } catch {
                        /* script fetch failed */
                    }
                    return null
                })
            }

            if (!actionId) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    `Server Action ID not found in webpack chunks or script sources | offerId=${params.offerId}`
                )
                return false
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REPORT-ACTIVITY-BROWSER',
                `Extracted Server Action ID: ${actionId.slice(0, 12)}… | moduleKey=${actionModuleKey ?? 'N/A'} | offerId=${params.offerId}`
            )

            // ── Step 1.4: Wait for RSC flight data to include the activity ──
            // React's streaming runtime consumes __next_f array entries after
            // processing, but the <script> tags that pushed them persist in
            // the DOM.  Search inline <script> textContent for the offerId.
            try {
                await page.waitForFunction(
                    (oid: string) => {
                        try {
                            const scripts = document.querySelectorAll('script:not([src])')
                            for (const script of scripts) {
                                if (script.textContent?.includes(oid)) return true
                            }
                            return false
                        } catch {
                            return false
                        }
                    },
                    params.offerId,
                    { polling: 500, timeout: 10_000 }
                )
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    `RSC flight data contains offerId | offerId=${params.offerId}`
                )
            } catch {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    `RSC flight data does not contain offerId after 10s wait | offerId=${params.offerId}`
                )
            }

            // ── Step 1.5: Resolve RSC hash/offerId from flight data ───
            // The Server Action may expect the hash from RSC flight data which
            // can differ from the API hash.  Match by offerId first (most
            // reliable), then by destination URL as fallback.
            let finalHash = params.hash
            let finalOfferId = params.offerId

            try {
                const resolved = await page.evaluate(
                    (matchArgs: { offerId: string; destinationUrl?: string }) => {
                        try {
                            // ── Primary: extract RSC data from inline <script> tags ──
                            // React's streaming runtime consumes __next_f entries after
                            // processing, but the <script> tags that called
                            //   self.__next_f.push([1,"...data..."])
                            // persist in the DOM.  Concatenate their text content and
                            // search for hash/offerId patterns.
                            const scripts = document.querySelectorAll('script:not([src])')
                            let text = ''
                            for (const script of scripts) {
                                const content = script.textContent ?? ''
                                if (content.includes('__next_f')) {
                                    text += content + '\n'
                                }
                            }

                            // ── Fallback: try __next_f array (entries may still be present) ──
                            if (!text.includes(matchArgs.offerId)) {
                                try {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const nextF = (window as any).__next_f
                                    if (Array.isArray(nextF)) {
                                        for (const entry of nextF) {
                                            if (
                                                Array.isArray(entry) &&
                                                entry[0] === 1 &&
                                                typeof entry[1] === 'string'
                                            ) {
                                                text += entry[1]
                                            }
                                        }
                                    }
                                } catch {
                                    /* __next_f fallback failed */
                                }
                            }

                            if (!text) return null

                            // Find offerId occurrence (it appears verbatim even in
                            // escaped JS strings since it's pure ASCII alphanumeric)
                            const oIdIndex = text.indexOf(matchArgs.offerId)
                            if (oIdIndex !== -1) {
                                // Extract context around the offerId (±500 chars)
                                const start = Math.max(0, oIdIndex - 500)
                                const end = Math.min(text.length, oIdIndex + matchArgs.offerId.length + 500)
                                const context = text.slice(start, end)
                                const oIdPosInContext = oIdIndex - start

                                // Find nearest hash field — works with both escaped (\") and normal (") quotes
                                // Pattern: "hash" followed by 1-10 non-hex chars then 40-64 hex chars
                                const hashRe = /hash[^a-f0-9]{1,10}([a-f0-9]{40,64})/g
                                let nearest: string | null = null
                                let nearestDist = Infinity
                                let m: RegExpExecArray | null
                                while ((m = hashRe.exec(context)) !== null) {
                                    const dist = Math.abs(m.index - oIdPosInContext)
                                    if (dist < nearestDist) {
                                        nearestDist = dist
                                        nearest = m[1] as string
                                    }
                                }
                                if (nearest) {
                                    return { hash: nearest, offerId: matchArgs.offerId }
                                }
                            }

                            // Fallback: match by destination URL
                            if (matchArgs.destinationUrl) {
                                try {
                                    const normTarget = decodeURIComponent(matchArgs.destinationUrl).toLowerCase()
                                    const targetQ = new URL(normTarget).searchParams.get('q')

                                    // Search for destination URLs near hash patterns
                                    const hashRe2 = /hash[^a-f0-9]{1,10}([a-f0-9]{40,64})/g
                                    let m2: RegExpExecArray | null
                                    while ((m2 = hashRe2.exec(text)) !== null) {
                                        const hashVal = m2[1] as string
                                        const hPos = m2.index
                                        const ctx = text.slice(
                                            Math.max(0, hPos - 200),
                                            Math.min(text.length, hPos + 500)
                                        )
                                        // Look for destination URL in context
                                        const destMatch = ctx.match(/destination[^a-z]{1,10}(https?[^"\\,\s]{10,500})/i)
                                        if (destMatch?.[1]) {
                                            try {
                                                const dest = decodeURIComponent(
                                                    destMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"')
                                                ).toLowerCase()
                                                const destQ = new URL(dest).searchParams.get('q')
                                                if (
                                                    dest === normTarget ||
                                                    normTarget.includes(dest) ||
                                                    dest.includes(normTarget) ||
                                                    (targetQ && destQ && targetQ === destQ)
                                                ) {
                                                    // Find associated offerId — ONLY return if it matches the requested one
                                                    const oidMatch = ctx.match(/offerId[^a-zA-Z]{1,10}([A-Za-z0-9_]+)/)
                                                    const foundOid = oidMatch?.[1]
                                                    if (!foundOid || foundOid === matchArgs.offerId) {
                                                        return {
                                                            hash: hashVal,
                                                            offerId: matchArgs.offerId
                                                        }
                                                    }
                                                    // Skip: this destination URL belongs to a different activity
                                                }
                                            } catch {
                                                /* URL comparison failed */
                                            }
                                        }
                                    }
                                } catch {
                                    /* destination fallback failed */
                                }
                            }

                            return null
                        } catch {
                            return null
                        }
                    },
                    { offerId: params.offerId, destinationUrl: params.destinationUrl }
                )

                if (resolved?.hash && resolved?.offerId) {
                    // Safety: never use a hash resolved for a different offerId
                    if (resolved.offerId !== params.offerId) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'REPORT-ACTIVITY-BROWSER',
                            `Ignoring RSC hash from different offerId: ${resolved.offerId} (wanted ${params.offerId})`
                        )
                    } else if (resolved.hash !== params.hash) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'REPORT-ACTIVITY-BROWSER',
                            `Resolved RSC hash: ${params.hash.slice(0, 12)}… → ${resolved.hash.slice(0, 12)}… | offerId=${resolved.offerId}`
                        )
                        finalHash = resolved.hash
                        finalOfferId = resolved.offerId
                    } else {
                        finalHash = resolved.hash
                        finalOfferId = resolved.offerId
                    }
                } else {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'REPORT-ACTIVITY-BROWSER',
                        `No RSC match in __next_f, using API hash | offerId=${params.offerId}`
                    )
                }
            } catch {
                // RSC resolution failed — continue with API values
            }

            // ── Step 2: Call the Server Action ──────────────────────
            // Strategy A (primary): Find the bound Server Action function
            //   in the webpack module cache (created by createServerReference)
            //   and call it directly.  This goes through React's callServer →
            //   router dispatch → fetchServerAction, which handles all headers,
            //   encodeReply, and router state automatically.
            //
            // Strategy B (fallback): Manual fetch replicating the RSC protocol.

            const rawType = params.type
            const parsedType =
                typeof rawType === 'string' && rawType.length > 0
                    ? parseInt(rawType, 10)
                    : typeof rawType === 'number'
                      ? rawType
                      : 11
            const finalType = Number.isFinite(parsedType) ? parsedType : 11

            // ── Strategy A: Call through webpack / React runtime ─────
            let nativeResult: { success: boolean | null; error: string | null } | null = null
            try {
                nativeResult = await page.evaluate(
                    async (args: {
                        actionId: string
                        moduleKey: string | null
                        offerId: string
                        hash: string
                        finalType: number
                        isPromotional?: boolean
                    }) => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const chunks = (self as any).webpackChunk_N_E
                            if (!Array.isArray(chunks)) return null

                            // Push a probe chunk to capture __webpack_require__
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            let __webpack_require__: any = null
                            chunks.push([
                                ['__probe_' + Date.now()],
                                {},
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                (req: any) => {
                                    __webpack_require__ = req
                                }
                            ])

                            if (!__webpack_require__) return null

                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            let actionFn: ((...a: any[]) => Promise<any>) | null = null

                            // Strategy A1: Force-require the known module.
                            // The module factory containing createServerReference may not
                            // have been executed yet (only registered as a chunk).  Calling
                            // __webpack_require__(moduleKey) runs the factory and creates
                            // the server reference function with its $$id property.
                            if (args.moduleKey && __webpack_require__) {
                                try {
                                    const mod = __webpack_require__(args.moduleKey)
                                    if (mod) {
                                        const candidates = Object.values(
                                            typeof mod === 'object' && mod !== null ? mod : { default: mod }
                                        ).filter((v): v is Function => typeof v === 'function')
                                        for (const fn of candidates) {
                                            if ((fn as any).$$id === args.actionId) {
                                                actionFn = fn as (...a: any[]) => Promise<any>
                                                break
                                            }
                                        }
                                    }
                                } catch {
                                    /* force-require failed — fall through to cache search */
                                }
                            }

                            // Strategy A2: Search the module cache (original approach)
                            if (!actionFn && __webpack_require__?.c) {
                                const cache = __webpack_require__.c
                                for (const modId of Object.keys(cache)) {
                                    const mod = cache[modId]
                                    if (!mod?.exports) continue
                                    const exps = mod.exports
                                    const candidates =
                                        typeof exps === 'function'
                                            ? [exps]
                                            : typeof exps === 'object' && exps !== null
                                              ? Object.values(exps)
                                              : []
                                    for (const fn of candidates) {
                                        if (typeof fn === 'function' && (fn as any).$$id === args.actionId) {
                                            actionFn = fn as (...a: any[]) => Promise<any>
                                            break
                                        }
                                    }
                                    if (actionFn) break
                                }
                            }

                            if (!actionFn) {
                                return { success: null, error: 'actionFn not found in webpack cache' }
                            }

                            // Build the opts object (same shape as the dashboard UI)
                            const opts: Record<string, string> = {
                                offerid: args.offerId,
                                timezoneOffset: new Date().getTimezoneOffset().toString()
                            }
                            if (args.isPromotional != null) {
                                opts.isPromotional = String(args.isPromotional)
                            }

                            // Call: reportActivity(hash, type, opts) — through React's callServer
                            const result = await actionFn(args.hash, args.finalType, opts)
                            return { success: result === true, error: null }
                        } catch (err) {
                            return {
                                success: null,
                                error: err instanceof Error ? err.message : String(err)
                            }
                        }
                    },
                    {
                        actionId,
                        moduleKey: actionModuleKey,
                        offerId: finalOfferId,
                        hash: finalHash,
                        finalType,
                        isPromotional: params.isPromotional
                    }
                )
            } catch {
                // Webpack approach threw — will fall through to manual fetch
            }

            if (nativeResult !== null && typeof nativeResult === 'object' && 'success' in nativeResult) {
                const nr = nativeResult as { success: boolean | null; error: string | null }
                if (nr.error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'REPORT-ACTIVITY-BROWSER',
                        `Native webpack call error: ${nr.error} | offerId=${finalOfferId}`
                    )
                } else if (nr.success !== null) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'REPORT-ACTIVITY-BROWSER',
                        `Server Action (native): result=${nr.success} | offerId=${finalOfferId}`,
                        nr.success ? 'green' : undefined
                    )
                    return nr.success
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REPORT-ACTIVITY-BROWSER',
                `Native webpack call failed or unavailable, falling back to manual fetch | offerId=${params.offerId}`
            )

            // ── Strategy B (fallback): Manual fetch ──────────────────
            const result = await page.evaluate(
                async (args: {
                    actionId: string
                    offerId: string
                    hash: string
                    finalType: number
                    isPromotional?: boolean
                }) => {
                    try {
                        const opts: Record<string, string> = {
                            offerid: args.offerId,
                            timezoneOffset: new Date().getTimezoneOffset().toString()
                        }
                        if (args.isPromotional != null) {
                            opts.isPromotional = String(args.isPromotional)
                        }

                        const body = JSON.stringify([args.hash, args.finalType, opts])

                        // ── Router state tree ─────────────────────────────────
                        // Next.js prepareFlightRouterStateForRequest produces a cleaned tree
                        // with 4+ elements per node: [segment, childrenMap, null, refetch|null, isRootLayout?].
                        // Extract from __next_f flight data (row 0, field "f"), then fallback.
                        let routerStateTree = ''
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const nextF = (window as any).__next_f
                            if (Array.isArray(nextF)) {
                                // Join all data chunks to find the tree in the row 0 flight data.
                                // Row 0 contains: {"P":..., "f":[[tree, seedData, head], ...], ...}
                                // The tree is at f[0][0] and starts with ["",{"children":...}]
                                for (const entry of nextF) {
                                    if (!Array.isArray(entry) || entry[0] !== 1 || typeof entry[1] !== 'string')
                                        continue
                                    const str = entry[1] as string
                                    // Look for the flight data tree: "f":[[["",{
                                    const marker = '"f":[[["",{'
                                    const fIdx = str.indexOf(marker)
                                    if (fIdx === -1) continue

                                    // The tree starts at the inner [["",{...  (skip "f":[)
                                    const outerStart = fIdx + '"f":['.length // points to [["",{
                                    const innerStart = outerStart + 1 // points to ["",{

                                    // Bracket-match to find the end of the tree array
                                    let depth = 0
                                    let innerEnd = -1
                                    for (let i = innerStart; i < str.length; i++) {
                                        const ch = str[i]
                                        if (ch === '[' || ch === '{') depth++
                                        else if (ch === ']' || ch === '}') {
                                            depth--
                                            if (depth === 0) {
                                                innerEnd = i + 1
                                                break
                                            }
                                        } else if (ch === '"') {
                                            for (let j = i + 1; j < str.length; j++) {
                                                if (str[j] === '\\') {
                                                    j++
                                                    continue
                                                }
                                                if (str[j] === '"') {
                                                    i = j
                                                    break
                                                }
                                            }
                                        }
                                    }
                                    if (innerEnd <= innerStart) continue

                                    const rawTree = str.slice(innerStart, innerEnd)
                                    try {
                                        const tree = JSON.parse(rawTree)
                                        if (!Array.isArray(tree) || tree[0] !== '') continue

                                        // Clean: mimic prepareFlightRouterStateForRequest
                                        // Replace "$undefined" with actual undefined, strip URL/refetch
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        function cleanNode(node: any): any {
                                            if (!Array.isArray(node)) return node
                                            const [seg, children, , refetch, extra1, extra2] = node
                                            const cs =
                                                typeof seg === 'string' && seg.startsWith('__PAGE__?')
                                                    ? '__PAGE__'
                                                    : seg
                                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                            const cc: Record<string, any> = {}
                                            if (children && typeof children === 'object') {
                                                for (const [k, v] of Object.entries(children)) {
                                                    cc[k] = cleanNode(v)
                                                }
                                            }
                                            const rf =
                                                refetch && refetch !== 'refresh' && refetch !== '$undefined'
                                                    ? refetch
                                                    : null
                                            const result: any[] = [cs, cc, null, rf]
                                            if (extra1 !== undefined && extra1 !== '$undefined') result.push(extra1)
                                            if (extra2 !== undefined && extra2 !== '$undefined') result.push(extra2)
                                            return result
                                        }
                                        const cleaned = cleanNode(tree)
                                        routerStateTree = encodeURIComponent(JSON.stringify(cleaned))
                                    } catch {
                                        /* parse failed */
                                    }
                                    if (routerStateTree) break
                                }
                            }
                        } catch {
                            /* tree extraction failed */
                        }

                        // Fallback: build a correctly-padded tree from pathname segments.
                        // Each node: [segment, childrenMap, null, null]
                        if (!routerStateTree) {
                            const segments = window.location.pathname.split('/').filter(Boolean)
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            let tree: any = ['__PAGE__', {}, null, null]
                            for (let i = segments.length - 1; i >= 0; i--) {
                                tree = [segments[i], { children: tree }, null, null]
                            }
                            tree = ['', { children: tree }, null, null]
                            routerStateTree = encodeURIComponent(JSON.stringify(tree))
                        }

                        // ── Headers (matching Next.js server action protocol) ──
                        const headers: Record<string, string> = {
                            Accept: 'text/x-component',
                            'Content-Type': 'text/plain;charset=UTF-8',
                            'next-action': args.actionId,
                            'next-router-state-tree': routerStateTree
                        }
                        // next-url: pathname only, sent when non-empty
                        const pathname = window.location.pathname
                        if (pathname) {
                            headers['next-url'] = pathname
                        }

                        // Fetch with relative URL (Next.js uses state.canonicalUrl = pathname)
                        const response = await fetch(pathname, {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers,
                            body
                        })

                        // ── Parse RSC response for actual action result ──────
                        // Format: "0:{\"a\":\"$@1\",...}\n1:true" or "1:false"
                        let actionResult: string | null = null
                        let actionSuccess: boolean | null = null
                        try {
                            const text = await response.text()
                            actionResult = text.slice(0, 500)
                            // The action return value is on row "1:" in the RSC stream
                            const m = text.match(/(?:^|\n)1:(true|false)/)
                            if (m) {
                                actionSuccess = m[1] === 'true'
                            }
                        } catch {
                            /* body read failed */
                        }

                        return {
                            ok: response.ok,
                            status: response.status,
                            error: null,
                            actionResult,
                            actionSuccess
                        }
                    } catch (err) {
                        return {
                            ok: false,
                            status: 0,
                            error: err instanceof Error ? err.message : String(err),
                            actionResult: null,
                            actionSuccess: null
                        }
                    }
                },
                {
                    actionId,
                    offerId: finalOfferId,
                    hash: finalHash,
                    finalType,
                    isPromotional: params.isPromotional
                }
            )

            if (result.error) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    `${result.error} | offerId=${params.offerId}`
                )
                return false
            }

            const actionSucceeded = result.actionSuccess === true

            this.bot.logger.info(
                this.bot.isMobile,
                'REPORT-ACTIVITY-BROWSER',
                `Server Action: http=${result.status} actionResult=${result.actionSuccess ?? 'unknown'} | offerId=${finalOfferId}`
            )
            if (result.actionResult) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REPORT-ACTIVITY-BROWSER',
                    `Server Action RSC response | offerId=${finalOfferId} | ${result.actionResult.replace(/\s+/g, ' ').slice(0, 300)}`
                )
            }

            return actionSucceeded
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'REPORT-ACTIVITY-BROWSER',
                `Server Action failed: ${error instanceof Error ? error.message : String(error)} | offerId=${params.offerId}`
            )
            return false
        }
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return [
            ...new Map(
                cookies
                    .filter(c => {
                        if (!allowedDomains || allowedDomains.length === 0) return true
                        return (
                            typeof c.domain === 'string' &&
                            allowedDomains.some(d => c.domain.toLowerCase().endsWith(d.toLowerCase()))
                        )
                    })
                    .map(c => [c.name, c])
            ).values()
        ]
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }
}
