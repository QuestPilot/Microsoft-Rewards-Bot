import { Page } from "rebrowser-playwright";

import { TIMEOUTS, URLS } from "../constants";
import {
    DashboardData,
    MorePromotion,
    PromotionalItem,
    PunchCard,
} from "../interface/DashboardData";

import { MicrosoftRewardsBot } from "../index";
import {
    waitForElementSmart,
    waitForNetworkIdle,
} from "../util/browser/SmartWait";
import { Retry } from "../util/core/Retry";
import { getErrorMessage } from "../util/core/Utils";
import { AdaptiveThrottler } from "../util/notifications/AdaptiveThrottler";
import { logError } from "../util/notifications/Logger";
import { getActivityStatsTracker } from "../util/state/ActivityStatsTracker";

// Selector patterns (extracted to avoid magic strings)
const ACTIVITY_SELECTORS = {
  byName: (name: string) =>
    `[data-bi-id^="${name}"] .pointLink:not(.contentContainer .pointLink)`,
  byOfferId: (offerId: string) =>
    `[data-bi-id^="${offerId}"] .pointLink:not(.contentContainer .pointLink)`,
} as const;

// Activity processing delays (in milliseconds)
const ACTIVITY_DELAYS = {
  THROTTLE_MIN: 800,
  THROTTLE_MAX: 1400,
  ACTIVITY_SPACING_MIN: 1200,
  ACTIVITY_SPACING_MAX: 2600,
} as const;

export class Workers {
  public bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  /**
   * Resolves the geo locale from dashboard data, falling back to "us".
   * Uses the config's useGeoLocaleQueries setting to decide whether to use it.
   */
  protected resolveGeoLocale(data: DashboardData): string {
    const country = data?.userProfile?.attributes?.country;
    const useGeo = this.bot.config.searchSettings.useGeoLocaleQueries;

    return useGeo && typeof country === "string" && country.length === 2
      ? country.toLowerCase()
      : "us";
  }

  // Daily Set
  async doDailySet(page: Page, data: DashboardData) {
    const today = this.bot.utils.getFormattedDate();
    const todayData = data.dailySetPromotions[today];
    const activitiesUncompleted = (
      todayData?.filter((x) => !x.complete && x.pointProgressMax > 0) ?? []
    ).filter((x) => {
      if (this.bot.config.jobState?.enabled === false) return true;
      const email = this.bot.currentAccountEmail || "unknown";
      return !this.bot.accountJobState?.isDone(email, today, x.offerId);
    });

    if (!activitiesUncompleted.length) {
      this.bot.log(
        this.bot.isMobile,
        "DAILY-SET",
        'All "Daily Set" items have already been completed',
      );
      return;
    }

    // Solve Activities
    this.bot.log(
      this.bot.isMobile,
      "DAILY-SET",
      'Started solving "Daily Set" items',
    );

    await this.solveActivities(page, activitiesUncompleted);

    // Mark as done to prevent duplicate work if checkpoints enabled
    if (this.bot.config.jobState?.enabled !== false) {
      const email = this.bot.currentAccountEmail || "unknown";
      for (const a of activitiesUncompleted) {
        this.bot.accountJobState?.markDone(email, today, a.offerId);
      }
    }

    page = await this.bot.browser.utils.getLatestTab(page);

    // Always return to the homepage if not already
    await this.bot.browser.func.goHome(page);

    this.bot.log(
      this.bot.isMobile,
      "DAILY-SET",
      'All "Daily Set" items have been completed',
    );

    // Optional: immediately run desktop search bundle
    if (
      !this.bot.isMobile &&
      this.bot.config.workers.bundleDailySetWithSearch &&
      this.bot.config.workers.doDesktopSearch
    ) {
      try {
        await this.bot.utils.waitRandom(1200, 2600);
        await this.bot.activities.doSearch(page, data);
      } catch (e) {
        this.bot.log(
          this.bot.isMobile,
          "DAILY-SET",
          `Post-DailySet search failed: ${getErrorMessage(e)}`,
          "warn",
        );
      }
    }
  }

