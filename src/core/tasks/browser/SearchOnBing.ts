import { randomBytes } from 'crypto'
import * as fs from 'fs'
import type { Page } from 'patchright'
import path from 'path'

import { BING_SEARCH } from '../../../automation/DashboardSelectors'
import { QueryProvider } from '../../QueryProvider'
import { TaskBase } from '../../TaskBase'

import type { BasePromotion } from '../../../types/DashboardData'

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

            // Do the bing search here
            const queries = await this.getSearchQueries(promotion)

            // Run through the queries
            await this.searchBing(page, queries)

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

    private async searchBing(page: Page, queries: string[]) {
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
                const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

                // Navigate the page this task was actually given (desktop or mobile),
                // not a hardcoded mobile page — otherwise a desktop SearchOnBing would
                // drive the wrong tab and the search would never register.
                await page.goto(url)

                // Wait until page loaded
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

                await this.bot.browser.utils.tryDismissAllMessages(page)

                const searchBar = BING_SEARCH.searchBar

                const searchBox = page.locator(searchBar)
                await searchBox.waitFor({ state: 'attached', timeout: 15000 })

                await this.bot.utils.wait(500)
                await this.bot.browser.utils.ghostClick(page, searchBar, { clickCount: 3 })
                await searchBox.fill('')

                // Human-like typing with randomized per-keystroke delay
                for (const char of query) {
                    await page.keyboard.type(char, { delay: this.bot.utils.humanTypeDelay() })
                }
                await this.bot.utils.wait(this.bot.utils.randomNumber(200, 600))
                await page.keyboard.press('Enter')

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

    /** Visit the first organic Bing result, scroll, then go back to Bing.
     *  Runs on ~65 % of searches to vary session behaviour. */
    private async visitSearchResult(page: Page): Promise<void> {
        if (Math.random() > 0.65) return

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

            await this.bot.utils.wait(this.bot.utils.randomDelay(500, 1500))
            await this.bot.browser.utils.ghostClick(page, resultSelector)

            await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
            await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))

            // Scroll down in 2–4 steps to simulate reading
            const steps = this.bot.utils.randomNumber(2, 4)
            for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, this.bot.utils.randomNumber(250, 550))
                await this.bot.utils.wait(this.bot.utils.randomDelay(700, 1600))
            }

            // Go back to Bing results
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
                await page.goto(this.bingHome, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
            })
            await this.bot.utils.wait(this.bot.utils.randomDelay(800, 1800))
        } catch {
            // Non-critical — a failed result visit must never break the search loop
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
