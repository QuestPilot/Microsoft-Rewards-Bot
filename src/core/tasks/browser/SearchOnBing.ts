import { randomBytes } from 'crypto'
import * as fs from 'fs'
import type { Page } from 'patchright'
import path from 'path'

import { BING_SEARCH, BING_PARAMS } from '../../../automation/DashboardSelectors'
import { QueryProvider } from '../../QueryProvider'
import { TaskBase } from '../../TaskBase'

import type { BasePromotion } from '../../../types/DashboardData'

// "Explore on Bing" promos (offerId ENUS_<topic>_exploreonbing_*) credit only
// when you run a COMMERCIAL search on the topic carrying the explore tracking
// params (form=ML2PCR…) — NOT a generic search. Map each topic to commercial
// queries; fall back to a query built from the topic token for unknown topics.
const EXPLORE_ON_BING_QUERIES: Readonly<Record<string, readonly string[]>> = {
    creditcards: ['best credit cards with rewards', 'compare credit card offers'],
    insurance: ['best insurance quotes online', 'compare insurance plans'],
    concerttickets: ['buy concert tickets online', 'concert tickets near me'],
    internetproviders: ['best internet providers near me', 'compare internet plans'],
    rentalcars: ['best rental car deals', 'compare rental car prices'],
    shopping: ['best online shopping deals today', 'top shopping deals'],
    flights: ['cheap flight deals', 'compare flight prices'],
    travel: ['best travel deals', 'compare vacation packages'],
    hotels: ['best hotel deals', 'compare hotel prices'],
    autos: ['best new car deals', 'compare car prices'],
    homeservices: ['best home services near me', 'compare home service quotes']
}

export class SearchOnBing extends TaskBase {
    private bingHome = 'https://bing.com'

    private gainedPoints: number = 0

    private success: boolean = false

    private oldBalance: number = this.bot.userData.currentPoints