  // Punch Card
  async doPunchCard(page: Page, data: DashboardData) {
    const punchCardsUncompleted =
      data.punchCards?.filter(
        (x) => x.parentPromotion && !x.parentPromotion.complete,
      ) ?? []; // Only return uncompleted punch cards

    if (!punchCardsUncompleted.length) {
      this.bot.log(
        this.bot.isMobile,
        "PUNCH-CARD",
        'All "Punch Cards" have already been completed',
      );
      return;
    }

    for (const punchCard of punchCardsUncompleted) {
      // Ensure parentPromotion exists before proceeding
      if (!punchCard.parentPromotion?.title) {
        this.bot.log(
          this.bot.isMobile,
          "PUNCH-CARD",
          `Skipped punchcard "${punchCard.name}" | Reason: Parent promotion is missing!`,
          "warn",
        );
        continue;
      }

      // Get latest page for each card
      page = await this.bot.browser.utils.getLatestTab(page);

      const activitiesUncompleted = punchCard.childPromotions.filter(
        (x) => !x.complete,
      ); // Only return uncompleted activities

      // Solve Activities
      this.bot.log(
        this.bot.isMobile,
        "PUNCH-CARD",
        `Started solving "Punch Card" items for punchcard: "${punchCard.parentPromotion.title}"`,
      );

      // Got to punch card index page in a new tab
      await page.goto(punchCard.parentPromotion.destinationUrl, {
        referer: URLS.REWARDS_BASE,
      });

      // IMPROVED: Smart wait replaces fixed 5s timeout with adaptive detection
      await waitForNetworkIdle(page, {
        timeoutMs: 5000,
        logFn: (msg) => this.bot.log(this.bot.isMobile, "PUNCH-CARD", msg),
      }).catch(
        logError(
          "PUNCH-CARD",
          "Network idle wait timeout (non-critical)",
          this.bot.isMobile,
        ),
      );

      await this.solveActivities(page, activitiesUncompleted, punchCard);

      page = await this.bot.browser.utils.getLatestTab(page);

      const pages = page.context().pages();

      if (pages.length > 3) {
        await page.close();
      } else {
        await this.bot.browser.func.goHome(page);
      }

      this.bot.log(
        this.bot.isMobile,
        "PUNCH-CARD",
        `All items for punchcard: "${punchCard.parentPromotion.title}" have been completed`,
      );
    }

    this.bot.log(
      this.bot.isMobile,
      "PUNCH-CARD",
      'All "Punch Card" items have been completed',
    );
  }

  // More Promotions
  async doMorePromotions(page: Page, data: DashboardData) {
    const morePromotions = data.morePromotions;

    // Check if there is a promotional item
    if (data.promotionalItem) {
      // SAFE CAST: PromotionalItem and MorePromotion share the same runtime shape from the API.
      // The minor type differences (attributes type, promotionType enum vs string) are nominal only.
      morePromotions.push(data.promotionalItem as unknown as MorePromotion);
    }

    const activitiesUncompleted =
      morePromotions?.filter(
        (x) =>
          !x.complete &&
          x.pointProgressMax > 0 &&
          x.exclusiveLockedFeatureStatus !== "locked",
      ) ?? [];

    if (!activitiesUncompleted.length) {
      this.bot.log(
        this.bot.isMobile,
        "MORE-PROMOTIONS",
        'All "More Promotion" items have already been completed',
      );
      return;
    }

    // Solve Activities
    this.bot.log(
      this.bot.isMobile,
      "MORE-PROMOTIONS",
      'Started solving "More Promotions" items',
    );

    page = await this.bot.browser.utils.getLatestTab(page);

    await this.solveActivities(page, activitiesUncompleted);

    page = await this.bot.browser.utils.getLatestTab(page);

    // Always return to the homepage if not already
    await this.bot.browser.func.goHome(page);

    this.bot.log(
      this.bot.isMobile,
      "MORE-PROMOTIONS",
      'All "More Promotion" items have been completed',
    );
  }

