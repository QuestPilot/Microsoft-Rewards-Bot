import { Page } from "rebrowser-playwright";

import { TIMEOUTS, URLS } from "../../constants";
import {
    waitForElementSmart,
    waitForNetworkIdle,
} from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { secureRandomInt } from "../../util/security/SecureRandom";
import { Workers } from "../Workers";

/**
 * FreeRewards Activity Handler
 *
 * Automatically redeems 0-point gift cards and rewards from https://rewards.bing.com/redeem
 *
 * **IMPORTANT REQUIREMENTS:**
 * - Account MUST have a phone number configured (`phoneNumber` field in accounts.jsonc)
 * - Without a phone number, Microsoft blocks reward redemption (no value in executing this task)
 *
 * **ANTI-DETECTION MEASURES:**
 * - Aggressive humanization (mouse gestures, scrolling, random delays)
 * - Smart waiting for Cloudflare Turnstile CAPTCHA completion
 * - Natural browsing patterns to avoid automation detection
 *
 * **WORKFLOW:**
 * 1. Navigate to https://rewards.bing.com/redeem
 * 2. Scan page for rewards with 0 points cost (class-based detection for multi-locale support)
 * 3. Click the reward card to view details
 * 4. Click "Redeem" button on product detail page
 * 5. Wait for Cloudflare Turnstile CAPTCHA to complete (user must solve if detected)
 * 6. Confirm redemption on checkout page
 * 7. Verify success and return to redeem page for next reward
 *
 * **CLOUDFLARE TURNSTILE CAPTCHA HANDLING:**
 * - Automatic detection of CAPTCHA presence (#turnstile-widget)
 * - Extended timeout (up to 60s) for user to manually solve CAPTCHA
 * - Aggressive humanization during wait (scrolling, mouse moves)
 * - Configurable via `humanization.enabled` in config
 *
 * @class FreeRewards
 * @extends Workers
 */
