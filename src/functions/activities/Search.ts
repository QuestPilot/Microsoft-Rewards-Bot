import { AxiosRequestConfig } from "axios";
import { platform } from "os";
import { Page } from "rebrowser-playwright";

import { TIMEOUTS, URLS } from "../../constants";
import { Counters, DashboardData } from "../../interface/DashboardData";
import { GoogleSearch } from "../../interface/Search";
import { HumanTyping } from "../../util/browser/HumanTyping";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { secureRandom } from "../../util/security/SecureRandom";
import { Workers } from "../Workers";

type GoogleTrendsResponse = [
  string,
  [string, ...null[], [string, ...string[]]][],
];

// Search stagnation thresholds (magic numbers extracted as constants)
const MOBILE_STAGNATION_LIMIT = 5; // Mobile searches: abort after 5 queries without points
const DESKTOP_STAGNATION_LIMIT = 10; // Desktop searches: abort after 10 queries without points

export class Search extends Workers {
  private bingHome = URLS.BING_HOME;
  private searchPageURL = "";

  public async doSearch(page: Page, data: DashboardData) {
    this.bot.log(this.bot.isMobile, "SEARCH-BING", "Starting Bing searches");

    // IMPROVED: Add error handling for getLatestTab to prevent early flow failure
    try {
      page = await this.bot.browser.utils.getLatestTab(page);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING",
        `Failed to get latest tab: ${errorMsg}`,
        "error",
      );
      throw new Error(
        `Cannot start search - tab retrieval failed: ${errorMsg}`,
      );
    }

    let searchCounters: Counters =
      await this.bot.browser.func.getSearchPoints();
    let missingPoints = this.calculatePoints(searchCounters);