    public async doSearchOnBing(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentPoints=${this.oldBalance}`
        )

        // Explore-on-Bing is a Core, opt-in extra (commercial topic searches, ~10 pts each).
        // When disabled, skip immediately instead of running searches the user didn't ask for.
        if (this.isExploreOnBing(promotion) && this.bot.config.core?.exploreOnBing !== true) {
            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Explore-on-Bing disabled (core.exploreOnBing) — skipping | offerId=${offerId}`
            )
            return
        }

        try {
            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING', `Activating search task | offerId=${offerId}`)

            const activated = await this.activateSearchTask(promotion, page)
            if (!activated) {
                // For punchcard child activities, the server action "activation" step
                // may return false because punchcard children are tracked differently —
                // the credit comes from doing the actual Bing search, not the pre-report.
                // Proceed with the search anyway; worst case we do the search with no credit.
                const isPunchcard = offerId.toLowerCase().includes('punchcard')
                if (!isPunchcard) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING',
                        `Search activity couldn't be activated, aborting | offerId=${offerId}`
                    )
                    return
                }
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Punchcard search activation returned false — proceeding with search (credit comes from Bing search) | offerId=${offerId}`
                )
            }

            // Do the bing search here. Explore-on-Bing promos credit only on a
            // COMMERCIAL search of the topic carrying the explore tracking params,
            // so they use a dedicated query set + params (not getSearchQueries).
            const isExplore = this.isExploreOnBing(promotion)
            const queries = isExplore ? this.exploreQueries(promotion) : await this.getSearchQueries(promotion)

            // Run through the queries
            await this.searchBing(page, queries, isExplore)

            if (this.success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Completed SearchOnBing | offerId=${offerId} | startBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-ON-BING',
                    `Failed SearchOnBing | offerId=${offerId} | startBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'SEARCH-ON-BING',
                `Error in doSearchOnBing | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /** Explore-on-Bing promos are credited by a tracked commercial search, not a
     *  generic one. Detect them by offerId/name (ENUS_<topic>_exploreonbing_*). */
    private isExploreOnBing(promotion: BasePromotion): boolean {
        const id = `${promotion.offerId ?? ''} ${promotion.name ?? ''}`.toLowerCase()
        return id.includes('exploreonbing')
    }

    /** Commercial queries for an explore-on-Bing promo, derived from its topic
     *  token (ENUS_<topic>_exploreonbing). Falls back to a generic commercial
     *  query built from the topic when it isn't in the known map. */
    private exploreQueries(promotion: BasePromotion): string[] {
        const offerId = (promotion.offerId ?? '').toLowerCase()
        const parts = offerId.split('_')
        const topic = parts.length > 1 ? (parts[1] ?? '') : ''
        const known = topic ? EXPLORE_ON_BING_QUERIES[topic] : undefined
        if (known && known.length) return [...known]
        const readable = (topic || 'deals').replace(/([a-z])([A-Z])/g, '$1 $2')
        return [`best ${readable} deals`, `compare ${readable}`]
    }

    private async searchBing(page: Page, queries: string[], isExplore = false) {
        queries = [...new Set(queries)]

        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Starting search loop | queriesCount=${queries.length} | oldBalance=${this.oldBalance}`
        )

        let i = 0
        for (const query of queries) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Processing query | query="${query}"`)

                const cvid = randomBytes(16).toString('hex')
                const exb = BING_PARAMS.exploreOnBing
                const url = isExplore
                    ? `${this.bingHome}/search?q=${encodeURIComponent(query)}&form=${exb.form}&OCID=${exb.OCID}&PUBL=${exb.PUBL}&CREA=${exb.CREA}&PC=${exb.form}&cvid=${cvid}`
                    : `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

                // Navigate the page this task was actually given (desktop or mobile),
                // not a hardcoded mobile page — otherwise a desktop SearchOnBing would
                // drive the wrong tab and the search would never register.
                await page.goto(url)

                // Wait until page loaded
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

                await this.bot.browser.utils.tryDismissAllMessages(page)

                // For explore-on-Bing, the tracked /search navigation above IS what
                // credits — re-typing in the box submits an UNtracked /search and can lose
                // the credit. So the human re-submit only runs for normal SearchOnBing items.
                if (!isExplore) {
                    const searchBar = BING_SEARCH.searchBar

                    const searchBox = page.locator(searchBar)
                    await searchBox.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {})

                    await this.bot.utils.wait(500)
                    // Best-effort human re-submit. The /search URL navigation above ALREADY
                    // registered the search, so a non-actionable search box (collapsed on
                    // mobile/legacy layouts) must NEVER hang us 30s on fill — fail fast and
                    // fall through to the balance check.
                    try {
                        await this.bot.browser.utils.ghostClick(page, searchBar, { clickCount: 3 })
                        await searchBox.fill('', { timeout: 5000 })

                        // Human-like typing with randomized per-keystroke delay
                        for (const char of query) {
                            await page.keyboard.type(char, { delay: this.bot.utils.humanTypeDelay() })
                        }
                        await this.bot.utils.wait(this.bot.utils.randomNumber(200, 600))
                        await page.keyboard.press('Enter')
                    } catch (e) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'SEARCH-ON-BING-SEARCH',
                            `Search box not interactable, relying on URL search | query="${query}" | message=${e instanceof Error ? e.message : String(e)}`
                        )
                    }
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000))

                // Occasionally visit a search result — more realistic browsing behaviour
                await this.visitSearchResult(page)

                // Check for point updates
                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.gainedPoints = newBalance - this.oldBalance

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Balance check after query | query="${query}" | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
                )

                if (this.gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `SearchOnBing query completed | query="${query}" | gainedPoints=${this.gainedPoints} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`,
                        'green'
                    )

                    this.success = true
                    return
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-SEARCH',
                        `${++i}/${queries.length} | noPoints=1 | query="${query}"`
                    )
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-SEARCH',
                    `Error during search loop | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            } finally {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
                // Return to the rewards page. Legacy (ASP) has NO /earn route — go to the
                // root home (matches the reference bot); next returns to /earn which carries
                // the RSC data for all activities.
                const returnUrl =
                    this.bot.dashboardVariant === 'legacy'
                        ? 'https://rewards.bing.com/'
                        : 'https://rewards.bing.com/earn'
                await page.goto(returnUrl, { timeout: 5000 }).catch(() => {})
            }
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'SEARCH-ON-BING-SEARCH',
            `Finished all queries with no points gained | queriesTried=${queries.length} | oldBalance=${this.oldBalance} | finalBalance=${this.bot.userData.currentPoints}`
        )
    }

    /** Visit the first organic Bing result, read it, then return to Bing —
     *  closing the result tab if it opened in a NEW one. Many organic results
     *  (and the "explore on Bing" promos) open with target=_blank; the old code
     *  only called page.goBack(), so the new tab was never closed and result tabs
     *  piled up (user-reported). Runs on ~65 % of searches to vary behaviour. */
    private async visitSearchResult(page: Page): Promise<void> {
        if (Math.random() > 0.65) return

        const context = page.context()
        try {
            const resultSelector = BING_SEARCH.resultLinkHref
            const href = await page
                .locator(resultSelector)
                .first()
                .getAttribute('href', { timeout: 3000 })
                .catch(() => null)
            if (!href) return

            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-ON-BING-VISIT',
                `Visiting search result | url=${href.slice(0, 80)}…`
            )

            const tabsBefore = context.pages().length
            await this.bot.utils.wait(this.bot.utils.randomDelay(500, 1500))
            await this.bot.browser.utils.ghostClick(page, resultSelector)
            await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))

            // The result may open in a NEW tab (target=_blank) or navigate the same
            // tab. Read whichever is the actual result page.
            const tabs = context.pages()
            const resultTab = (tabs.length > tabsBefore ? tabs[tabs.length - 1] : page) ?? page

            await resultTab.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
            await this.bot.utils.wait(this.bot.utils.randomDelay(1000, 2500))

            // Scroll down in 2–4 steps to simulate reading
            const steps = this.bot.utils.randomNumber(2, 4)
            for (let i = 0; i < steps; i++) {
                await resultTab.mouse.wheel(0, this.bot.utils.randomNumber(250, 550))
                await this.bot.utils.wait(this.bot.utils.randomDelay(700, 1600))
            }

            if (resultTab !== page) {
                // Opened in a new tab → close it so result tabs don't accumulate.
                await resultTab.close().catch(() => {})
                await page.bringToFront().catch(() => {})
            } else {
                // Same-tab navigation → go back to the Bing results.
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
                    await page.goto(this.bingHome, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
                })
            }
            await this.bot.utils.wait(this.bot.utils.randomDelay(800, 1800))
        } catch {
            // Non-critical — never break the search loop. Best-effort: close any
            // stray non-Bing tabs this visit may have left open so they don't pile up.
            try {
                for (const p of context.pages()) {
                    if (p !== page && !/bing\.com/i.test(p.url())) {
                        await p.close().catch(() => {})
                    }
                }
                await page.bringToFront().catch(() => {})
            } catch {
                /* ignore cleanup failures */
            }
        }
    }

    // The task needs to be activated before being able to complete it.
    // Activation = report the offer once; the variant-specific mechanism (legacy
    // axios POST vs Next Server Action) lives behind the `bot.dashboard` seam.
    private async activateSearchTask(promotion: BasePromotion, page: Page): Promise<boolean> {
        const ok = await this.bot.dashboard.reportActivity(page, {
            offerId: promotion.offerId,
            hash: promotion.hash,
            destinationUrl: promotion.destinationUrl
        })

        if (ok) {
            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Activated activity | variant=${this.bot.dashboardVariant} | offerId=${promotion.offerId}`
            )
        } else {
            this.bot.logger.warn(
                this.bot.isMobile,
                'SEARCH-ON-BING-ACTIVATE',
                `Activation failed | offerId=${promotion.offerId}`
            )
        }

        return ok
    }

    /** Validate that a parsed query config is `Array<{ title: string; queries: string[] }>`. */
    private isQueriesPayload(data: unknown): data is Array<{ title: string; queries: string[] }> {
        return (
            Array.isArray(data) &&
            data.every(
                item =>
                    !!item &&
                    typeof item === 'object' &&
                    typeof (item as { title?: unknown }).title === 'string' &&
                    Array.isArray((item as { queries?: unknown }).queries) &&
                    (item as { queries: unknown[] }).queries.every(query => typeof query === 'string')
            )
        )
    }

    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        interface Queries {
            title: string
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            if (this.bot.config.searchOnBingLocalQueries) {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Using local queries config file')

                const data = fs.readFileSync(path.join(__dirname, '../../bing-search-activity-queries.json'), 'utf8')
                const parsed: unknown = JSON.parse(data)
                if (!this.isQueriesPayload(parsed)) {
                    throw new Error('local query config has an unexpected shape')
                }
                queries = parsed

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Loaded queries config | source=local | entries=${queries.length}`
                )
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    'Fetching queries config from remote repository'
                )

                // Fetch from the repo directly so the user doesn't need to redownload the script for the new activities
                const response = await this.bot.axios.request({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/HEAD/src/core/bing-search-activity-queries.json'
                })
                // Never trust the remote payload's shape: a malformed/hostile response could
                // otherwise crash the search flow (e.g. .find on a non-array). Validate first.
                if (!this.isQueriesPayload(response.data)) {
                    throw new Error('remote query config has an unexpected shape')
                }
                queries = response.data

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Loaded queries config | source=remote | entries=${queries.length}`
                )
            }

            const answers = queries.find(
                x => this.bot.utils.normalizeString(x.title) === this.bot.utils.normalizeString(promotion.title)
            )

            if (answers && answers.queries.length > 0) {
                const answer = this.bot.utils.shuffleArray(answers.queries)

                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Found answers for activity title | source=${this.bot.config.searchOnBingLocalQueries ? 'local' : 'remote'} | title="${promotion.title}" | answersCount=${answer.length} | firstQuery="${answer[0]}"`
                )

                return answer
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `No matching title in queries config | source=${this.bot.config.searchOnBingLocalQueries ? 'local' : 'remote'} | title="${promotion.title}"`
                )

                const queryCore = new QueryProvider(this.bot)

                const promotionDescription = promotion.description.toLowerCase().trim()
                const queryDescription = promotionDescription.replace('search on bing', '').trim()

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Requesting Bing suggestions | queryDescription="${queryDescription}"`
                )

                const bingSuggestions = await queryCore.getBingSuggestions(queryDescription)

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-ON-BING-QUERY',
                    `Bing suggestions result | count=${bingSuggestions.length} | title="${promotion.title}"`
                )

                // If no suggestions found
                if (!bingSuggestions.length) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `No suggestions found, falling back to activity title | title="${promotion.title}"`
                    )
                    return [this.cleanSearchTitle(promotion.title)]
                } else {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Using Bing suggestions as search queries | count=${bingSuggestions.length} | title="${promotion.title}"`
                    )
                    return bingSuggestions
                }
            }
        } catch (error) {
            // Remote/local query file failed — try Bing suggestions from the
            // promotion description before falling back to just the title.
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `Query config unavailable (${error instanceof Error ? error.message : String(error)}), trying Bing suggestions | title="${promotion.title}"`
            )

            try {
                const queryCore = new QueryProvider(this.bot)
                const promotionDescription = (promotion.description ?? promotion.title).toLowerCase().trim()
                const queryDescription = promotionDescription.replace('search on bing', '').trim()

                const bingSuggestions = await queryCore.getBingSuggestions(queryDescription)
                if (bingSuggestions.length > 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-ON-BING-QUERY',
                        `Using Bing suggestions as fallback | count=${bingSuggestions.length} | title="${promotion.title}"`
                    )
                    return bingSuggestions
                }
            } catch {
                /* Bing suggestions also failed */
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `Falling back to promotion title as search query | title="${promotion.title}"`
            )
            return [this.cleanSearchTitle(promotion.title)]
        }
    }

    /** Strip punchcard CTA noise ("Click to complete.", "Search on Bing for…") from a
     *  title before using it as a Bing search query so the search term is meaningful. */
    private cleanSearchTitle(title: string): string {
        return title
            .replace(/\.\s*click\s+to\s+complete\.?\s*$/i, '')
            .replace(/^search\s+on\s+bing\s+(for\s+)?/i, '')
            .trim() || title
    }
}
