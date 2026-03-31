/**
 * Desktop Flow Module
 * Extracted from index.ts to improve maintainability and testability
 *
 * Handles desktop browser automation:
 * - Login and session management
 * - Daily set completion
 * - More promotions
 * - Punch cards
 * - Desktop searches
 */

import type { MicrosoftRewardsBot } from "../index";
import type { Account } from "../interface/Account";
import {
    closeBrowserSafely,
    createBrowserInstance,
} from "../util/browser/BrowserFactory";
import { getErrorMessage } from "../util/core/Utils";
import { handleCompromisedMode } from "./FlowUtils";

export interface DesktopFlowResult {
  initialPoints: number;
  collectedPoints: number;
}

export class DesktopFlow {
  private bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  /**
   * Execute the full desktop automation flow for an account
   *
   * Performs the following tasks in sequence:
   * 1. Browser initialization with fingerprinting
   * 2. Microsoft account login with 2FA support
   * 3. Daily set completion
   * 4. More promotions (quizzes, polls, etc.)
   * 5. Punch cards
   * 6. Desktop searches
   *
   * @param account Account to process (email, password, totp, proxy)
   * @returns Promise resolving to points collected during the flow
   * @throws {Error} If critical operation fails (login, browser init)
   *
   * @example
   * ```typescript
   * const flow = new DesktopFlow(bot)
   * const result = await flow.run(account)
   * // result.collectedPoints contains points earned
   * ```
   */
  async run(account: Account): Promise<DesktopFlowResult> {
    this.bot.log(false, "DESKTOP-FLOW", "Starting desktop automation flow");

    // IMPROVED: Use centralized browser factory to eliminate duplication
    let browser = await createBrowserInstance(
      this.bot,
      account.proxy,
      account.email,
    );

    let keepBrowserOpen = false;

    try {
      this.bot.homePage = await browser.newPage();

      this.bot.log(false, "DESKTOP-FLOW", "Browser started successfully");

      // Login into MS Rewards, then optionally stop if compromised
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
            false,
            "DESKTOP-FLOW",
            "Browser/context closed during login. Attempting one retry with a fresh browser context",
            "warn",
          );
          // Ensure previous browser/context is closed gracefully
          await closeBrowserSafely(this.bot, browser, account.email, false);

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
          false,
        );
        keepBrowserOpen = result.keepBrowserOpen;
        return { initialPoints: 0, collectedPoints: 0 };
      }

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
              false,
              "DESKTOP-FLOW",
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
              false,
              "DESKTOP-FLOW",
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

      const initial = data.userStatus.availablePoints;

      this.bot.log(false, "DESKTOP-FLOW", `Current point count: ${initial}`);

      const browserEarnablePoints =
        await this.bot.browser.func.getBrowserEarnablePoints();

      // Tally all the desktop points
      const pointsCanCollect =
        browserEarnablePoints.dailySetPoints +
        browserEarnablePoints.desktopSearchPoints +
        browserEarnablePoints.morePromotionsPoints;

      this.bot.log(
        false,
        "DESKTOP-FLOW",
        `You can earn ${pointsCanCollect} points today`,
      );

      if (pointsCanCollect === 0) {
        // Extra diagnostic breakdown so users know WHY it's zero
        this.bot.log(
          false,
          "DESKTOP-FLOW",
          `Breakdown (desktop): dailySet=${browserEarnablePoints.dailySetPoints} search=${browserEarnablePoints.desktopSearchPoints} promotions=${browserEarnablePoints.morePromotionsPoints}`,
        );
        this.bot.log(
          false,
          "DESKTOP-FLOW",
          "All desktop earnable buckets are zero. This usually means: tasks already completed today OR the daily reset has not happened yet for your time zone. If you still want to force run activities set execution.runOnZeroPoints=true in config.",
          "log",
          "yellow",
        );
      }

      // If runOnZeroPoints is false and 0 points to earn, don't continue
      if (!this.bot.config.runOnZeroPoints && pointsCanCollect === 0) {
        this.bot.log(
          false,
          "DESKTOP-FLOW",
          'No points to earn and "runOnZeroPoints" is set to "false", stopping!',
          "log",
          "yellow",
        );
        return { initialPoints: initial, collectedPoints: 0 };
      }

      // Open a new tab to where the tasks are going to be completed
      const workerPage = await browser.newPage();

      // Go to homepage on worker page
      await this.bot.browser.func.goHome(workerPage);

      // Complete daily set
      if (this.bot.config.workers.doDailySet) {
        await this.bot.workers.doDailySet(workerPage, data);
      }

      // Complete more promotions
      if (this.bot.config.workers.doMorePromotions) {
        await this.bot.workers.doMorePromotions(workerPage, data);
      }

      // Complete punch cards
      if (this.bot.config.workers.doPunchCards) {
        await this.bot.workers.doPunchCard(workerPage, data);
      }

      // Do desktop searches
      if (this.bot.config.workers.doDesktopSearch) {
        try {
          await this.bot.activities.doSearch(workerPage, data);
        } catch (searchError) {
          const errorMsg = getErrorMessage(searchError);
          this.bot.log(
            false,
            "DESKTOP-FLOW",
            `Desktop search failed: ${errorMsg}`,
            "error",
          );
          // IMPROVED: Don't throw - continue with other tasks, just log the error
          // User will see reduced points but flow completes
        }
      }

      // Do free rewards redemption
      if (this.bot.config.workers.doFreeRewards) {
        try {
          await this.bot.workers.doFreeRewards(workerPage);
        } catch (rewardsError) {
          const errorMsg = getErrorMessage(rewardsError);
          this.bot.log(
            false,
            "DESKTOP-FLOW",
            `Free rewards redemption failed: ${errorMsg}`,
            "error",
          );
          // Don't throw - continue flow
        }
      }

      // Fetch points BEFORE closing (avoid page closed reload error)
      const after = await this.bot.browser.func
        .getCurrentPoints()
        .catch(() => initial);

      return {
        initialPoints: initial,
        collectedPoints: after - initial || 0,
      };
    } finally {
      if (!keepBrowserOpen) {
        // IMPROVED: Use centralized browser close utility to eliminate duplication
        await closeBrowserSafely(this.bot, browser, account.email, false);
      }
    }
  }
}