    if (missingPoints === 0) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING",
        "Bing searches have already been completed",
      );
      return;
    }

    // Generate search queries (primary: Google Trends)
    const geo = this.bot.config.searchSettings.useGeoLocaleQueries
      ? data.userProfile.attributes.country
      : "US";
    let googleSearchQueries = await this.getGoogleTrends(geo);

    // Fallback: if trends failed or insufficient, sample from local queries file
    if (!googleSearchQueries.length || googleSearchQueries.length < 10) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING",
        "Primary trends source insufficient, falling back to local queries.json",
        "warn",
      );
      try {
        const local = await import("../queries.json");
        // Flatten & sample
        const sampleSize = Math.max(
          5,
          Math.min(
            this.bot.config.searchSettings.localFallbackCount || 25,
            local.default.length,
          ),
        );
        const sampled = this.bot.utils
          .shuffleArray(local.default)
          .slice(0, sampleSize);
        googleSearchQueries = sampled.map(
          (x: { title: string; queries: string[] }) => ({
            topic: x.queries[0] || x.title,
            related: x.queries.slice(1),
          }),
        );
      } catch (e) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Failed loading local queries fallback: ${getErrorMessage(e)}`,
          "error",
        );
      }
    }

    if (this.bot.config.queryDiversity?.enabled && this.bot.queryEngine) {
      try {
        const targetCount = Math.max(20, missingPoints * 2);
        const extraTerms = await this.bot.queryEngine.fetchQueries(targetCount);
        if (extraTerms.length) {
          this.bot.log(
            this.bot.isMobile,
            "SEARCH-BING",
            `Query diversity enabled — adding ${extraTerms.length} mixed-source terms`,
          );
          googleSearchQueries.push(
            ...extraTerms.map((term) => ({ topic: term, related: [] })),
          );
        }
      } catch (err) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Query diversity error: ${getErrorMessage(err)}`,
          "warn",
        );
      }
    }

    googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries);

    // Combined deduplication: exact + semantic in single pass for performance
    if (this.bot.config.searchSettings.semanticDedup !== false) {
      const threshold =
        this.bot.config.searchSettings.semanticDedupThreshold ?? 0.65;
      const validThreshold = Math.max(0, Math.min(1, threshold)); // clamp [0,1]
      const originalCount = googleSearchQueries.length;
      googleSearchQueries = this.combinedDeduplication(
        googleSearchQueries,
        validThreshold,
      );
      const filtered = originalCount - googleSearchQueries.length;
      if (filtered > 0) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-DEDUP",
          `Query dedup: removed ${filtered} duplicates (${originalCount} → ${googleSearchQueries.length})`,
        );
      }
    } else {
      // Fallback: exact dedup only if semantic disabled
      const seen = new Set<string>();
      googleSearchQueries = googleSearchQueries.filter((q) => {
        if (seen.has(q.topic.toLowerCase())) return false;
        seen.add(q.topic.toLowerCase());
        return true;
      });
    }

    // Go to bing
    await page.goto(this.searchPageURL ? this.searchPageURL : this.bingHome);

    await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);

    await this.bot.browser.utils.tryDismissAllMessages(page);

    let stagnation = 0; // consecutive searches without point progress

    const queries: string[] = [];
    // Mobile search doesn't seem to like related queries?
    googleSearchQueries.forEach((x) => {
      this.bot.isMobile
        ? queries.push(x.topic)
        : queries.push(x.topic, ...x.related);
    });

    // Loop over Google search queries
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i] as string;

      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING",
        `${missingPoints} Points Remaining | Query: ${query}`,
      );

      searchCounters = await this.bingSearch(page, query);
      const newMissingPoints = this.calculatePoints(searchCounters);

      // If the new point amount is the same as before
      if (newMissingPoints === missingPoints) {
        stagnation++;
      } else {
        stagnation = 0;
      }

      missingPoints = newMissingPoints;

      if (missingPoints === 0) break;

      // Only for mobile searches - abort early if User-Agent is likely incorrect
      if (stagnation > MOBILE_STAGNATION_LIMIT && this.bot.isMobile) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Search didn't gain points for ${MOBILE_STAGNATION_LIMIT} iterations, likely bad User-Agent`,
          "warn",
        );
        break;
      }

      // If we didn't gain points for many iterations, assume it's stuck
      if (stagnation > DESKTOP_STAGNATION_LIMIT) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Search didn't gain points for ${DESKTOP_STAGNATION_LIMIT} iterations, aborting searches`,
          "warn",
        );
        stagnation = 0; // allow fallback loop below
        break;
      }
    }

    // Only for mobile searches
    if (missingPoints > 0 && this.bot.isMobile) {
      return;
    }

    // If we still got remaining search queries, generate extra ones
    if (missingPoints > 0) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING",
        `Search completed but we're missing ${missingPoints} points, generating extra searches`,
      );

      let i = 0;
      let fallbackRounds = 0;
      const extraRetries =
        this.bot.config.searchSettings.extraFallbackRetries || 1;
      while (missingPoints > 0 && fallbackRounds <= extraRetries) {
        const query = googleSearchQueries[i++] as GoogleSearch;
        if (!query) break;

        // Get related search terms to the Google search queries
        const relatedTerms = await this.getRelatedTerms(query?.topic);
        if (relatedTerms.length > 3) {
          // Filter related terms with semantic dedup to avoid Bing-provided duplicates
          const filteredRelated =
            this.bot.config.searchSettings.semanticDedup !== false
              ? this.semanticDedupStrings(
                  relatedTerms,
                  this.bot.config.searchSettings.semanticDedupThreshold ?? 0.65,
                )
              : relatedTerms;

          // Search for the first 2 related terms
          for (const term of filteredRelated.slice(1, 3)) {
            this.bot.log(
              this.bot.isMobile,
              "SEARCH-BING-EXTRA",
              `${missingPoints} Points Remaining | Query: ${term}`,
            );

            searchCounters = await this.bingSearch(page, term);
            const newMissingPoints = this.calculatePoints(searchCounters);

            // If the new point amount is the same as before
            if (newMissingPoints === missingPoints) {
              stagnation++;
            } else {
              stagnation = 0;
            }

            missingPoints = newMissingPoints;

            // If we satisfied the searches
            if (missingPoints === 0) {
              break;
            }

            // Try 5 more times, then we tried a total of 15 times, fair to say it's stuck
            if (stagnation > 5) {
              this.bot.log(
                this.bot.isMobile,
                "SEARCH-BING-EXTRA",
                "Search didn't gain point for 5 iterations aborting searches",
                "warn",
              );
              return;
            }
          }
          fallbackRounds++;
        }
      }
    }

    this.bot.log(this.bot.isMobile, "SEARCH-BING", "Completed searches");
  }

  private async bingSearch(searchPage: Page, query: string) {
    const platformControlKey = platform() === "darwin" ? "Meta" : "Control";

    // Try a max of 5 times
    for (let i = 0; i < 5; i++) {
      try {
        // This page had already been set to the Bing.com page or the previous search listing, we just need to select it
        searchPage = await this.bot.browser.utils.getLatestTab(searchPage);

        // Go to top of the page
        await searchPage.evaluate(() => {
          window.scrollTo(0, 0);
        });

        await this.bot.utils.wait(TIMEOUTS.SHORT);

        const searchBar = "#sb_form_q";
        // Prefer attached over visible to avoid strict visibility waits when overlays exist
        const box = searchPage.locator(searchBar);
        await box.waitFor({ state: "attached", timeout: 15000 });

        // Try dismissing overlays before interacting
        await this.bot.browser.utils.tryDismissAllMessages(searchPage);
        await this.bot.utils.wait(200);
        await this.bot.browser.utils.humanizePage(searchPage);

        let navigatedDirectly = false;
        try {
          // FIXED: Use HumanTyping instead of .fill() to avoid bot detection
          await box.focus({ timeout: 2000 }).catch(() => {
            /* ignore focus errors */
          });
          await this.bot.utils.wait(200);

          // Clear field using keyboard (natural)
          await searchPage.keyboard.down(platformControlKey);
          await searchPage.keyboard.press("A");
          await searchPage.keyboard.press("Backspace");
          await searchPage.keyboard.up(platformControlKey);

          // FIXED: Use HumanTyping for natural search query entry
          await HumanTyping.type(box, query, 1.5); // Fast typing (familiar search action)
          await searchPage.keyboard.press("Enter");
        } catch (typeErr) {
          // As a robust fallback, navigate directly to the search results URL
          const q = encodeURIComponent(query);
          const url = `${URLS.BING_SEARCH}?q=${q}`;
          await searchPage.goto(url);
          navigatedDirectly = true;
        }

        await this.bot.utils.wait(TIMEOUTS.LONG);

        // Bing.com in Chrome opens a new tab when searching via Enter; if we navigated directly, stay on current tab
        const resultPage = navigatedDirectly
          ? searchPage
          : await this.bot.browser.utils.getLatestTab(searchPage);
        this.searchPageURL = new URL(resultPage.url()).href; // Set the results page

        await this.bot.browser.utils.reloadBadPage(resultPage);

        if (this.bot.config.searchSettings.scrollRandomResults) {
          await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
          await this.randomScroll(resultPage);
        }

        if (this.bot.config.searchSettings.clickRandomResults) {
          await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
          await this.clickRandomLink(resultPage);
        }

        // Delay between searches
        const minDelay = this.bot.utils.stringToMs(
          this.bot.config.searchSettings.searchDelay.min,
        );
        const maxDelay = this.bot.utils.stringToMs(
          this.bot.config.searchSettings.searchDelay.max,
        );
        const adaptivePad = Math.min(
          4000,
          Math.max(0, this.bot.utils.randomNumber(0, 800)),
        );
        await this.bot.utils.wait(
          Math.floor(this.bot.utils.randomNumber(minDelay, maxDelay)) +
            adaptivePad,
        );

        return await this.bot.browser.func.getSearchPoints();
      } catch (error) {
        if (i === 4) {
          this.bot.log(
            this.bot.isMobile,
            "SEARCH-BING",
            `Failed after 5 retries: ${getErrorMessage(error)}`,
            "error",
          );
          break;
        }

        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Search failed: ${getErrorMessage(error)}`,
          "error",
        );
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-BING",
          `Retrying search, attempt ${i + 1}/5`,
          "warn",
        );

        // Reset the tabs
        const lastTab = await this.bot.browser.utils.getLatestTab(searchPage);
        await this.closeTabs(lastTab);

        await this.bot.utils.wait(TIMEOUTS.ACTIVITY_PAGE_LOAD);
      }
    }

    this.bot.log(
      this.bot.isMobile,
      "SEARCH-BING",
      "Search failed after 5 retries, ending",
      "error",
    );
    return await this.bot.browser.func.getSearchPoints();
  }

  private async getGoogleTrends(
    geoLocale: string = "US",
  ): Promise<GoogleSearch[]> {
    const queryTerms: GoogleSearch[] = [];
    this.bot.log(
      this.bot.isMobile,
      "SEARCH-GOOGLE-TRENDS",
      `Generating search queries, can take a while! | GeoLocale: ${geoLocale}`,
    );

    try {
      const request: AxiosRequestConfig = {
        url: "https://trends.google.com/_/TrendsUi/data/batchexecute",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`,
      };

      const response = await this.bot.axios.request(
        request,
        !this.bot.config.proxy.proxyGoogleTrends,
      );
      const rawText = response.data;

      const trendsData = this.extractJsonFromResponse(rawText);
      if (!trendsData) {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-GOOGLE-TRENDS",
          "Failed to parse Google Trends response",
          "error",
        );
        throw new Error("Failed to parse Google Trends response");
      }

      const mappedTrendsData = trendsData.map((query) => [
        query[0],
        query[9]!.slice(1),
      ]);
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-GOOGLE-TRENDS",
        `Found ${mappedTrendsData.length} search queries for ${geoLocale}`,
      );

      if (mappedTrendsData.length < 30 && geoLocale.toUpperCase() !== "US") {
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-GOOGLE-TRENDS",
          `Insufficient search queries (${mappedTrendsData.length} < 30), falling back to US`,
          "warn",
        );
        return this.getGoogleTrends();
      }

      for (const [topic, relatedQueries] of mappedTrendsData) {
        queryTerms.push({
          topic: topic as string,
          related: relatedQueries as string[],
        });
      }
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-GOOGLE-TRENDS",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }

    return queryTerms;
  }

  private extractJsonFromResponse(
    text: string,
  ): GoogleTrendsResponse[1] | null {
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          return JSON.parse(JSON.parse(trimmed)[0][2])[1];
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private async getRelatedTerms(term: string): Promise<string[]> {
    try {
      const request = {
        url: `https://api.bing.com/osjson.aspx?query=${term}`,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      };

      const response = await this.bot.axios.request(
        request,
        !this.bot.config.proxy.proxyBingTerms,
      );

      return response.data[1] as string[];
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-BING-RELATED",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }

    return [];
  }

  private async randomScroll(page: Page) {
    try {
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const totalHeight = await page.evaluate(() => document.body.scrollHeight);
      const randomScrollPosition = Math.floor(
        secureRandom() * (totalHeight - viewportHeight),
      );

      await page.evaluate((scrollPos: number) => {
        window.scrollTo(0, scrollPos);
      }, randomScrollPosition);
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-RANDOM-SCROLL",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  private async clickRandomLink(page: Page) {
    try {
      // Silent catch justified: Click is best-effort humanization, failure is acceptable
      await page
        .click("#b_results .b_algo h2", { timeout: 2000 })
        .catch(() => {});

      // Only used if the browser is not the edge browser (continue on Edge popup)
      await this.closeContinuePopup(page);

      // Stay for 10 seconds for page to load and "visit"
      await this.bot.utils.wait(TIMEOUTS.EXTRA_LONG);

      // Will get current tab if no new one is created, this will always be the visited site or the result page if it failed to click
      let lastTab = await this.bot.browser.utils.getLatestTab(page);

      let lastTabURL = new URL(lastTab.url()); // Get new tab info, this is the website we're visiting

      // Check if the URL is different from the original one, don't loop more than 5 times.
      let i = 0;
      while (lastTabURL.href !== this.searchPageURL && i < 5) {
        await this.closeTabs(lastTab);

        // End of loop, refresh lastPage
        lastTab = await this.bot.browser.utils.getLatestTab(page); // Finally update the lastTab var again
        lastTabURL = new URL(lastTab.url()); // Get new tab info
        i++;
      }
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-RANDOM-CLICK",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  private async closeTabs(lastTab: Page) {
    const browser = lastTab.context();
    const tabs = browser.pages();

    try {
      if (tabs.length > 2) {
        // If more than 2 tabs are open, close the last tab

        await lastTab.close();
        this.bot.log(
          this.bot.isMobile,
          "SEARCH-CLOSE-TABS",
          `More than 2 were open, closed the last tab: "${new URL(lastTab.url()).host}"`,
        );
      } else if (tabs.length === 1) {
        // If only 1 tab is open, open a new one to search in

        const newPage = await browser.newPage();
        await this.bot.utils.wait(TIMEOUTS.ONE_SECOND);

        await newPage.goto(this.bingHome);
        await this.bot.utils.wait(TIMEOUTS.LONG);
        this.searchPageURL = newPage.url();

        this.bot.log(
          this.bot.isMobile,
          "SEARCH-CLOSE-TABS",
          "There was only 1 tab open, created a new one",
        );
      } else {
        // Else reset the last tab back to the search listing or Bing.com

        lastTab = await this.bot.browser.utils.getLatestTab(lastTab);
        await lastTab.goto(
          this.searchPageURL ? this.searchPageURL : this.bingHome,
        );
      }
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "SEARCH-CLOSE-TABS",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  private calculatePoints(counters: Counters) {
    const mobileData = counters.mobileSearch?.[0]; // Mobile searches
    const genericData = counters.pcSearch?.[0]; // Normal searches
    const edgeData = counters.pcSearch?.[1]; // Edge searches

    const missingPoints =
      this.bot.isMobile && mobileData
        ? mobileData.pointProgressMax - mobileData.pointProgress
        : (edgeData ? edgeData.pointProgressMax - edgeData.pointProgress : 0) +
          (genericData
            ? genericData.pointProgressMax - genericData.pointProgress
            : 0);

    return missingPoints;
  }

  private async closeContinuePopup(page: Page) {
    try {
      // IMPROVED: Smart wait replaces fixed 1s timeout with adaptive detection
      const buttonResult = await waitForElementSmart(page, "#sacs_close", {
        initialTimeoutMs: 500,
        extendedTimeoutMs: 1000,
        state: "attached",
      });

      if (buttonResult.found && buttonResult.element) {
        await buttonResult.element.click();
      }
    } catch {
      // Non-critical: popup close is best-effort
    }
  }

  /**
   * Calculate Jaccard similarity between two strings (word-level)
   * Used for semantic deduplication to avoid ban-pattern queries
   */
  private jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Combined exact + semantic deduplication in single pass (performance optimized)
   * Filters both case-insensitive exact duplicates and semantically similar queries
   */
  private combinedDeduplication(
    queries: GoogleSearch[],
    threshold = 0.65,
  ): GoogleSearch[] {
    const result: GoogleSearch[] = [];
    const seen = new Set<string>(); // Track exact duplicates (case-insensitive)

    for (const query of queries) {
      const lower = query.topic.toLowerCase();

      // Check exact duplicate first (faster)
      if (seen.has(lower)) continue;

      // Check semantic similarity with existing results
      const isSimilar = result.some(
        (existing) =>
          this.jaccardSimilarity(query.topic, existing.topic) > threshold,
      );

      if (!isSimilar) {
        result.push(query);
        seen.add(lower);
      }
    }

    return result;
  }

  /**
   * Semantic deduplication for string arrays (used for related terms)
   */
  private semanticDedupStrings(terms: string[], threshold = 0.65): string[] {
    const result: string[] = [];
    for (const term of terms) {
      const isSimilar = result.some(
        (existing) => this.jaccardSimilarity(term, existing) > threshold,
      );
      if (!isSimilar) {
        result.push(term);
      }
    }
    return result;
  }
}