export class FreeRewards extends Workers {
  /**
   * Main entry point for free rewards redemption
   *
   * @param page Playwright page instance (must be on rewards.bing.com)
   * @returns Promise resolving when all free rewards are redeemed
   * @throws {Error} If critical operation fails (navigation, page closed)
   */
  override async doFreeRewards(page: Page): Promise<void> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Starting free rewards redemption flow",
    );

    try {
      // STEP 1: Navigate to redeem page
      await this.navigateToRedeemPage(page);

      // STEP 2: Find all 0-point rewards
      const freeRewards = await this.findFreeRewards(page);

      if (freeRewards.length === 0) {
        this.bot.log(
          this.bot.isMobile,
          "FREE-REWARDS",
          "No free rewards (0 points) available today",
        );
        return;
      }

      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        `Found ${freeRewards.length} free reward(s) available`,
      );

      // STEP 3: Redeem each free reward
      for (let i = 0; i < freeRewards.length; i++) {
        const reward = freeRewards[i];
        if (!reward) continue;

        this.bot.log(
          this.bot.isMobile,
          "FREE-REWARDS",
          `Processing reward ${i + 1}/${freeRewards.length}`,
        );

        try {
          await this.redeemSingleReward(page, reward);
          this.bot.log(
            this.bot.isMobile,
            "FREE-REWARDS",
            `Successfully redeemed reward ${i + 1}`,
            "log",
            "green",
          );
        } catch (rewardError) {
          const errMsg = getErrorMessage(rewardError);
          this.bot.log(
            this.bot.isMobile,
            "FREE-REWARDS",
            `Failed to redeem reward ${i + 1}: ${errMsg}`,
            "error",
          );
          // Continue with next reward instead of failing entire flow
        }

        // Navigate back to redeem page for next reward
        if (i < freeRewards.length - 1) {
          await this.navigateToRedeemPage(page);
        }
      }

      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "Completed free rewards redemption flow",
        "log",
        "green",
      );
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

  /**
   * Navigate to rewards redemption page with retry logic
   *
   * @param page Playwright page instance
   * @returns Promise resolving when navigation completes
   */
  private async navigateToRedeemPage(page: Page): Promise<void> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Navigating to redeem page",
    );

    try {
      await page.goto(URLS.REWARDS_REDEEM, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUTS.DASHBOARD_WAIT * 2,
      });

      // Wait for page to fully load
      await waitForNetworkIdle(page, {
        timeoutMs: TIMEOUTS.DASHBOARD_WAIT,
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      }).catch(() => {
        // Network idle timeout is non-critical (page may still be usable)
      });

      // Dismiss any popups/overlays
      await this.bot.browser.utils.tryDismissAllMessages(page);

      // Humanize page interaction
      await this.bot.browser.utils.humanizePage(page);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to navigate to redeem page: ${errorMessage}`);
    }
  }

  /**
   * Find all rewards with 0 points cost on the page
   *
   * Uses class-based detection to support multiple locales (language-agnostic)
   * Targets: <div mee-paragraph="para4" class="ng-binding c-paragraph-4">0&nbsp;points</div>
   *
   * @param page Playwright page instance
   * @returns Array of reward elements (clickable cards)
   */
  private async findFreeRewards(
    page: Page,
  ): Promise<Array<{ selector: string; title: string }>> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Scanning for 0-point rewards",
    );

    try {
      // Wait for reward cards to load
      await waitForElementSmart(page, '[mee-paragraph="para4"]', {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
        state: "attached",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      });

      // Find all price elements with class c-paragraph-4
      const priceElements = await page
        .locator('[mee-paragraph="para4"].c-paragraph-4')
        .all();

      const freeRewards: Array<{ selector: string; title: string }> = [];

      for (const priceEl of priceElements) {
        const priceText = await priceEl.textContent().catch(() => "");

        // Match "0 points" (with non-breaking space or regular space)
        // Regex: /^0[\s\u00A0]*points?$/i (case-insensitive, flexible whitespace)
        if (priceText && /^0[\s\u00A0]*points?$/i.test(priceText.trim())) {
          // Find parent reward card (go up DOM tree to find clickable container)
          const cardElement = priceEl
            .locator(
              'xpath=ancestor::*[contains(@class, "card") or contains(@class, "reward")]',
            )
            .first();

          // Extract reward title for logging
          const titleEl = cardElement
            .locator('[mee-paragraph="para2"], .reward-title, .card-title')
            .first();
          const title = await titleEl.textContent().catch(() => null);
          const titleText = title ? title.trim() : "Unknown Reward";

          // Get unique selector for this card (use data attributes if available)
          const dataTestId = await cardElement
            .getAttribute("data-testid")
            .catch(() => null);
          const selector = dataTestId
            ? `[data-testid="${dataTestId}"]`
            : '[mee-paragraph="para4"]:has-text("0")';

          freeRewards.push({ selector, title: titleText });

          this.bot.log(
            this.bot.isMobile,
            "FREE-REWARDS",
            `Found free reward: "${titleText}"`,
          );
        }
      }

      return freeRewards;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        `Error scanning for free rewards: ${errorMessage}`,
        "warn",
      );
      return [];
    }
  }

  /**
   * Redeem a single free reward
   *
   * @param page Playwright page instance
   * @param reward Reward metadata (selector, title)
   * @returns Promise resolving when redemption completes
   */
  private async redeemSingleReward(
    page: Page,
    reward: { selector: string; title: string },
  ): Promise<void> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      `Opening reward: "${reward.title}"`,
    );

    // STEP 1: Click reward card to open detail page
    await this.clickRewardCard(page, reward);

    // STEP 2: Click "Redeem" button on product detail page
    await this.clickRedeemButton(page);

    // STEP 3: Wait for Cloudflare Turnstile CAPTCHA (if present)
    await this.waitForCaptchaCompletion(page);

    // STEP 4: Confirm redemption
    await this.confirmRedemption(page);

    // STEP 5: Verify success
    await this.verifyRedemptionSuccess(page);
  }

  /**
   * Click reward card to open detail page
   *
   * @param page Playwright page instance
   * @param reward Reward metadata
   */
  private async clickRewardCard(
    page: Page,
    reward: { selector: string; title: string },
  ): Promise<void> {
    try {
      // Humanize before clicking
      await this.bot.browser.utils.humanizePage(page);
      await this.bot.utils.waitRandom(500, 1200);

      // Find and click the reward card
      const cardResult = await waitForElementSmart(page, reward.selector, {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      });

      if (!cardResult.found || !cardResult.element) {
        throw new Error(`Reward card not found: ${reward.selector}`);
      }

      await cardResult.element.click({ timeout: TIMEOUTS.DASHBOARD_WAIT });

      // Wait for detail page to load
      await waitForNetworkIdle(page, {
        timeoutMs: TIMEOUTS.DASHBOARD_WAIT,
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      }).catch(() => {
        // Non-critical timeout
      });

      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "Reward detail page loaded",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to click reward card: ${errorMessage}`);
    }
  }

  /**
   * Click "Redeem" button on product detail page
   *
   * Button structure (language-agnostic, class-based detection):
   * <a href="/redeem/checkout?productId=..." class="btn btn-primary card-button-height...">
   *   <span class="pull-left margin-right-15">REDEEM REWARD TEXT</span>
   *   <span class="pull-left win-icon mee-icon-ChevronRight margin-top-1"></span>
   * </a>
   */
  private async clickRedeemButton(page: Page): Promise<void> {
    this.bot.log(this.bot.isMobile, "FREE-REWARDS", "Clicking redeem button");

    try {
      // Humanize before clicking
      await this.bot.browser.utils.humanizePage(page);
      await this.bot.utils.waitRandom(800, 1500);

      // Find redeem button (class-based: btn btn-primary card-button-height)
      const buttonSelector =
        'a.btn.btn-primary.card-button-height[href*="/redeem/checkout"]';

      const buttonResult = await waitForElementSmart(page, buttonSelector, {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      });

      if (!buttonResult.found || !buttonResult.element) {
        throw new Error("Redeem button not found on product detail page");
      }

      await buttonResult.element.click({ timeout: TIMEOUTS.DASHBOARD_WAIT });

      // Wait for checkout page to load
      await waitForNetworkIdle(page, {
        timeoutMs: TIMEOUTS.DASHBOARD_WAIT,
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      }).catch(() => {
        // Non-critical timeout
      });

      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "Navigated to checkout page",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to click redeem button: ${errorMessage}`);
    }
  }

  /**
   * Wait for Cloudflare Turnstile CAPTCHA completion
   *
   * **STRATEGY:**
   * - Detect CAPTCHA presence (#turnstile-widget iframe)
   * - Wait up to 60s for user to manually solve CAPTCHA
   * - Apply aggressive humanization (scrolling, mouse moves) during wait
   * - Check for CAPTCHA disappearance (indicates completion)
   *
   * **USER EXPERIENCE:**
   * - If CAPTCHA detected: bot pauses execution, logs warning, waits for user
   * - User must solve CAPTCHA manually in browser window
   * - Once solved, bot continues automatically
   *
   * @param page Playwright page instance
   */
  private async waitForCaptchaCompletion(page: Page): Promise<void> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Checking for Cloudflare Turnstile CAPTCHA",
    );

    try {
      // Check if CAPTCHA is present
      const captchaWidget = page.locator("#turnstile-widget iframe").first();
      const captchaVisible = await captchaWidget
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (!captchaVisible) {
        this.bot.log(
          this.bot.isMobile,
          "FREE-REWARDS",
          "No CAPTCHA detected, proceeding",
        );
        return;
      }

      // CAPTCHA detected - apply aggressive humanization
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "⚠️ Cloudflare Turnstile CAPTCHA detected! Applying aggressive humanization...",
        "warn",
      );
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "If CAPTCHA requires manual solving, please complete it in the browser window",
        "warn",
      );

      // Wait up to 60s for CAPTCHA completion with aggressive humanization
      const captchaTimeout = 60000; // 60 seconds
      const startTime = Date.now();
      let attempts = 0;

      while (Date.now() - startTime < captchaTimeout) {
        attempts++;

        // Apply aggressive humanization (scroll, mouse moves)
        if (this.bot.config.humanization?.enabled !== false) {
          // Random scroll
          const scrollAmount = secureRandomInt(100, 399);
          await page.mouse.wheel(0, scrollAmount).catch(() => {});
          await this.bot.utils.waitRandom(500, 1000);

          // Random mouse movement
          const x = secureRandomInt(100, 299);
          const y = secureRandomInt(100, 299);
          await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
          await this.bot.utils.waitRandom(300, 800);
        }

        // Check if CAPTCHA is still visible
        const stillVisible = await captchaWidget
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (!stillVisible) {
          this.bot.log(
            this.bot.isMobile,
            "FREE-REWARDS",
            `CAPTCHA completed after ${attempts} attempts (${Math.floor((Date.now() - startTime) / 1000)}s)`,
            "log",
            "green",
          );
          await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG); // Wait for post-CAPTCHA processing
          return;
        }

        // Wait before next check
        await this.bot.utils.wait(TIMEOUTS.MEDIUM);
      }

      // CAPTCHA timeout - log error but continue (may fail at confirmation)
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "❌ CAPTCHA completion timeout after 60s. Redemption may fail.",
        "error",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        `Error during CAPTCHA wait: ${errorMessage}`,
        "warn",
      );
      // Continue anyway - CAPTCHA may not be blocking
    }
  }

  /**
   * Confirm redemption on checkout page
   *
   * Button structure (class-based):
   * <button id="redeem-checkout-review-confirm" class="btn-primary card-button-height...">
   *   <span class="pull-left margin-right-15">CONFIRM REWARD TEXT</span>
   *   <span class="pull-left win-icon mee-icon-ChevronRight margin-top-1"></span>
   * </button>
   */
  private async confirmRedemption(page: Page): Promise<void> {
    this.bot.log(this.bot.isMobile, "FREE-REWARDS", "Confirming redemption");

    try {
      // Humanize before clicking
      await this.bot.browser.utils.humanizePage(page);
      await this.bot.utils.waitRandom(1000, 2000);

      // Find confirm button (id-based for reliability)
      const confirmButtonSelector =
        "button#redeem-checkout-review-confirm, button.btn-primary.card-button-height";

      const buttonResult = await waitForElementSmart(
        page,
        confirmButtonSelector,
        {
          initialTimeoutMs: 3000,
          extendedTimeoutMs: TIMEOUTS.DASHBOARD_WAIT - 3000,
          state: "visible",
          logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
        },
      );

      if (!buttonResult.found || !buttonResult.element) {
        throw new Error(
          "Confirm button not found on checkout page. CAPTCHA may have blocked redemption.",
        );
      }

      await buttonResult.element.click({ timeout: TIMEOUTS.DASHBOARD_WAIT });

      // Wait for confirmation page to load
      await waitForNetworkIdle(page, {
        timeoutMs: TIMEOUTS.DASHBOARD_WAIT * 2, // Extended timeout for processing
        logFn: (msg) => this.bot.log(this.bot.isMobile, "FREE-REWARDS", msg),
      }).catch(() => {
        // Non-critical timeout
      });

      this.bot.log(this.bot.isMobile, "FREE-REWARDS", "Redemption confirmed");
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to confirm redemption: ${errorMessage}`);
    }
  }

  /**
   * Verify redemption success
   *
   * Checks for success indicators:
   * - Success message on page
   * - URL change to confirmation page
   * - Absence of error messages
   */
  private async verifyRedemptionSuccess(page: Page): Promise<void> {
    this.bot.log(
      this.bot.isMobile,
      "FREE-REWARDS",
      "Verifying redemption success",
    );

    try {
      // Wait for page to stabilize
      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);

      // Check URL for success indicators
      const currentUrl = page.url();
      const isSuccessUrl =
        currentUrl.includes("orderconfirmation") ||
        currentUrl.includes("success") ||
        currentUrl.includes("confirmed");

      if (isSuccessUrl) {
        this.bot.log(
          this.bot.isMobile,
          "FREE-REWARDS",
          "Redemption successful (URL confirmed)",
        );
        return;
      }

      // Check for success message on page (class-based, language-agnostic)
      const successIndicators = [
        ".success-message",
        ".confirmation-message",
        '[class*="success"]',
        '[class*="confirmed"]',
      ];

      for (const selector of successIndicators) {
        const hasSuccess = await page
          .locator(selector)
          .first()
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (hasSuccess) {
          this.bot.log(
            this.bot.isMobile,
            "FREE-REWARDS",
            "Redemption successful (success message found)",
          );
          return;
        }
      }

      // Check for error messages (indicates failure)
      const errorIndicators = [
        ".error-message",
        '[class*="error"]',
        '[class*="failed"]',
      ];

      for (const selector of errorIndicators) {
        const hasError = await page
          .locator(selector)
          .first()
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (hasError) {
          const errorText = await page
            .locator(selector)
            .first()
            .textContent()
            .catch(() => null);
          const errorMsg = errorText ? errorText.trim() : "Unknown error";
          throw new Error(`Redemption failed: ${errorMsg}`);
        }
      }

      // No clear success/error indicator - log warning but assume success
      this.bot.log(
        this.bot.isMobile,
        "FREE-REWARDS",
        "Redemption status unclear (no explicit success/error indicator). Assuming success.",
        "warn",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Redemption verification failed: ${errorMessage}`);
    }
  }
}
