import { AxiosError, AxiosRequestConfig } from "axios";
import { CheerioAPI, load } from "cheerio";
import { BrowserContext, Page } from "rebrowser-playwright";

import { RETRY_LIMITS, SELECTORS, TIMEOUTS, URLS } from "../constants";
import { MicrosoftRewardsBot } from "../index";
import { AppUserData } from "../interface/AppUserData";
import {
    Counters,
    DashboardData,
    MorePromotion,
    PromotionalItem,
} from "../interface/DashboardData";
import { EarnablePoints } from "../interface/Points";
import { QuizData } from "../interface/QuizData";
import {
    waitForElementSmart,
    waitForPageReady,
} from "../util/browser/SmartWait";
import { extractBalancedObject, getErrorMessage } from "../util/core/Utils";
import { saveSessionData } from "../util/state/Load";

export class BrowserFunc {
  private bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  /**
   * Check if account is suspended using multiple detection methods
   * @param page Playwright page
   * @param iteration Current iteration number for logging
   * @returns true if suspended, false otherwise
   */
  private async checkAccountSuspension(
    page: Page,
    iteration: number,
  ): Promise<boolean> {
    // IMPROVED: Smart wait replaces fixed 500ms timeout with adaptive detection
    const headerResult = await waitForElementSmart(
      page,
      SELECTORS.SUSPENDED_ACCOUNT,
      {
        initialTimeoutMs: 500,
        extendedTimeoutMs: 500,
        state: "visible",
      },
    );
    const suspendedByHeader = headerResult.found;

    if (suspendedByHeader) {
      this.bot.log(
        this.bot.isMobile,
        "GO-HOME",
        `Account suspension detected by header selector (iteration ${iteration})`,
        "error",
      );
      return true;
    }

    // Secondary check: look for suspension text in main content area only
    try {
      const mainContent =
        (await page
          .locator("#contentContainer, #main, .main-content")
          .first()
          .textContent({ timeout: 500 })
          .catch(() => "")) || "";
      const suspensionPatterns = [
        /account\s+has\s+been\s+suspended/i,
        /suspended\s+due\s+to\s+unusual\s+activity/i,
        /your\s+account\s+is\s+temporarily\s+suspended/i,
      ];

      const isSuspended = suspensionPatterns.some((pattern) =>
        pattern.test(mainContent),
      );
      if (isSuspended) {
        this.bot.log(
          this.bot.isMobile,
          "GO-HOME",
          `Account suspension detected by content text (iteration ${iteration})`,
          "error",
        );
        return true;
      }
    } catch (error) {
      // Ignore errors in text check - not critical
      const errorMsg = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GO-HOME",
        `Suspension text check skipped: ${errorMsg}`,
        "warn",
      );
    }

