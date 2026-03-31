/**
 * Mobile Flow Module
 * Extracted from index.ts to improve maintainability and testability
 *
 * Handles mobile browser automation:
 * - Login and session management
 * - OAuth token acquisition
 * - Daily check-in
 * - Read to earn
 * - Mobile searches
 * - Mobile retry logic
 */

import type { MicrosoftRewardsBot } from "../index";
import type { Account } from "../interface/Account";
import {
    closeBrowserSafely,
    createBrowserInstance,
} from "../util/browser/BrowserFactory";
import { getErrorMessage } from "../util/core/Utils";
import { MobileRetryTracker } from "../util/state/MobileRetryTracker";
import { handleCompromisedMode } from "./FlowUtils";

export interface MobileFlowResult {
  initialPoints: number;
  collectedPoints: number;
}

export class MobileFlow {
  private bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  /**
   * Execute the full mobile automation flow for an account
   *
   * Performs the following tasks in sequence:
   * 1. Mobile browser initialization with mobile user agent
   * 2. Microsoft account login
   * 3. OAuth token acquisition for mobile API access
   * 4. Daily check-in via mobile API
   * 5. Read to earn articles
   * 6. Mobile searches with retry logic
   *
   * @param account Account to process (email, password, totp, proxy)
   * @param retryTracker Retry tracker for mobile search failures (auto-created if not provided)
   * @returns Promise resolving to points collected during mobile flow
   * @throws {Error} If critical operation fails (login, OAuth)
   *
   * @example
   * ```typescript
   * const flow = new MobileFlow(bot)
   * const result = await flow.run(account)
   * // result.collectedPoints contains mobile points earned
   * ```
   */
  async run(
    account: Account,
    retryTracker = new MobileRetryTracker(
      this.bot.config.searchSettings.retryMobileSearchAmount,
    ),
  ): Promise<MobileFlowResult> {
    this.bot.log(true, "MOBILE-FLOW", "Starting mobile automation flow");

    // IMPROVED: Use centralized browser factory to eliminate duplication
    let browser = await createBrowserInstance(
      this.bot,
      account.proxy,
      account.email,
    );

    let keepBrowserOpen = false;
    let browserClosed = false;

    try {
      this.bot.homePage = await browser.newPage();

      this.bot.log(true, "MOBILE-FLOW", "Browser started successfully");

      // Login into MS Rewards, then respect compromised mode
      try {
        await this.bot.login.login(
          this.bot.homePage,
          account.email,
          account.password,
          account.totp,
        );
      } catch (loginErr) {
        const msg = getErrorMessage(loginErr);
        if (msg.includes("Target page, context or browser has been closed")) {
          this.bot.log(
            true,
            "MOBILE-FLOW",
            "Browser/context closed during login. Attempting one retry with a fresh browser context",
            "warn",
          );
          // Ensure previous browser/context is closed gracefully
          await closeBrowserSafely(this.bot, browser, account.email, true);

          // Create a fresh browser context and retry login once
          browser = await createBrowserInstance(
            this.bot,
            account.proxy,
            account.email,
          );
          this.bot.homePage = await browser.newPage();
          await this.bot.login.login(
            this.bot.homePage,
            account.email,
            account.password,
            account.totp,
          );
        } else {
          throw loginErr;
        }
      }

      if (this.bot.compromisedModeActive) {
        const reason = this.bot.compromisedReason || "security-issue";
        const result = await handleCompromisedMode(
          this.bot,
          account.email,
          reason,
          true,
        );
        keepBrowserOpen = result.keepBrowserOpen;
        return { initialPoints: 0, collectedPoints: 0 };
      }

      const accessToken = await this.bot.login.getMobileAccessToken(
        this.bot.homePage,
        account.email,
        account.totp,
      );
      await this.bot.browser.func.goHome(this.bot.homePage);

      // FIXED: Add retry logic for getDashboardData in case of page detachment
      let data;
      let dashboardRetries = 0;
      const MAX_DASHBOARD_RETRIES = 1; // One retry with fresh page

      while (dashboardRetries <= MAX_DASHBOARD_RETRIES) {
        try {
          data = await this.bot.browser.func.getDashboardData();
          break; // Success, exit retry loop
        } catch (dashboardError) {
          const msg = getErrorMessage(dashboardError);
          if (
            (msg.includes("detached") ||
              msg.includes("ERR_ABORTED") ||
              msg.includes("has been closed")) &&
            dashboardRetries < MAX_DASHBOARD_RETRIES
          ) {
            this.bot.log(
              true,
              "MOBILE-FLOW",
              "⚠️ Page detached/closed during getDashboardData - recreating page",
              "warn",
            );

            // Close old page and create new one
            try {
              await this.bot.homePage.close();
            } catch {
              /* Ignore close errors */
            }

            this.bot.homePage = await browser.newPage();
            await this.bot.browser.func.goHome(this.bot.homePage);
            dashboardRetries++;

            this.bot.log(
              true,
              "MOBILE-FLOW",
              `Retrying getDashboardData with fresh page (attempt ${dashboardRetries + 1})`,
              "log",
            );
          } else {
            // Not a recoverable error or max retries reached
            throw dashboardError;
          }
        }
      }

      if (!data) {
        throw new Error("Failed to retrieve dashboard data after retries");
      }

      // FIXED: Log warning when availablePoints is missing instead of silently defaulting
      const initialPoints = data.userStatus.availablePoints;
      if (initialPoints === undefined || initialPoints === null) {
        this.bot.log(
          true,
          "MOBILE-FLOW",
          "Warning: availablePoints is undefined/null, defaulting to 0. This may indicate dashboard data issues.",
          "warn",
        );
      }
      const safeInitialPoints = initialPoints ?? 0;

      const browserEarnablePoints =
        await this.bot.browser.func.getBrowserEarnablePoints();
      const appEarnablePoints =
        await this.bot.browser.func.getAppEarnablePoints(accessToken);

      const pointsCanCollect =
        browserEarnablePoints.mobileSearchPoints +
        appEarnablePoints.totalEarnablePoints;

      this.bot.log(
        true,
        "MOBILE-FLOW",
        `You can earn ${pointsCanCollect} points today (Browser: ${browserEarnablePoints.mobileSearchPoints} points, App: ${appEarnablePoints.totalEarnablePoints} points)`,
      );

      if (pointsCanCollect === 0) {
        this.bot.log(
          true,
          "MOBILE-FLOW",
          `Breakdown (mobile): browserSearch=${browserEarnablePoints.mobileSearchPoints} appTotal=${appEarnablePoints.totalEarnablePoints}`,
        );
        this.bot.log(
          true,
          "MOBILE-FLOW",
          "All mobile earnable buckets are zero. Causes: mobile searches already maxed, daily set finished, or daily rollover not reached yet. You can force execution by setting execution.runOnZeroPoints=true.",
          "log",
          "yellow",
        );
      }

      // If runOnZeroPoints is false and 0 points to earn, don't continue
      if (!this.bot.config.runOnZeroPoints && pointsCanCollect === 0) {
        this.bot.log(
          true,
          "MOBILE-FLOW",
          'No points to earn and "runOnZeroPoints" is set to "false", stopping!',
          "log",
          "yellow",
        );

        return {
          initialPoints: safeInitialPoints,
          collectedPoints: 0,
        };
      }

      // Do daily check in
      if (this.bot.config.workers.doDailyCheckIn) {
        await this.bot.activities.doDailyCheckIn(accessToken, data);
      }

      // Do read to earn
      if (this.bot.config.workers.doReadToEarn) {
        await this.bot.activities.doReadToEarn(accessToken, data);
      }

      // Do mobile searches
      const configuredRetries = Number(
        this.bot.config.searchSettings.retryMobileSearchAmount ?? 0,
      );
      const maxMobileRetries = Number.isFinite(configuredRetries)
        ? configuredRetries
        : 0;

      if (this.bot.config.workers.doMobileSearch) {
        // If no mobile searches data found, stop (Does not always exist on new accounts)
        if (data.userStatus.counters.mobileSearch) {
          // Open a new tab to where the tasks are going to be completed
          const workerPage = await browser.newPage();

          // Go to homepage on worker page
          await this.bot.browser.func.goHome(workerPage);

          // IMPROVED: Add error handling for mobile search to prevent flow termination
          try {
            await this.bot.activities.doSearch(workerPage, data);
          } catch (searchError) {
            const errorMsg = getErrorMessage(searchError);
            this.bot.log(
              true,
              "MOBILE-FLOW",
              `Mobile search failed: ${errorMsg}`,
              "error",
            );
            // Continue execution - let retry logic handle it below
          }

          // Fetch current search points
          const mobileSearchPoints = (
            await this.bot.browser.func.getSearchPoints()
          ).mobileSearch?.[0];

          if (
            mobileSearchPoints &&
            mobileSearchPoints.pointProgressMax -
              mobileSearchPoints.pointProgress >
              0
          ) {
            const shouldRetry = retryTracker.registerFailure();

            if (!shouldRetry) {
              const exhaustedAttempts = retryTracker.getAttemptCount();
              this.bot.log(
                true,
                "MOBILE-FLOW",
                `Max retry limit of ${maxMobileRetries} reached after ${exhaustedAttempts} attempt(s). Exiting retry loop`,
                "warn",
              );
            } else {
              const attempt = retryTracker.getAttemptCount();
              this.bot.log(
                true,
                "MOBILE-FLOW",
                `Attempt ${attempt}/${maxMobileRetries}: Unable to complete mobile searches, bad User-Agent? Increase search delay? Retrying...`,
                "log",
                "yellow",
              );

              // Close mobile browser before retrying to release resources
              // IMPROVED: Use centralized browser close utility
              await closeBrowserSafely(this.bot, browser, account.email, true);
              browserClosed = true;

              // Create a new browser and try again with the same tracker
              return await this.run(account, retryTracker);
            }
          }
        } else {
          this.bot.log(
            true,
            "MOBILE-FLOW",
            'Unable to fetch search points, your account is most likely too "new" for this! Try again later!',
            "warn",
          );
        }
      }

      const afterPointAmount = await this.bot.browser.func.getCurrentPoints();

      this.bot.log(
        true,
        "MOBILE-FLOW",
        `The script collected ${afterPointAmount - safeInitialPoints} points today`,
      );

      return {
        initialPoints: safeInitialPoints,
        collectedPoints: afterPointAmount - safeInitialPoints || 0,
      };
    } finally {
      if (!keepBrowserOpen && !browserClosed) {
        // IMPROVED: Use centralized browser close utility to eliminate duplication
        await closeBrowserSafely(this.bot, browser, account.email, true);
        browserClosed = true;
      }
    }
  }
}
