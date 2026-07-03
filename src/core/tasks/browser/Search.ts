import { randomBytes } from 'crypto'
import type { Page } from 'patchright'
import type { Counters, DashboardData } from '../../../types/DashboardData'

import { BING_SEARCH } from '../../../automation/DashboardSelectors'
import { getCurrentContext } from '../../../context/ExecutionContext'
import { recordSearchQuery } from '../../../helpers/StatsRecorder'
import { QueryProvider } from '../../QueryProvider'
import { TaskBase } from '../../TaskBase'

export class Search extends TaskBase {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''
    private searchCount = 0

    public async doSearch(data: DashboardData, page: Page, isMobile: boolean): Promise<number> {
        // Wrapper: run the search session, then emit one aggregate `search_completed`
        // event per platform. `finally` guarantees it fires on every return path of
        // the inner method (and even if it throws), without touching the hot-path logic.
        let gained = 0
        try {
            gained = await this.doSearchInner(data, page, isMobile)
            return gained
        } finally {
            this.bot.analytics.track('search_completed', this.bot.analytics.withContext({
                platform: isMobile ? 'mobile' : 'desktop',
                points_gained: gained,
                has_core: this.bot.pluginManager.hasOfficialCoreEntitlement()
            }))
        }
    }

    private async doSearchInner(data: DashboardData, page: Page, isMobile: boolean): Promise<number> {
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches | currentPoints=${startBalance}`)

        let totalGainedPoints = 0

        try {
            let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
            const missingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
            let missingPointsTotal = missingPoints.totalPoints

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `Initial search counters | mobile=${missingPoints.mobilePoints} | desktop=${missingPoints.desktopPoints} | edge=${missingPoints.edgePoints}`
            )

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Search points remaining | Edge=${missingPoints.edgePoints} | Desktop=${missingPoints.desktopPoints} | Mobile=${missingPoints.mobilePoints}`
            )