  // Free Rewards
  async doFreeRewards(page: Page) {
    // Check if account has phone number configured
    if (!this.bot.currentAccountPhoneNumber) {
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        'Skipped: No phone number configured for this account. Add "phoneNumber" field in accounts.jsonc to enable free rewards redemption.',
        "warn",
      );
      return;
    }

    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Starting free rewards redemption (0-point gift cards)",
    );

    try {
      const { FreeRewards } = await import("./activities/FreeRewards");
      const freeRewards = new FreeRewards(this.bot);
      await freeRewards.doFreeRewards(page);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        `Free rewards flow failed: ${errorMessage}`,
        "error",
      );
      throw new Error(`Free rewards redemption failed: ${errorMessage}`);
    }
  }

  // Solve all the different types of activities
  private async solveActivities(
    activityPage: Page,
    activities: PromotionalItem[] | MorePromotion[],
    punchCard?: PunchCard,
  ) {
    const activityInitial = activityPage.url();
    const retry = new Retry(this.bot.config.retryPolicy);
    const throttle = new AdaptiveThrottler();

    for (const activity of activities) {
      try {
        activityPage = await this.manageTabLifecycle(
          activityPage,
          activityInitial,
        );
        await this.applyThrottle(
          throttle,
          ACTIVITY_DELAYS.THROTTLE_MIN,
          ACTIVITY_DELAYS.THROTTLE_MAX,
        );

        const selector = await this.buildActivitySelector(
          activityPage,
          activity,
          punchCard,
        );
        await this.prepareActivityPage(activityPage, throttle);

        const typeLabel = this.bot.activities.getTypeLabel(activity);
        if (typeLabel !== "Unsupported") {
          await this.executeActivity(
            activityPage,
            activity,
            selector,
            throttle,
            retry,
          );
        } else {
          this.bot.log(
            this.bot.isMobile,
            "ACTIVITY",
            `Skipped activity "${activity.title}" | Reason: Unsupported type: "${activity.promotionType}"!`,
            "warn",
          );
        }

        await this.applyThrottle(
          throttle,
          ACTIVITY_DELAYS.ACTIVITY_SPACING_MIN,
          ACTIVITY_DELAYS.ACTIVITY_SPACING_MAX,
        );
      } catch (error) {
        const message = getErrorMessage(error);
        this.bot.log(
          this.bot.isMobile,
          "ACTIVITY",
          `Activity "${activity.title}" failed: ${message}`,
          "error",
        );
        throttle.record(false);
      }
    }
  }

  private async manageTabLifecycle(
    page: Page,
    initialUrl: string,
  ): Promise<Page> {
    page = await this.bot.browser.utils.getLatestTab(page);

    const pages = page.context().pages();
    if (pages.length > 3) {
      await page.close();
      page = await this.bot.browser.utils.getLatestTab(page);
    }

    if (page.url() !== initialUrl) {
      await page.goto(initialUrl);
    }

    return page;
  }

  private async buildActivitySelector(
    page: Page,
    activity: PromotionalItem | MorePromotion,
    punchCard?: PunchCard,
  ): Promise<string> {
    if (punchCard) {
      return await this.bot.browser.func.getPunchCardActivity(page, activity);
    }

    const name = activity.name.toLowerCase();
    if (name.includes("membercenter") || name.includes("exploreonbing")) {
      return ACTIVITY_SELECTORS.byName(activity.name);
    }

    // Validate offerId exists before using it in selector
    if (!activity.offerId) {
      // IMPROVED: More prominent logging for data integrity issue
      this.bot.log(
        this.bot.isMobile,
        "WORKERS",
        `⚠️ DATA INTEGRITY: Activity "${activity.name || activity.title}" is missing offerId field. This may indicate a dashboard API change or data corruption. Falling back to name-based selector.`,
        "warn",
      );
      return ACTIVITY_SELECTORS.byName(activity.name);
    }

    return ACTIVITY_SELECTORS.byOfferId(activity.offerId);
  }

  private async prepareActivityPage(
    page: Page,
    throttle: AdaptiveThrottler,
  ): Promise<void> {
    // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive detection
    await waitForNetworkIdle(page, {
      timeoutMs: TIMEOUTS.DASHBOARD_WAIT,
      logFn: (msg) => this.bot.log(this.bot.isMobile, "WORKERS", msg),
    }).catch(
      logError("WORKERS", "Network idle wait failed", this.bot.isMobile),
    );
    await this.bot.browser.utils.humanizePage(page);
    await this.applyThrottle(
      throttle,
      ACTIVITY_DELAYS.ACTIVITY_SPACING_MIN,
      ACTIVITY_DELAYS.ACTIVITY_SPACING_MAX,
    );
  }

  private async executeActivity(
    page: Page,
    activity: PromotionalItem | MorePromotion,
    selector: string,
    throttle: AdaptiveThrottler,
    retry: Retry,
  ): Promise<void> {
    const activityType = this.bot.activities.getTypeLabel(activity);
    const statsTracker = getActivityStatsTracker();
    const startTime = statsTracker.startActivity(activityType);

    this.bot.log(
      this.bot.isMobile,
      "ACTIVITY",
      `Found activity type: "${activityType}" title: "${activity.title}"`,
    );

    // IMPROVED: Fast-fail for unavailable activities (1s+3s instead of 2s+5s)
    const elementResult = await waitForElementSmart(page, selector, {
      initialTimeoutMs: 1000,
      extendedTimeoutMs: 3000,
      state: "attached",
      logFn: (msg) => this.bot.log(this.bot.isMobile, "ACTIVITY", msg),
    });

    if (!elementResult.found) {
      this.bot.log(
        this.bot.isMobile,
        "ACTIVITY",
        `[SKIP] Activity not available: "${activity.title}" (already completed or not offered today)`,
      );
      statsTracker.recordSuccess(activityType, startTime); // Count as success (nothing to do)
      return; // Skip this activity gracefully
    }

    // FIXED: Use locator from elementResult to ensure element exists before clicking
    // This prevents indefinite hanging when element disappears between check and click
    try {
      if (elementResult.element) {
        await elementResult.element.click({ timeout: TIMEOUTS.DASHBOARD_WAIT });
      } else {
        // Fallback to page.click with strict check if locator not available
        await page.click(selector, {
          timeout: TIMEOUTS.DASHBOARD_WAIT,
          strict: true,
        });
      }
    } catch (clickError) {
      const errMsg = getErrorMessage(clickError);
      this.bot.log(
        this.bot.isMobile,
        "ACTIVITY",
        `Failed to click activity: ${errMsg}`,
        "error",
      );
      statsTracker.recordFailure(
        activityType,
        startTime,
        clickError instanceof Error ? clickError : new Error(errMsg),
      );
      throw new Error(`Activity click failed: ${errMsg}`);
    }

    page = await this.bot.browser.utils.getLatestTab(page);

    // Execute activity with timeout protection using Promise.race
    const timeoutMs =
      this.bot.utils.stringToMs(this.bot.config?.globalTimeout ?? "30s") * 2;

    try {
      await retry.run(
        async () => {
          const activityPromise = this.bot.activities.run(page, activity);
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              reject(
                new Error(`Activity execution timeout after ${timeoutMs}ms`),
              );
            }, timeoutMs);
            // Clean up timer if activity completes first
            activityPromise.finally(() => clearTimeout(timer));
          });

          try {
            await Promise.race([activityPromise, timeoutPromise]);
            throttle.record(true);
          } catch (e) {
            throttle.record(false);
            throw e;
          }
        },
        () => true,
      );

      statsTracker.recordSuccess(activityType, startTime);
    } catch (activityError) {
      statsTracker.recordFailure(
        activityType,
        startTime,
        activityError instanceof Error ? activityError : undefined,
      );
      throw activityError;
    }

    await this.bot.browser.utils.humanizePage(page);
  }

  private async applyThrottle(
    throttle: AdaptiveThrottler,
    min: number,
    max: number,
  ): Promise<void> {
    const multiplier = throttle.getDelayMultiplier();
    await this.bot.utils.waitRandom(
      Math.floor(min * multiplier),
      Math.floor(max * multiplier),
    );
  }
}