    return false;
  }

  /**
   * Navigate the provided page to rewards homepage
   * @param {Page} page Playwright page
   */
  async goHome(page: Page) {
    try {
      // Always navigate to the real Microsoft Rewards URL (tracking is only done once in Login.ts)
      const baseURL = this.bot.getRewardsBaseURL();
      const dashboardURL = new URL(baseURL);

      if (page.url() === dashboardURL.href) {
        return;
      }

      const navigate = async () => {
        await page.goto(baseURL, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
      };

      try {
        await navigate();
      } catch (navErr) {
        const msg = getErrorMessage(navErr);
        if (/ERR_ABORTED/i.test(msg)) {
          this.bot.log(
            this.bot.isMobile,
            "GO-HOME",
            `Navigation aborted, retrying once: ${msg}`,
            "warn",
          );
          await this.bot.utils.wait(TIMEOUTS.SHORT);
          await navigate();
        } else {
          throw navErr;
        }
      }

      // FIXED: Check for HTTP 400 error (common transient Microsoft issue)
      // Microsoft sometimes returns HTTP 400 on first request - a simple reload fixes it
      let http400Retries = 0;
      const MAX_HTTP400_RETRIES = 3;

      while (http400Retries <= MAX_HTTP400_RETRIES) {
        await this.bot.utils.wait(TIMEOUTS.SHORT);

        const content = await page.content().catch(() => "");
        const hasHttp400 =
          content.includes("HTTP ERROR 400") ||
          content.includes("This page isn't working") ||
          content.includes("This page is not working") ||
          content.includes("Bad Request");

        if (hasHttp400) {
          http400Retries++;
          this.bot.log(
            this.bot.isMobile,
            "GO-HOME",
            `⚠️ HTTP 400 error detected (attempt ${http400Retries}/${MAX_HTTP400_RETRIES}) - this is a known Microsoft transient issue`,
            "warn",
          );

          if (http400Retries <= MAX_HTTP400_RETRIES) {
            this.bot.log(
              this.bot.isMobile,
              "GO-HOME",
              "Reloading page to resolve HTTP 400...",
              "log",
            );

            // Try reload first
            try {
              await page.reload({
                waitUntil: "domcontentloaded",
                timeout: 20000,
              });
              await this.bot.utils.wait(TIMEOUTS.MEDIUM);
            } catch (reloadErr) {
              // If reload fails, try full navigation
              this.bot.log(
                this.bot.isMobile,
                "GO-HOME",
                `Reload failed, trying full navigation: ${getErrorMessage(reloadErr)}`,
                "warn",
              );
              await navigate();
            }
          } else {
            this.bot.log(
              this.bot.isMobile,
              "GO-HOME",
              "⛔ HTTP 400 persists after all retries - may indicate a real server issue or ban",
              "error",
            );
            throw new Error(
              "HTTP 400 error persists after retries - check account status manually at " +
                baseURL,
            );
          }
        } else {
          // No HTTP 400, continue normally
          break;
        }
      }

      // IMPROVED: Smart page readiness check after navigation
      // FIXED: Use timeoutMs parameter with increased timeout for slower networks
      const readyResult = await waitForPageReady(page, {
        timeoutMs: 15000, // FIXED: 15s timeout to handle slower network conditions
        logFn: (msg) => this.bot.log(this.bot.isMobile, "GO-HOME", msg, "log"),
      });

      if (readyResult.timeMs > 8000) {
        this.bot.log(
          this.bot.isMobile,
          "GO-HOME",
          `Page took ${readyResult.timeMs}ms to be ready (slow)`,
          "warn",
        );
      }

      // IMPROVED: Wait for Custom Elements to be registered with proper timeout handling
      // FIXED: Use Promise.race to enforce actual 5s timeout (Playwright's timeout doesn't work with customElements.whenDefined)
      try {
        await Promise.race([
          page.evaluate(() => customElements.whenDefined("mee-card-group")),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Custom element timeout")), 5000),
          ),
        ]);
      } catch (error) {
        // FIXED: Silent fallback - custom element registration is best-effort, not critical
        // If it times out, we proceed with activities detection anyway
        this.bot.log(
          this.bot.isMobile,
          "GO-HOME",
          "mee-card-group custom element not registered within 5s (non-critical)",
          "log",
        );
      }

      // Track if activities were successfully found
      let activitiesFoundSuccessfully = false;

      for (
        let iteration = 1;
        iteration <= RETRY_LIMITS.GO_HOME_MAX;
        iteration++
      ) {
        await this.bot.utils.wait(TIMEOUTS.SHORT);
        await this.bot.browser.utils.tryDismissAllMessages(page);

        // IMPROVED: Try primary selector first with increased timeouts
        let activitiesResult = await waitForElementSmart(
          page,
          SELECTORS.MORE_ACTIVITIES,
          {
            initialTimeoutMs: 3000, // FIXED: Increased from 1000ms to 3000ms
            extendedTimeoutMs: 7000, // FIXED: Increased from 2000ms to 7000ms
            state: "attached",
            logFn: (msg) =>
              this.bot.log(this.bot.isMobile, "GO-HOME", msg, "log"),
          },
        );

        // IMPROVED: Try fallback selectors if primary fails
        if (!activitiesResult.found) {
          this.bot.log(
            this.bot.isMobile,
            "GO-HOME",
            "Primary selector failed, trying fallbacks...",
            "log",
          );

          for (const fallbackSelector of SELECTORS.MORE_ACTIVITIES_FALLBACKS) {
            activitiesResult = await waitForElementSmart(
              page,
              fallbackSelector,
              {
                initialTimeoutMs: 2000,
                extendedTimeoutMs: 3000,
                state: "attached",
                logFn: (msg) =>
                  this.bot.log(this.bot.isMobile, "GO-HOME", msg, "log"),
              },
            );

            if (activitiesResult.found) {
              this.bot.log(
                this.bot.isMobile,
                "GO-HOME",
                `Found activities using fallback: ${fallbackSelector}`,
                "log",
              );
              break;
            }
          }
        }

        if (activitiesResult.found) {
          this.bot.log(
            this.bot.isMobile,
            "GO-HOME",
            "Visited homepage successfully",
          );
          activitiesFoundSuccessfully = true;
          break;
        }

        // Activities not found yet - check if it's because account is suspended
        const isSuspended = await this.checkAccountSuspension(page, iteration);
        if (isSuspended) {
          throw new Error("Account has been suspended!");
        }

        // Not suspended, just activities not loaded yet - continue to next iteration
        this.bot.log(
          this.bot.isMobile,
          "GO-HOME",
          `Activities not found yet (iteration ${iteration}/${RETRY_LIMITS.GO_HOME_MAX}), retrying...`,
          "warn",
        );

        // Below runs if the homepage was unable to be visited
        const currentURL = new URL(page.url());

        if (currentURL.hostname !== dashboardURL.hostname) {
          await this.bot.browser.utils.tryDismissAllMessages(page);

          await this.bot.utils.wait(TIMEOUTS.ONE_SECOND);
          await page.goto(baseURL);

          // IMPROVED: Wait for page ready after redirect
          // FIXED: Use timeoutMs parameter with increased timeout
          await waitForPageReady(page, {
            timeoutMs: 15000, // FIXED: 15s timeout to handle slower network conditions
            logFn: (msg) =>
              this.bot.log(this.bot.isMobile, "GO-HOME", msg, "log"),
          });
        } else {
          // FIXED: We're on the right URL but activities not found - force page reload to trigger DOM re-render
          // This fixes the issue where Tyler needs to manually refresh to see activities
          this.bot.log(
            this.bot.isMobile,
            "GO-HOME",
            "On correct URL but activities missing - forcing page reload to trigger DOM render",
            "warn",
          );

          try {
            // IMPROVED: Try alternative reload strategies based on iteration
            if (iteration === 1) {
              // First attempt: Simple reload
              await page.reload({
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
            } else if (iteration === 2) {
              // Second attempt: Navigate to full dashboard URL (not just base)
              this.bot.log(
                this.bot.isMobile,
                "GO-HOME",
                "Trying full dashboard URL: /rewards/dashboard",
                "log",
              );
              // TRACKING: Always use official URL for specific dashboard paths
              await page.goto(`${URLS.REWARDS_BASE}/rewards/dashboard`, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
            } else if (iteration === 3) {
              // Third attempt: Clear localStorage and reload
              this.bot.log(
                this.bot.isMobile,
                "GO-HOME",
                "Clearing localStorage and reloading",
                "log",
              );
              await page.evaluate(() => localStorage.clear());
              await page.reload({
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
            } else {
              // Final attempts: Hard reload with cache bypass
              await page.reload({ waitUntil: "networkidle", timeout: 20000 });
            }

            await waitForPageReady(page, {
              timeoutMs: 10000,
              logFn: (msg) =>
                this.bot.log(this.bot.isMobile, "GO-HOME", msg, "log"),
            });

            // Try scrolling to force lazy-loaded elements to render
            await page.evaluate(() => {
              window.scrollTo(0, 200);
              window.scrollTo(0, 0);
            });

            await this.bot.utils.wait(TIMEOUTS.ONE_SECOND);
          } catch (reloadError) {
            const reloadMsg = getErrorMessage(reloadError);
            this.bot.log(
              this.bot.isMobile,
              "GO-HOME",
              `Page reload failed: ${reloadMsg}`,
              "warn",
            );
          }
        }

        await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
      }

      // CRITICAL FIX: After max retries, throw error if activities still not found
      // This prevents infinite retry loops by properly failing after exhausting all attempts
      if (!activitiesFoundSuccessfully) {
        throw new Error(
          `Failed to find activities after ${RETRY_LIMITS.GO_HOME_MAX} retry attempts. ` +
            `Possible causes: ` +
            `1) Account has no available activities today (check manually at ${baseURL}), ` +
            `2) Microsoft Rewards page structure changed - update bot to latest version, ` +
            `3) Network/regional issues preventing full page load, ` +
            `4) Account may be flagged/restricted by Microsoft (check account status manually), ` +
            `5) Anti-bot detection - try enabling humanization or running manually to verify.`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GO-HOME",
        `[goHome] Navigation failed: ${errorMessage}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Fetch user dashboard data
   * @returns {DashboardData} Object of user bing rewards dashboard data
   */
  async getDashboardData(page?: Page): Promise<DashboardData> {
    const target = page ?? this.bot.homePage;
    const dashboardURL = new URL(URLS.REWARDS_BASE);
    const currentURL = new URL(target.url());

    try {
      // Check if account is suspended BEFORE attempting to fetch dashboard data
      const suspendedError = await target
        .locator("#rewards-user-suspended-error, #fraudErrorBody")
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (suspendedError) {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "⛔ Account suspension detected, checking details...",
          "error",
        );

        // Use SecurityDetector to handle suspension
        const { SecurityDetector } =
          await import("../functions/login/SecurityDetector");
        const { SecurityUtils } =
          await import("../functions/login/SecurityUtils");
        const securityUtils = new SecurityUtils(this.bot);
        const securityDetector = new SecurityDetector(this.bot, securityUtils);

        await securityDetector.checkAccountSuspended(target);
        throw new Error(
          "Account suspended by Microsoft Rewards - account disabled in accounts.jsonc",
        );
      }

      // Should never happen since tasks are opened in a new tab!
      if (currentURL.hostname !== dashboardURL.hostname) {
        this.bot.log(
          this.bot.isMobile,
          "DASHBOARD-DATA",
          "Provided page did not equal dashboard page, redirecting to dashboard page",
        );
        await this.goHome(target);
      }

      // Reload with retry (IMPROVED: Increased to 3 attempts for better reliability)
      await this.reloadPageWithRetry(target, 3);

      // IMPROVED: Smart wait for activities element
      const activitiesResult = await waitForElementSmart(
        target,
        SELECTORS.MORE_ACTIVITIES,
        {
          initialTimeoutMs: 3000,
          extendedTimeoutMs: 7000,
          state: "attached",
          logFn: (msg) =>
            this.bot.log(this.bot.isMobile, "GET-DASHBOARD-DATA", msg, "log"),
        },
      );

      if (!activitiesResult.found) {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          `Activities element not found after ${activitiesResult.timeMs}ms, attempting to proceed anyway`,
          "warn",
        );
      }

      let scriptContent = await this.extractDashboardScript(target);

      if (!scriptContent) {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "Dashboard script not found on first try, attempting recovery",
          "warn",
        );

        // Force a navigation retry once before failing hard
        await this.goHome(target);

        // IMPROVED: Smart page readiness check instead of fixed wait
        // FIXED: Increased timeout from 15s to 30s for slow/unstable connections
        await waitForPageReady(target, {
          timeoutMs: 30000, // FIXED: 30s timeout for dashboard recovery (was 15s)
          logFn: (msg) =>
            this.bot.log(this.bot.isMobile, "GET-DASHBOARD-DATA", msg, "log"),
        }).catch((error) => {
          const errorMsg = getErrorMessage(error);
          this.bot.log(
            this.bot.isMobile,
            "GET-DASHBOARD-DATA",
            `Dashboard recovery load incomplete: ${errorMsg}`,
            "warn",
          );
          // IMPROVED: Detect network issues specifically
          if (
            errorMsg.includes("net::") ||
            errorMsg.includes("ERR_") ||
            errorMsg.includes("timeout")
          ) {
            this.bot.log(
              this.bot.isMobile,
              "GET-DASHBOARD-DATA",
              "⚠️ Network connectivity issue detected - check internet connection",
              "warn",
            );
          }
        });

        scriptContent = await this.extractDashboardScript(target);

        if (!scriptContent) {
          this.bot.log(
            this.bot.isMobile,
            "GET-DASHBOARD-DATA",
            "Dashboard data not found within script",
            "error",
          );
          throw new Error(
            "Dashboard data not found within script - check page structure",
          );
        }
      }

      // Extract the dashboard object from the script content
      const dashboardData = await this.parseDashboardFromScript(
        target,
        scriptContent,
      );

      if (!dashboardData) {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "Unable to parse dashboard script",
          "error",
        );
        throw new Error(
          "Unable to parse dashboard script - inspect recent logs and page markup",
        );
      }

      return dashboardData;
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // IMPROVED: Categorize error types for better debugging
      let errorCategory = "UNKNOWN";
      if (errorMessage.includes("Timeout")) {
        errorCategory = "TIMEOUT";
      } else if (
        errorMessage.includes("net::") ||
        errorMessage.includes("ERR_")
      ) {
        errorCategory = "NETWORK";
      } else if (
        errorMessage.includes("closed") ||
        errorMessage.includes("detached") ||
        errorMessage.includes("ERR_ABORTED")
      ) {
        errorCategory = "BROWSER_CLOSED";
      } else if (errorMessage.includes("suspended")) {
        errorCategory = "ACCOUNT_SUSPENDED";
      }

      this.bot.log(
        this.bot.isMobile,
        "GET-DASHBOARD-DATA",
        `[getDashboardData] Failed to fetch dashboard data [${errorCategory}]: ${errorMessage}`,
        "error",
      );

      // IMPROVED: Provide actionable suggestions based on error type
      if (errorCategory === "TIMEOUT" || errorCategory === "NETWORK") {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "💡 Suggestion: Check internet connection or try increasing timeouts in config",
          "warn",
        );
      } else if (errorCategory === "BROWSER_CLOSED") {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "💡 Browser/page was closed or detached - this requires page recreation by the flow",
          "warn",
        );
      } else if (errorCategory === "ACCOUNT_SUSPENDED") {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          "💡 This account has been suspended by Microsoft and will be disabled",
          "warn",
        );
      }

      throw error;
    }
  }

  /**
   * Reload page with retry logic
   * FIXED: Increased timeout and added explicit reload timeout to prevent blocking
   * IMPROVED: Added navigation fallback and better error handling
   */
  private async reloadPageWithRetry(
    page: Page,
    maxAttempts: number,
  ): Promise<void> {
    const startTime = Date.now();
    const MAX_TOTAL_TIME_MS = 60000; // FIXED: 60 seconds max total (was 30s)
    const RELOAD_TIMEOUT_MS = 20000; // FIXED: 20 seconds per reload attempt
    let lastError: unknown = null;
    let successfulReload = false;

    this.bot.log(
      this.bot.isMobile,
      "GET-DASHBOARD-DATA",
      `Starting page reload with ${maxAttempts} max attempts`,
      "log",
    );

    // FIXED: Check if page is valid before attempting reload
    try {
      const pageUrl = page.url();
      if (!pageUrl) {
        throw new Error("Page appears to be closed or detached");
      }
    } catch (checkError) {
      this.bot.log(
        this.bot.isMobile,
        "GET-DASHBOARD-DATA",
        `⛔ Page validation failed: ${getErrorMessage(checkError)} - cannot reload`,
        "error",
      );
      throw new Error(
        "Page is closed or invalid, cannot perform reload: " +
          getErrorMessage(checkError),
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Check global timeout
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime > MAX_TOTAL_TIME_MS) {
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          `Reload retry exceeded total timeout (${MAX_TOTAL_TIME_MS}ms after ${elapsedTime}ms)`,
          "warn",
        );
        break;
      }

      try {
        // FIXED: Add explicit timeout to page.reload to prevent 30s default blocking
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: RELOAD_TIMEOUT_MS,
        });
        await this.bot.utils.wait(
          this.bot.isMobile ? TIMEOUTS.LONG : TIMEOUTS.MEDIUM,
        );
        lastError = null;
        successfulReload = true;
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          `Page reloaded successfully on attempt ${attempt}`,
          "log",
        );
        break;
      } catch (re) {
        lastError = re;
        const msg = getErrorMessage(re);
        this.bot.log(
          this.bot.isMobile,
          "GET-DASHBOARD-DATA",
          `Reload failed attempt ${attempt}/${maxAttempts}: ${msg}`,
          "warn",
        );

        // FIXED: Handle fatal page states - detached, closed, or aborted
        if (
          msg.includes("has been closed") ||
          msg.includes("detached") ||
          msg.includes("ERR_ABORTED")
        ) {
          this.bot.log(
            this.bot.isMobile,
            "GET-DASHBOARD-DATA",
            "⛔ Page closed/detached/aborted - cannot recover, stopping reload attempts",
            "error",
          );
          break; // Cannot recover from closed/detached page
        }

        // IMPROVED: Try navigation fallback on timeout or network errors (but NOT on detached/aborted)
        if (
          (msg.includes("Timeout") ||
            msg.includes("Navigation") ||
            (msg.includes("net::") &&
              !msg.includes("ERR_ABORTED") &&
              !msg.includes("detached"))) &&
          attempt < maxAttempts
        ) {
          this.bot.log(
            this.bot.isMobile,
            "GET-DASHBOARD-DATA",
            "Reload timeout/navigation error - trying direct navigation fallback",
            "warn",
          );
          try {
            await this.goHome(page);
            successfulReload = true; // Navigation worked as fallback
            lastError = null;
            this.bot.log(
              this.bot.isMobile,
              "GET-DASHBOARD-DATA",
              "Direct navigation fallback succeeded",
              "log",
            );
            break;
          } catch (navError) {
            this.bot.log(
              this.bot.isMobile,
              "GET-DASHBOARD-DATA",
              `Navigation fallback failed: ${getErrorMessage(navError)}`,
              "warn",
            );
            // Continue to next retry attempt
          }
        }

        // Wait before retry with exponential backoff
        if (attempt < maxAttempts) {
          const backoffDelay = TIMEOUTS.ONE_SECOND * attempt; // 1s, 2s, 3s...
          await this.bot.utils.wait(backoffDelay);
        }
      }
    }

    // If we still have an error after all attempts, throw it
    if (lastError && !successfulReload) {
      this.bot.log(
        this.bot.isMobile,
        "GET-DASHBOARD-DATA",
        "All reload attempts exhausted, throwing last error",
        "error",
      );
      throw lastError;
    }
  }

  /**
   * Extract dashboard script from page
   */
  private async extractDashboardScript(page: Page): Promise<string | null> {
    return await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll("script"));
      const dashboardPatterns = ["var dashboard", "dashboard=", "dashboard :"];

      const targetScript = scripts.find((script) => {
        const text = script.innerText;
        return (
          text && dashboardPatterns.some((pattern) => text.includes(pattern))
        );
      });

      return targetScript?.innerText || null;
    });
  }

  /**
   * Parse dashboard object from script content
   * IMPROVED: Enhanced validation with structure checks
   */
  private async parseDashboardFromScript(
    _page: Page,
    scriptContent: string,
  ): Promise<DashboardData | null> {
    try {
      const anchors: (string | RegExp)[] = [
        /var\s+dashboard\s*=\s*/,
        /dashboard\s*=\s*/,
        /var\s+dashboard\s*:\s*/,
      ];

      for (const anchor of anchors) {
        const objStr = extractBalancedObject(scriptContent, anchor, 1000000);
        if (!objStr) continue;

        const trimmed = objStr.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;

        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed !== "object" || parsed === null) continue;
          if (!parsed.userStatus || typeof parsed.userStatus !== "object")
            continue;
          return parsed as DashboardData;
        } catch {
          // Try next anchor
          continue;
        }
      }

      return null;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GET-DASHBOARD-DATA",
        `Dashboard parse error: ${errorMessage}`,
        "error",
      );
      return null;
    }
  }

  /**
   * Get search point counters
   * @returns {Counters} Object of search counter data
   */
  async getSearchPoints(): Promise<Counters> {
    const dashboardData = await this.getDashboardData(); // Always fetch newest data

    return dashboardData.userStatus.counters;
  }

  /**
   * Get total earnable points with web browser
   * @returns {number} Total earnable points
   */
  async getBrowserEarnablePoints(): Promise<EarnablePoints> {
    try {
      let desktopSearchPoints = 0;
      let mobileSearchPoints = 0;
      let dailySetPoints = 0;
      let morePromotionsPoints = 0;

      // IMPROVED: Add timing information for performance monitoring
      const startTime = Date.now();
      this.bot.log(
        this.bot.isMobile,
        "GET-BROWSER-EARNABLE-POINTS",
        "Fetching dashboard data to calculate points...",
        "log",
      );

      const data = await this.getDashboardData();

      const fetchTime = Date.now() - startTime;
      this.bot.log(
        this.bot.isMobile,
        "GET-BROWSER-EARNABLE-POINTS",
        `Dashboard data fetched in ${fetchTime}ms`,
        "log",
      );

      // Desktop Search Points
      if (data.userStatus.counters.pcSearch?.length) {
        data.userStatus.counters.pcSearch.forEach(
          (x) => (desktopSearchPoints += x.pointProgressMax - x.pointProgress),
        );
      }

      // Mobile Search Points
      if (data.userStatus.counters.mobileSearch?.length) {
        data.userStatus.counters.mobileSearch.forEach(
          (x) => (mobileSearchPoints += x.pointProgressMax - x.pointProgress),
        );
      }

      // Daily Set
      data.dailySetPromotions[this.bot.utils.getFormattedDate()]?.forEach(
        (x) => (dailySetPoints += x.pointProgressMax - x.pointProgress),
      );

      // More Promotions
      if (data.morePromotions?.length) {
        data.morePromotions.forEach((x) => {
          // Only count points from supported activities
          if (
            ["quiz", "urlreward"].includes(x.promotionType) &&
            x.exclusiveLockedFeatureStatus !== "locked"
          ) {
            morePromotionsPoints += x.pointProgressMax - x.pointProgress;
          }
        });
      }

      const totalEarnablePoints =
        desktopSearchPoints +
        mobileSearchPoints +
        dailySetPoints +
        morePromotionsPoints;

      return {
        dailySetPoints,
        morePromotionsPoints,
        desktopSearchPoints,
        mobileSearchPoints,
        totalEarnablePoints,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // IMPROVED: Better error context for point calculation failures
      let errorHint = "";
      if (errorMessage.includes("Timeout") || errorMessage.includes("net::")) {
        errorHint = " (likely network/timeout issue from getDashboardData)";
      } else if (errorMessage.includes("suspended")) {
        errorHint = " (account suspended by Microsoft)";
      }

      this.bot.log(
        this.bot.isMobile,
        "GET-BROWSER-EARNABLE-POINTS",
        `[getBrowserEarnablePoints] Failed to calculate earnable points${errorHint}: ${errorMessage}`,
        "error",
      );

      // IMPROVED: Return zero points instead of throwing to allow bot to continue
      // This prevents complete failure if point calculation fails
      this.bot.log(
        this.bot.isMobile,
        "GET-BROWSER-EARNABLE-POINTS",
        "Returning zero points to allow bot to continue despite error",
        "warn",
      );

      return {
        dailySetPoints: 0,
        morePromotionsPoints: 0,
        desktopSearchPoints: 0,
        mobileSearchPoints: 0,
        totalEarnablePoints: 0,
      };
    }
  }

  /**
   * Get total earnable points with mobile app
   * @returns {number} Total earnable points
   */
  async getAppEarnablePoints(accessToken: string) {
    try {
      const points = {
        readToEarn: 0,
        checkIn: 0,
        totalEarnablePoints: 0,
      };

      const eligibleOffers = [
        "ENUS_readarticle3_30points",
        "Gamification_Sapphire_DailyCheckIn",
      ];

      const data = await this.getDashboardData();
      // Guard against missing profile/attributes and undefined settings
      let geoLocale = data?.userProfile?.attributes?.country || "US";
      const useGeo = !!this.bot?.config?.searchSettings?.useGeoLocaleQueries;
      geoLocale =
        useGeo && typeof geoLocale === "string" && geoLocale.length === 2
          ? geoLocale.toLowerCase()
          : "us";

      const userDataRequest: AxiosRequestConfig = {
        url: URLS.APP_USER_DATA,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Rewards-Country": geoLocale,
          "X-Rewards-Language": "en",
        },
      };

      let userDataResponse: AppUserData;

      try {
        userDataResponse = (await this.bot.axios.request(userDataRequest)).data;
      } catch (requestError) {
        if (this.isPlainHttpToHttpsPortError(requestError)) {
          this.bot.log(
            this.bot.isMobile,
            "GET-APP-EARNABLE-POINTS",
            "[getAppEarnablePoints] Plain HTTP sent to HTTPS port - retrying without proxy",
            "warn",
          );
          userDataResponse = (
            await this.bot.axios.request(userDataRequest, true)
          ).data;
        } else {
          throw requestError;
        }
      }
      const userData = userDataResponse.response;
      const eligibleActivities = userData.promotions.filter((x) =>
        eligibleOffers.includes(x.attributes.offerid ?? ""),
      );

      for (const item of eligibleActivities) {
        if (item.attributes.type === "msnreadearn") {
          points.readToEarn =
            parseInt(item.attributes.pointmax ?? "", 10) -
            parseInt(item.attributes.pointprogress ?? "", 10);
          break;
        } else if (item.attributes.type === "checkin") {
          const checkInDay = parseInt(item.attributes.progress ?? "", 10) % 7;
          const today = new Date();
          const lastUpdated = new Date(item.attributes.last_updated ?? "");

          if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
            points.checkIn = parseInt(
              item.attributes[`day_${checkInDay + 1}_points`] ?? "",
              10,
            );
          }
          break;
        }
      }

      points.totalEarnablePoints = points.readToEarn + points.checkIn;

      return points;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GET-APP-EARNABLE-POINTS",
        `[getAppEarnablePoints] Failed to fetch app earnable points: ${errorMessage}`,
        "error",
      );
      throw error;
    }
  }

  private isPlainHttpToHttpsPortError(error: unknown): boolean {
    const axiosError = error as AxiosError | undefined;
    const status = axiosError?.response?.status;
    const data = axiosError?.response?.data;
    const body = typeof data === "string" ? data : JSON.stringify(data ?? "");
    return (
      status === 400 &&
      /plain\s+http\s+request\s+was\s+sent\s+to\s+https\s+port/i.test(body)
    );
  }

  /**
   * Get current point amount
   * @returns {number} Current total point amount
   */
  async getCurrentPoints(): Promise<number> {
    try {
      const data = await this.getDashboardData();

      return data.userStatus.availablePoints;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GET-CURRENT-POINTS",
        `[getCurrentPoints] Failed to fetch current points: ${errorMessage}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Parse quiz data from provided page
   * @param {Page} page Playwright page
   * @returns {QuizData} Quiz data object
   */
  async getQuizData(page: Page): Promise<QuizData> {
    try {
      // Wait for page to be fully loaded
      await page.waitForLoadState("domcontentloaded");
      await this.bot.utils.wait(TIMEOUTS.MEDIUM);

      const html = await page.content();
      const $ = load(html);

      // Try multiple possible variable names
      const possibleVariables = [
        "_w.rewardsQuizRenderInfo",
        "rewardsQuizRenderInfo",
        "_w.quizRenderInfo",
        "quizRenderInfo",
      ];

      let scriptContent = "";
      let foundVariable = "";

      for (const varName of possibleVariables) {
        scriptContent =
          $("script")
            .toArray()
            .map((el) => $(el).text())
            .find((t) => t.includes(varName)) || "";

        if (scriptContent) {
          foundVariable = varName;
          break;
        }
      }

      if (scriptContent && foundVariable) {
        const anchor = new RegExp(
          foundVariable.replace(/\./g, "\\.") + "\\s*=\\s*",
        );
        const objStr = extractBalancedObject(scriptContent, anchor, 500000);
        if (objStr) {
          try {
            const quizData = JSON.parse(objStr);
            this.bot.log(
              this.bot.isMobile,
              "GET-QUIZ-DATA",
              `Found quiz data using variable: ${foundVariable}`,
              "log",
            );
            return quizData;
          } catch (e) {
            const msg = getErrorMessage(e);
            this.bot.log(
              this.bot.isMobile,
              "GET-QUIZ-DATA",
              `Quiz JSON parse failed for ${foundVariable}: ${msg}`,
              "error",
            );
            throw new Error(`Quiz data JSON parse failed: ${msg}`);
          }
        }

        this.bot.log(
          this.bot.isMobile,
          "GET-QUIZ-DATA",
          `Variable ${foundVariable} found but could not extract JSON data`,
          "error",
        );
        throw new Error(
          `Quiz data variable ${foundVariable} found but JSON extraction failed`,
        );
      } else {
        // Log available scripts for debugging
        const allScripts = $("script")
          .toArray()
          .map((el) => $(el).text())
          .filter((t) => t.length > 0)
          .map((t) => t.substring(0, 100));

        this.bot.log(
          this.bot.isMobile,
          "GET-QUIZ-DATA",
          `Script not found. Tried variables: ${possibleVariables.join(", ")}`,
          "error",
        );
        this.bot.log(
          this.bot.isMobile,
          "GET-QUIZ-DATA",
          `Found ${allScripts.length} scripts on page`,
          "warn",
        );

        this.bot.log(
          this.bot.isMobile,
          "GET-QUIZ-DATA",
          "Script containing quiz data not found",
          "error",
        );
        throw new Error(
          "Script containing quiz data not found - check page structure",
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "GET-QUIZ-DATA",
        `[getQuizData] Failed to extract quiz data: ${errorMessage}`,
        "error",
      );
      throw error;
    }
  }

  async waitForQuizRefresh(page: Page): Promise<boolean> {
    try {
      // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive 2s+5s detection
      const result = await waitForElementSmart(page, SELECTORS.QUIZ_CREDITS, {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "QUIZ-REFRESH", msg),
      });

      if (!result.found) {
        this.bot.log(
          this.bot.isMobile,
          "QUIZ-REFRESH",
          "Quiz credits element not found",
          "error",
        );
        return false;
      }

      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
      return true;
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "QUIZ-REFRESH",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
      return false;
    }
  }

  async checkQuizCompleted(page: Page): Promise<boolean> {
    try {
      // IMPROVED: Smart wait replaces fixed 2s timeout with adaptive detection
      const result = await waitForElementSmart(page, SELECTORS.QUIZ_COMPLETE, {
        initialTimeoutMs: 1000,
        extendedTimeoutMs: TIMEOUTS.MEDIUM_LONG,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "QUIZ-COMPLETE", msg),
      });

      if (!result.found) {
        return false;
      }

      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
      return true;
    } catch (error) {
      return false;
    }
  }

  async loadInCheerio(page: Page): Promise<CheerioAPI> {
    const html = await page.content();
    const $ = load(html);

    return $;
  }

  async getPunchCardActivity(
    page: Page,
    activity: PromotionalItem | MorePromotion,
  ): Promise<string> {
    let selector = "";
    try {
      const html = await page.content();
      const $ = load(html);

      const element = $(".offer-cta")
        .toArray()
        .find((x: unknown) => {
          const el = x as { attribs?: { href?: string } };
          return !!el.attribs?.href?.includes(activity.offerId);
        });
      if (element) {
        selector = `a[href*="${element.attribs.href}"]`;
      }
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "GET-PUNCHCARD-ACTIVITY",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }

    return selector;
  }

  async closeBrowser(browser: BrowserContext, email: string) {
    try {
      // Save cookies
      await saveSessionData(
        this.bot.config.sessionPath,
        browser,
        email,
        this.bot.isMobile,
      );

      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);

      // Close browser
      await browser.close();
      this.bot.log(
        this.bot.isMobile,
        "CLOSE-BROWSER",
        "Browser closed cleanly!",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "CLOSE-BROWSER",
        `[closeBrowser] Failed to close browser cleanly: ${errorMessage}`,
        "error",
      );
      throw error;
    }
  }
}