            const queryCore = new QueryProvider(this.bot)
            const locale = (this.bot.userData.geoLocale ?? 'US').toUpperCase()
            const langCode = (this.bot.userData.langCode ?? 'en').toLowerCase()

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `Resolving search queries via QueryCore | locale=${locale} | lang=${langCode} | related=true`
            )

            let queries = await queryCore.queryManager({
                shuffle: true,
                related: true,
                langCode,
                geoLocale: locale,
                sourceOrder: ['google', 'wikipedia', 'reddit', 'local']
            })

            queries = [...new Set(queries.map(q => q.trim()).filter(Boolean))]

            this.bot.logger.info(isMobile, 'SEARCH-BING', `Search query pool ready | count=${queries.length}`)

            // Go to bing
            const targetUrl = this.searchPageURL ? this.searchPageURL : this.bingHome
            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Navigating to search page | url=${targetUrl}`)

            await page.goto(targetUrl)
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            // Guard: Bing only credits searches when bing.com itself carries the
            // signed-in account. The rewards login can succeed while the Bing search
            // session stays anonymous, which silently burns the whole run for 0
            // points (observed in production on accounts with real point balances,
            // not just fresh ones). Detect that here and re-establish the session
            // once before committing to the search loop.
            if (!isMobile && (await this.bot['login'].isBingSignedOut(page))) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    'Bing search session is signed out — re-establishing before searching (searches would otherwise earn 0 points)'
                )

                await this.bot['login'].verifyBingSession(page, getCurrentContext().account)

                await page.goto(targetUrl).catch(() => {})
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
                await this.bot.browser.utils.tryDismissAllMessages(page)

                // Only bail out when Bing still *positively* shows the signed-out state.
                // If detection is ambiguous we fall through and search as before, so a
                // drifted selector can never skip a genuinely signed-in account's run.
                if (await this.bot['login'].isBingSignedOut(page)) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        'Bing search session is still signed out — searches will not be credited. ' +
                            'This usually means the account must open Bing manually once (region/terms not yet accepted) or is flagged. Skipping search run.'
                    )
                    return 0
                }

                this.bot.logger.info(isMobile, 'SEARCH-BING', 'Bing search session re-established, continuing')
            }

            // When Microsoft serves the Next.js dashboard, the legacy search-point
            // counters are absent, so missingSearchPoints() reports 0 and the
            // counter-driven loop below would stop after a single search. Detect
            // that case and fall back to a balance-driven, count-based search run
            // (the available-points balance is still recoverable from the HTML).
            if (!this.bot.browser.func.hasSearchCounters(searchCounters)) {
                return await this.runCountBasedSearch(page, queries, queryCore, langCode, locale, isMobile, startBalance)
            }

            let stagnantLoop = 0
            const stagnantLoopMax = 10

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i] as string

                searchCounters = await this.bingSearch(page, query, isMobile)
                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                const newMissingPointsTotal = newMissingPoints.totalPoints

                const rawGained = missingPointsTotal - newMissingPointsTotal
                const gainedPoints = Math.max(0, rawGained)

                void recordSearchQuery(query, isMobile, gainedPoints, this.bot.userData.userName)

                if (gainedPoints === 0) {
                    stagnantLoop++
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                    )
                } else {
                    stagnantLoop = 0

                    const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                    totalGainedPoints += gainedPoints

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                        'green'
                    )
                }

                missingPointsTotal = newMissingPointsTotal

                if (missingPointsTotal === 0) {
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        'All required search points earned, stopping main search loop'
                    )
                    break
                }

                // Circuit breaker: a few fruitless searches in a row can happen on a
                // genuinely signed-in account (some queries just don't qualify), so we
                // don't want to bail on the first miss. But if it keeps missing, re-check
                // whether Bing is actually signed in — this catches sessions that went
                // anonymous mid-run (or were never detected as anonymous by the selectors
                // above) well before burning the full stagnantLoopMax search budget.
                if (stagnantLoop === Math.ceil(stagnantLoopMax / 2) && (await this.checkMidLoopAnonymous(isMobile, page))) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Bing session is anonymous after ${stagnantLoop} fruitless searches — aborting early instead of burning the full search budget`
                    )
                    return totalGainedPoints
                }

                if (stagnantLoop >= stagnantLoopMax) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Search did not gain points for ${stagnantLoopMax} iterations, aborting main search loop`
                    )
                    stagnantLoop = 0
                    break
                }

                const remainingQueries = queries.length - (i + 1)
                const minBuffer = 20
                if (missingPointsTotal > 0 && remainingQueries < minBuffer) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Low query buffer while still missing points, regenerating | remainingQueries=${remainingQueries} | missing=${missingPointsTotal}`
                    )

                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: true,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    queries = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(queries)

                    this.bot.logger.debug(isMobile, 'SEARCH-BING', `Query pool regenerated | count=${queries.length}`)
                }
            }

            if (missingPointsTotal > 0) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Search completed but still missing points, continuing with regenerated queries | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 5

                while (missingPointsTotal > 0) {
                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: true,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(newPool)

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING-EXTRA',
                        `New search query pool generated | count=${queries.length}`
                    )

                    for (const query of queries) {
                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `Extra search | remaining=${missingPointsTotal} | query="${query}"`
                        )

                        searchCounters = await this.bingSearch(page, query, isMobile)
                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        const newMissingPointsTotal = newMissingPoints.totalPoints

                        const rawGained = missingPointsTotal - newMissingPointsTotal
                        const gainedPoints = Math.max(0, rawGained)

                        void recordSearchQuery(query, isMobile, gainedPoints, this.bot.userData.userName)

                        if (gainedPoints === 0) {
                            stagnantLoop++
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                            )
                        } else {
                            stagnantLoop = 0

                            const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                            totalGainedPoints += gainedPoints

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                                'green'
                            )
                        }

                        missingPointsTotal = newMissingPointsTotal

                        if (missingPointsTotal === 0) {
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                'All required search points earned during extra searches'
                            )
                            break
                        }

                        if (
                            stagnantLoop === Math.ceil(stagnantLoopMax / 2) &&
                            (await this.checkMidLoopAnonymous(isMobile, page))
                        ) {
                            this.bot.logger.error(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `Bing session is anonymous after ${stagnantLoop} fruitless extra searches — aborting early`
                            )
                            return totalGainedPoints
                        }

                        if (stagnantLoop >= stagnantLoopMax) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `Search did not gain points for ${stagnantLoopMax} iterations, aborting extra searches`
                            )
                            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `Aborted extra searches | startBalance=${startBalance} | finalBalance=${finalBalance}`
                            )
                            return totalGainedPoints
                        }
                    }
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Completed Bing searches | startBalance=${startBalance} | newBalance=${finalBalance}`
            )

            return totalGainedPoints
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-BING',
                `Error in doSearch | message=${error instanceof Error ? error.message : String(error)}`
            )
            return totalGainedPoints
        }
    }

    /**
     * Fallback search runner used when Microsoft no longer exposes the search-point
     * counters (Next.js dashboard migration). Progress can't be read from counters,
     * so we measure real gains from the available-points balance and keep searching
     * until Microsoft stops awarding points (the daily cap) or a safety cap is hit.
     */
    private async runCountBasedSearch(
        page: Page,
        queries: string[],
        queryCore: QueryProvider,
        langCode: string,
        locale: string,
        isMobile: boolean,
        startBalance: number
    ): Promise<number> {
        // Safety cap kept well above Microsoft's daily search allowance so the
        // natural stop is the balance plateau, not this number.
        const maxSearches = isMobile ? 25 : 40
        // Stop once the balance hasn't moved for this many consecutive searches.
        const plateauLimit = 8

        let totalGainedPoints = 0
        let plateau = 0
        let pool = [...queries]
        let prevBalance = await this.safeGetBalance(startBalance)

        this.bot.logger.warn(
            isMobile,
            'SEARCH-BING',
            `Search point counters unavailable (Microsoft dashboard migration) — running count-based fallback | maxSearches=${maxSearches} | startBalance=${prevBalance}`
        )

        for (let i = 0; i < maxSearches; i++) {
            if (i >= pool.length) {
                const extra = await queryCore.queryManager({
                    shuffle: true,
                    related: true,
                    langCode,
                    geoLocale: locale,
                    sourceOrder: this.bot.config.searchSettings.queryEngines
                })
                pool = [...new Set([...pool, ...extra].map(q => q.trim()).filter(Boolean))]
                if (i >= pool.length) break // no more queries available
            }

            const query = pool[i] as string

            await this.bingSearch(page, query, isMobile)

            const newBalance = await this.safeGetBalance(prevBalance)
            const gainedPoints = Math.max(0, newBalance - prevBalance)

            void recordSearchQuery(query, isMobile, gainedPoints, this.bot.userData.userName)

            if (gainedPoints > 0) {
                plateau = 0
                prevBalance = newBalance
                totalGainedPoints += gainedPoints
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `gainedPoints=${gainedPoints} | query="${query}" | balance=${newBalance} | search ${i + 1}/${maxSearches}`,
                    'green'
                )
            } else {
                plateau++
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `No points gained ${plateau}/${plateauLimit} | query="${query}" | search ${i + 1}/${maxSearches}`
                )

                if (plateau === Math.ceil(plateauLimit / 2) && (await this.checkMidLoopAnonymous(isMobile, page))) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Bing session is anonymous after ${plateau} fruitless searches — aborting early instead of running the full fallback budget`
                    )
                    break
                }

                if (plateau >= plateauLimit) {
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        'Balance plateaued — assuming daily search cap reached, stopping fallback searches'
                    )
                    break
                }
            }
        }

        const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
        this.bot.logger.info(
            isMobile,
            'SEARCH-BING',
            `Completed count-based searches | startBalance=${startBalance} | newBalance=${finalBalance} | gained=${totalGainedPoints}`
        )

        return totalGainedPoints
    }

    /**
     * Mid-loop circuit breaker: re-check whether Bing is signed in after a few
     * consecutive fruitless searches. The upfront guard in doSearch() can miss an
     * anonymous session (selector drift, or session going anonymous partway through
     * a long run); this catches it without waiting for the full stagnant/plateau
     * budget. Mobile search uses a token-based flow, not the Bing header, so it's
     * skipped there. Never throws — a detection failure just lets the loop continue.
     */
    private async checkMidLoopAnonymous(isMobile: boolean, page: Page): Promise<boolean> {
        if (isMobile) return false
        try {
            return await this.bot['login'].isBingSignedOut(page)
        } catch {
            return false
        }
    }

    /** Read the current points balance, tolerating transient lookup failures. */
    private async safeGetBalance(fallback: number): Promise<number> {
        try {
            // getCurrentPoints can return NaN/undefined when the Next.js dashboard omits
            // the balance (no throw). Treat a non-finite result like a failure and fall
            // back, otherwise the count-based loop reads every search as a 0-point plateau.
            const balance = Number(await this.bot.browser.func.getCurrentPoints())
            return Number.isFinite(balance) ? balance : fallback
        } catch {
            return fallback
        }
    }

    private async bingSearch(searchPage: Page, query: string, isMobile: boolean) {
        const maxAttempts = 5

        this.searchCount++

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Starting bingSearch | query="${query}" | maxAttempts=${maxAttempts} | searchCount=${this.searchCount} | scrollRandomResults=${this.bot.config.searchSettings.scrollRandomResults} | clickRandomResults=${this.bot.config.searchSettings.clickRandomResults}`
        )

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const searchBar = BING_SEARCH.searchBar
                const searchBox = searchPage.locator(searchBar)

                // Load the results page for this query directly instead of relying on the
                // search box already being usable on whatever page the previous step left
                // behind. On mobile (and some locales) the homepage #sb_form_q is present
                // in the DOM but collapsed/hidden, so waitFor({ state: 'visible' }) timed
                // out (15s × maxAttempts) and the whole run earned 0 points. Navigating to
                // /search guarantees a real results page (mirrors the proven SearchOnBing
                // flow) and registers the search via the URL even if the human-typing
                // re-submit below is interrupted. A fresh navigation on each attempt also
                // recovers a stale/blank page on retry.
                const cvid = randomBytes(16).toString('hex')
                const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

                await searchPage.goto(url, { timeout: 20000 })
                await searchPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
                await this.bot.browser.utils.tryDismissAllMessages(searchPage)

                // Use string form so the obfuscator cannot inject outer-scope
                // string-array references inside the evaluate callback body.
                await searchPage.evaluate('window.scrollTo(0, 0)')

                await searchPage.keyboard.press('Home')

                // 'attached' (not 'visible'): the box is reliably in the DOM on the results
                // page but Playwright can flag it not-visible on mobile/SERP layouts; the
                // ghostClick + fill below make it interactable. Matches SearchOnBing.
                await searchBox.waitFor({ state: 'attached', timeout: 15000 })

                await this.bot.utils.wait(1000)
                await this.bot.browser.utils.ghostClick(searchPage, searchBar, { clickCount: 3 })
                await searchBox.fill('', { timeout: 5000 })

                // Human-like typing with randomized per-keystroke delay
                for (const char of query) {
                    await searchPage.keyboard.type(char, { delay: this.bot.utils.humanTypeDelay() })
                }
                await this.bot.utils.wait(this.bot.utils.randomNumber(200, 600))
                await searchPage.keyboard.press('Enter')

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Submitted query to Bing | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(3000)

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(searchPage, isMobile)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(searchPage, isMobile)
                }

                await this.bot.utils.wait(
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                const counters = await this.bot.browser.func.getSearchPoints()

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Search counters after query | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                return counters
            } catch (error) {
                if (i >= maxAttempts - 1) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Failed after ${maxAttempts} retries | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    break
                }

                this.bot.logger.error(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt failed | attempt=${i + 1}/${maxAttempts} | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )

                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Retrying search | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(2000)
            }
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Returning current search counters after failed retries | query="${query}"`
        )

        return await this.bot.browser.func.getSearchPoints()
    }

    /**
     * Human-like progressive scroll: several small wheel steps with variable
     * speed + reading pauses, occasionally nudging back up (re-reading) — instead
     * of one instant jump to a random offset, which is a classic automation tell.
     * Uses real wheel events (page.mouse.wheel), never window.scrollTo, so it also
     * sidesteps the obfuscator-unsafe page.evaluate path entirely.
     */
    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            const steps = this.bot.utils.randomNumber(3, 7)
            for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, this.bot.utils.randomNumber(180, 520))
                await this.bot.utils.wait(this.bot.utils.randomDelay(500, 1500))
                // ~1 step in 5: a small scroll back up, like a human re-reading.
                if (Math.random() < 0.2) {
                    await page.mouse.wheel(0, -this.bot.utils.randomNumber(80, 240))
                    await this.bot.utils.wait(this.bot.utils.randomDelay(400, 1100))
                }
            }
            this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-SCROLL', `Human scroll done | steps=${steps}`)
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `An error occurred during random scroll | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean) {
        try {
            this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Attempting to click a random search result link')

            const searchPageUrl = page.url()
            const resultCount = await page.locator(BING_SEARCH.resultLinks).count().catch(() => 0)
            if (resultCount === 0) {
                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-RANDOM-CLICK',
                    `No clickable organic result found | selector=${BING_SEARCH.resultLinks}`
                )
                return
            }

            await this.bot.browser.utils.ghostClick(page, BING_SEARCH.resultLinks)
            // Brief settle so the navigation / new tab actually opens.
            await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))

            if (isMobile) {
                // Mobile: the click navigates the same tab. Read it (progressive
                // scroll) for the visit time, then return to the results page.
                await this.randomScroll(page, isMobile)
                await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)
                await page.goto(searchPageUrl)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Navigated back to search page')
            } else {
                // Desktop: the result opens in a new tab. Read it (progressive
                // scroll) before closing, instead of idling on it.
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                const newTabUrl = newTab.url()

                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', `Visited result tab | url=${newTabUrl}`)

                await this.randomScroll(newTab, isMobile)
                await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)
                await this.bot.browser.utils.closeTabs(newTab)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Closed result tab')
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `An error occurred during random click | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
