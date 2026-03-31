import fs from "fs";
import path from "path";
import * as readline from "readline";
import type { BrowserContext, Page } from "rebrowser-playwright";
import { URLS } from "../constants";
import { getErrorMessage } from "../util/core/Utils";
import { log } from "../util/notifications/Logger";
import { secureRandom } from "../util/security/SecureRandom";
import { DataGenerator } from "./DataGenerator";
import { HumanBehavior } from "./HumanBehavior";
import { CreatedAccount } from "./types";

export class AccountCreator {
  private page!: Page;
  private human!: HumanBehavior;
  private dataGenerator: DataGenerator;
  private referralUrl?: string;
  private recoveryEmail?: string;
  private autoAccept: boolean;
  private rl: readline.Interface;
  private rlClosed = false;

  constructor(
    referralUrl?: string,
    recoveryEmail?: string,
    autoAccept = false,
  ) {
    this.referralUrl = referralUrl;
    this.recoveryEmail = recoveryEmail;
    this.autoAccept = autoAccept;
    this.dataGenerator = new DataGenerator();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rlClosed = false;
  }

  // Human-like delay helper (DEPRECATED - use this.human.humanDelay() instead)
  // Kept for backward compatibility during migration
  private async humanDelay(minMs: number, maxMs: number): Promise<void> {
    await this.human.humanDelay(minMs, maxMs);
  }

  /**
   * Helper: Check if email domain is a Microsoft-managed domain
   * Extracted to avoid duplication and improve maintainability
   */
  private isMicrosoftDomain(domain: string | undefined): boolean {
    if (!domain) return false;
    const lowerDomain = domain.toLowerCase();
    return (
      lowerDomain === "outlook.com" ||
      lowerDomain === "hotmail.com" ||
      lowerDomain === "outlook.fr"
    );
  }

  /**
   * UTILITY: Find first visible element from list of selectors
   * Reserved for future use - simplifies selector fallback logic
   * 
   * Usage example:
  /**
   * UTILITY: Retry an async operation with HUMAN-LIKE random delays
   * IMPROVED: Avoid exponential backoff (too predictable = bot pattern)
   */
  private async retryOperation<T>(
    operation: () => Promise<T>,
    context: string,
    maxRetries: number = 3,
    initialDelayMs: number = 1000,
    enableMicroGestures: boolean = true,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        return result;
      } catch (error) {
        if (attempt < maxRetries) {
          // IMPROVED: Human-like variable delays (not exponential)
          // Real humans retry at inconsistent intervals
          const baseDelay = initialDelayMs + secureRandom() * 500;
          const variance = secureRandom() * 1000 - 500; // ±500ms random jitter
          const humanDelay = baseDelay + attempt * 800 + variance; // Gradual increase with randomness

          log(
            false,
            "CREATOR",
            `[${context}] Retry ${attempt}/${maxRetries} after ${Math.floor(humanDelay)}ms`,
            "warn",
            "yellow",
          );
          await this.page.waitForTimeout(Math.floor(humanDelay));

          // IMPROVED: Random micro-gesture during retry (human frustration pattern)
          // CRITICAL: Can be disabled for sensitive operations (e.g., dropdowns) where scroll would break state
          if (enableMicroGestures && secureRandom() < 0.4) {
            await this.human.microGestures(`${context}_RETRY_${attempt}`);
          }
        } else {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * IMPROVED: Fluent UI-compatible interaction method
   * Uses focus + Enter (keyboard) which works better than mouse clicks for Fluent UI components
   * Falls back to direct click if focus fails
   *
   * @param locator - Playwright locator for the element
   * @param context - Context name for logging
   * @returns Promise<void>
   */
  private async fluentUIClick(
    locator: ReturnType<typeof this.page.locator>,
    context: string,
  ): Promise<void> {
    try {
      // STRATEGY 1: Focus + Enter (most compatible with Fluent UI)
      await locator.focus();
      await this.humanDelay(300, 600);
      await this.page.keyboard.press("Enter");
      log(
        false,
        "CREATOR",
        `[${context}] ✓ Pressed Enter on focused element`,
        "log",
        "cyan",
      );
    } catch (focusError) {
      // STRATEGY 2: Fallback to direct click
      log(
        false,
        "CREATOR",
        `[${context}] ⚠️ Focus+Enter failed, using direct click`,
        "warn",
        "yellow",
      );
      await locator.click({ timeout: 5000 });
      log(
        false,
        "CREATOR",
        `[${context}] ✓ Direct click executed`,
        "log",
        "cyan",
      );
    }
  }

  /**
   * CRITICAL: Wait for dropdown to be fully closed before continuing
   * IMPROVED: Detect Fluent UI dropdown states reliably
   */
  private async waitForDropdownClosed(
    context: string,
    maxWaitMs: number = 5000,
  ): Promise<boolean> {
    log(
      false,
      "CREATOR",
      `[${context}] Waiting for dropdown to close...`,
      "log",
      "cyan",
    );

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // UPDATED: Check for Fluent UI dropdown containers (new classes)
      const dropdownSelectors = [
        'div[role="listbox"]',
        'ul[role="listbox"]',
        'div[role="menu"]',
        'ul[role="menu"]',
        "div.fui-Listbox", // NEW: Fluent UI specific
        "div.fui-Menu", // NEW: Fluent UI specific
        '[class*="dropdown"][class*="open"]',
        '[aria-expanded="true"]', // NEW: Better detection
      ];

      let anyVisible = false;
      for (const selector of dropdownSelectors) {
        const visible = await this.page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          anyVisible = true;
          break;
        }
      }

      if (!anyVisible) {
        // IMPROVED: Extra verification - check aria-expanded on buttons
        const expandedButtons = await this.page
          .locator('button[aria-expanded="true"]')
          .count()
          .catch(() => 0);
        if (expandedButtons === 0) {
          log(
            false,
            "CREATOR",
            `[${context}] ✅ Dropdown confirmed closed`,
            "log",
            "green",
          );
          return true;
        }
      }

      await this.page.waitForTimeout(500);
    }

    log(
      false,
      "CREATOR",
      `[${context}] ⚠️ Dropdown still visible after ${maxWaitMs}ms`,
      "warn",
      "yellow",
    );
    return false;
  }

  /**
   * CRITICAL: Verify input value after filling
   */
  private async verifyInputValue(
    selector: string,
    expectedValue: string,
  ): Promise<boolean> {
    try {
      const input = this.page.locator(selector).first();
      const actualValue = await input.inputValue().catch(() => "");
      return actualValue === expectedValue;
    } catch (error) {
      return false;
    }
  }

  /**
   * CRITICAL: Verify no errors are displayed on the page
   * Returns true if no errors found, false if errors present
   */
  private async verifyNoErrors(): Promise<boolean> {
    const errorSelectors = [
      'div[id*="Error"]',
      'div[id*="error"]',
      'div[class*="error"]',
      'div[role="alert"]',
      '[aria-invalid="true"]',
      'span[class*="error"]',
      ".error-message",
      '[data-bind*="errorMessage"]',
    ];

    for (const selector of errorSelectors) {
      try {
        const errorElement = this.page.locator(selector).first();
        const isVisible = await errorElement.isVisible().catch(() => false);

        if (isVisible) {
          const errorText = await errorElement
            .textContent()
            .catch(() => "Unknown error");
          log(false, "CREATOR", `Error detected: ${errorText}`, "error");
          return false;
        }
      } catch {
        continue;
      }
    }

    // CRITICAL: Check for Microsoft rate-limit block (too many accounts created)
    try {
      const blockTitles = [
        'h1:has-text("We can\'t create your account")',
        'h1:has-text("We can\'t create your Microsoft account")',
        'h1:has-text("nous ne pouvons pas créer votre compte")', // French
        '[data-testid="title"]:has-text("can\'t create")',
        '[data-testid="title"]:has-text("unusual activity")',
      ];

      for (const selector of blockTitles) {
        const blockElement = this.page.locator(selector).first();
        const isVisible = await blockElement
          .isVisible({ timeout: 1000 })
          .catch(() => false);

        if (isVisible) {
          log(false, "CREATOR", "🚨 MICROSOFT RATE LIMIT DETECTED", "error");
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          log(
            false,
            "CREATOR",
            '❌ "We can\'t create your account" error detected',
            "error",
          );
          log(
            false,
            "CREATOR",
            "📍 Cause: Too many accounts created from this IP recently",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "⏰ Solution: Wait 24-48 hours before creating more accounts",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "🌐 Alternative: Use a different IP address (VPN, proxy, mobile hotspot)",
            "log",
            "cyan",
          );
          log(
            false,
            "CREATOR",
            "🔗 Learn more: https://go.microsoft.com/fwlink/?linkid=2259413",
            "log",
            "cyan",
          );
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          return false;
        }
      }
    } catch {
      // Ignore
    }

    // CRITICAL: Check for temporary unavailability (Microsoft servers overloaded)
    try {
      const unavailableSelectors = [
        '#idPageTitle:has-text("temporarily unavailable")',
        '#idPageTitle:has-text("temporairement indisponible")',
        'div:has-text("site is temporarily unavailable")',
        'div:has-text("site est temporairement indisponible")',
      ];

      for (const selector of unavailableSelectors) {
        const unavailableElement = this.page.locator(selector).first();
        const isVisible = await unavailableElement
          .isVisible({ timeout: 1000 })
          .catch(() => false);

        if (isVisible) {
          log(
            false,
            "CREATOR",
            "🚨 MICROSOFT TEMPORARY UNAVAILABILITY",
            "error",
          );
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          log(
            false,
            "CREATOR",
            '❌ "This site is temporarily unavailable" detected',
            "error",
          );
          log(
            false,
            "CREATOR",
            "📍 Cause: Microsoft servers overloaded or under maintenance",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "⏰ Solution: Wait 30-60 minutes and try again",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "🌐 Tip: Avoid peak hours (8am-6pm US time)",
            "log",
            "cyan",
          );
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          return false;
        }
      }
    } catch {
      // Ignore
    }

    return true;
  }

  private async askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  /**
   * CRITICAL: Wait for page to be completely stable before continuing
   * Checks for loading spinners, network activity, URL stability, and JS execution
   */
  private async waitForPageStable(
    _context: string,
    maxWaitMs: number = 15000,
  ): Promise<boolean> {
    // REDUCED: Don't log start - too verbose

    const startTime = Date.now();

    try {
      // STEP 1: Wait for network to be idle
      await this.page.waitForLoadState("networkidle", {
        timeout: Math.min(maxWaitMs, 10000),
      });

      // STEP 2: Wait for DOM to be fully loaded
      // Silent catch justified: DOMContentLoaded may already be complete
      await this.page
        .waitForLoadState("domcontentloaded", { timeout: 3000 })
        .catch(() => {});

      // STEP 3: REDUCED delay - pages load fast
      await this.humanDelay(1500, 2500);

      // STEP 4: Check for loading indicators
      const loadingSelectors = [
        ".loading",
        '[class*="spinner"]',
        '[class*="loading"]',
        '[aria-busy="true"]',
      ];

      // Wait for loading indicators to disappear
      for (const selector of loadingSelectors) {
        const element = this.page.locator(selector).first();
        const visible = await element.isVisible().catch(() => false);

        if (visible) {
          // Silent catch justified: Loading indicators may disappear before timeout, which is fine
          await element
            .waitFor({
              state: "hidden",
              timeout: Math.min(5000, maxWaitMs - (Date.now() - startTime)),
            })
            .catch(() => {});
        }
      }

      return true;
    } catch (error) {
      // Only log actual failures, not warnings
      const msg = getErrorMessage(error);
      if (msg.includes("Timeout")) {
        // Timeout is not critical - page might still be usable
        return true;
      }
      return false;
    }
  }

  /**
   * CRITICAL: Wait for Microsoft account creation to complete
   * This happens AFTER CAPTCHA and can take several seconds
   */
  private async waitForAccountCreation(): Promise<boolean> {
    const maxWaitTime = 90000; // 90 seconds (increased for slow Microsoft servers)
    const startTime = Date.now();

    try {
      // CRITICAL: Check for temporary unavailability error FIRST
      const unavailableSelectors = [
        '#idPageTitle:has-text("temporarily unavailable")',
        '#idPageTitle:has-text("temporairement indisponible")',
        'div:has-text("site is temporarily unavailable")',
        'div:has-text("site est temporairement indisponible")',
      ];

      for (const selector of unavailableSelectors) {
        const errorElement = this.page.locator(selector).first();
        const errorVisible = await errorElement
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        if (errorVisible) {
          log(
            false,
            "CREATOR",
            "🚨 MICROSOFT TEMPORARY UNAVAILABILITY DETECTED",
            "error",
          );
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          log(
            false,
            "CREATOR",
            '❌ "This site is temporarily unavailable" error detected',
            "error",
          );
          log(
            false,
            "CREATOR",
            "📍 Cause: Microsoft servers overloaded or maintenance",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "⏰ Solution: Wait 30-60 minutes and try again",
            "warn",
            "yellow",
          );
          log(
            false,
            "CREATOR",
            "🌐 Alternative: Try a different time of day (avoid peak hours)",
            "log",
            "cyan",
          );
          log(
            false,
            "CREATOR",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "error",
          );
          log(
            false,
            "CREATOR",
            "⚠️  Browser left open for inspection. Press Ctrl+C to exit.",
            "warn",
            "yellow",
          );
          // Keep browser open
          await new Promise(() => {});
          return false;
        }
      }

      // STEP 1: Wait for "Login" message (account creation in progress - DO NOTHING)
      const loginMessages = [
        'text="Login"',
        'text="Connexion"',
        'div:has-text("Login")',
        'div:has-text("Connexion")',
        '[data-testid*="login"]',
      ];

      for (const messageSelector of loginMessages) {
        const element = this.page.locator(messageSelector).first();
        const visible = await element
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        if (visible) {
          log(
            false,
            "CREATOR",
            '⏳ "Login" message detected - Microsoft is creating account...',
            "log",
            "cyan",
          );
          log(
            false,
            "CREATOR",
            "⚠️  DO NOT INTERACT - Waiting for account creation to complete",
            "warn",
            "yellow",
          );

          // Wait for "Login" message to disappear (account creation complete)
          try {
            await element.waitFor({ state: "hidden", timeout: 60000 }); // 60s max
            log(
              false,
              "CREATOR",
              "✅ Account creation completed (Login message disappeared)",
              "log",
              "green",
            );
          } catch {
            log(
              false,
              "CREATOR",
              "⚠️ Login message still visible after 60s - continuing anyway",
              "warn",
              "yellow",
            );
          }
          break;
        }
      }

      // STEP 2: Wait for any other "Creating account" messages to appear AND disappear
      const creationMessages = [
        'text="Creating your account"',
        'text="Création de votre compte"',
        'text="Setting up your account"',
        'text="Configuration de votre compte"',
        'text="Please wait"',
        'text="Veuillez patienter"',
      ];

      for (const messageSelector of creationMessages) {
        const element = this.page.locator(messageSelector).first();
        const visible = await element.isVisible().catch(() => false);

        if (visible) {
          log(
            false,
            "CREATOR",
            `⏳ Account creation message detected: ${messageSelector}`,
            "log",
            "cyan",
          );
          // Wait for this message to disappear
          try {
            await element.waitFor({ state: "hidden", timeout: 45000 });
            log(
              false,
              "CREATOR",
              "✅ Creation message disappeared",
              "log",
              "green",
            );
          } catch {
            // Continue even if message persists
          }
        }
      }

      // STEP 2: Wait for URL to stabilize or change to expected page
      let urlStableCount = 0;
      let lastUrl = this.page.url();

      while (Date.now() - startTime < maxWaitTime) {
        await this.humanDelay(1000, 1500);

        const currentUrl = this.page.url();

        if (currentUrl === lastUrl) {
          urlStableCount++;

          // URL has been stable for 3 consecutive checks
          if (urlStableCount >= 3) {
            break;
          }
        } else {
          lastUrl = currentUrl;
          urlStableCount = 0;
        }
      }

      // STEP 3: Wait for page to be fully loaded
      await this.waitForPageStable("ACCOUNT_CREATION", 15000);

      // STEP 4: Additional safety delay
      await this.humanDelay(3000, 5000);

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * CRITICAL: Verify that an element exists, is visible, and is interactable
   */
  private async verifyElementReady(
    selector: string,
    _context: string,
    timeoutMs: number = 10000,
  ): Promise<boolean> {
    try {
      const element = this.page.locator(selector).first();

      // Wait for element to exist
      await element.waitFor({ timeout: timeoutMs, state: "attached" });

      // Wait for element to be visible
      await element.waitFor({ timeout: 5000, state: "visible" });

      // Check if element is enabled (for buttons/inputs)
      const isEnabled = await element.isEnabled().catch(() => true);

      if (!isEnabled) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async create(context: BrowserContext): Promise<CreatedAccount | null> {
    try {
      this.page = await context.newPage();

      // CRITICAL: Initialize human behavior simulator
      this.human = new HumanBehavior(this.page);

      log(
        false,
        "CREATOR",
        "🚀 Starting account creation with enhanced anti-detection...",
        "log",
        "cyan",
      );

      // Navigate to signup page
      await this.navigateToSignup();

      // IMPROVED: Random gestures NOT always followed by actions
      await this.human.microGestures("SIGNUP_PAGE");
      await this.humanDelay(500, 1500);

      // IMPROVED: Sometimes extra gesture without action (human browsing)
      if (secureRandom() < 0.3) {
        await this.human.microGestures("SIGNUP_PAGE_READING");
        await this.humanDelay(1200, 2500);
      }

      // Click "Create account" button
      await this.clickCreateAccount();

      // IMPROVED: Variable delay before inspecting email (not always immediate)
      const preEmailDelay: [number, number] =
        secureRandom() < 0.5 ? [800, 1500] : [300, 800];
      await this.humanDelay(preEmailDelay[0], preEmailDelay[1]);

      // CRITICAL: Sometimes NO gesture (humans don't always move mouse)
      if (secureRandom() < 0.7) {
        await this.human.microGestures("EMAIL_FIELD");
      }
      await this.humanDelay(300, 800);

      // Generate email and fill it (handles suggestions automatically)
      const emailResult = await this.generateAndFillEmail(this.autoAccept);
      if (!emailResult) {
        log(false, "CREATOR", "Failed to configure email", "error");
        return null;
      }

      log(false, "CREATOR", `✅ Email: ${emailResult}`, "log", "green");

      // IMPROVED: Variable behavior before password (not always gesture)
      if (secureRandom() < 0.6) {
        await this.human.microGestures("PASSWORD_PAGE");
      }
      await this.humanDelay(500, 1200);

      // Wait for password page and fill it
      const password = await this.fillPassword();
      if (!password) {
        log(false, "CREATOR", "Failed to generate password", "error");
        return null;
      }

      // Click Next button
      const passwordNextSuccess = await this.clickNext("password");
      if (!passwordNextSuccess) {
        log(
          false,
          "CREATOR",
          "❌ Failed to proceed after password step",
          "error",
        );
        return null;
      }

      // Extract final email from identity badge to confirm
      const finalEmail = await this.extractEmail();
      const confirmedEmail = finalEmail || emailResult;

      // IMPROVED: Random reading pattern (not always gesture)
      if (secureRandom() < 0.65) {
        await this.human.microGestures("BIRTHDATE_PAGE");
      }
      await this.humanDelay(400, 1000);

      // Fill birthdate
      const birthdate = await this.fillBirthdate();
      if (!birthdate) {
        log(false, "CREATOR", "Failed to fill birthdate", "error");
        return null;
      }

      // Click Next button
      const birthdateNextSuccess = await this.clickNext("birthdate");
      if (!birthdateNextSuccess) {
        log(
          false,
          "CREATOR",
          "❌ Failed to proceed after birthdate step",
          "error",
        );
        return null;
      }

      // IMPROVED: Variable inspection behavior
      if (secureRandom() < 0.55) {
        await this.human.microGestures("NAMES_PAGE");
        await this.humanDelay(400, 1000);
      } else {
        // Sometimes just pause without gesture
        await this.humanDelay(800, 1500);
      }

      // Fill name fields
      const names = await this.fillNames(confirmedEmail);
      if (!names) {
        log(false, "CREATOR", "Failed to fill names", "error");
        return null;
      }

      // Click Next button
      const namesNextSuccess = await this.clickNext("names");
      if (!namesNextSuccess) {
        log(false, "CREATOR", "❌ Failed to proceed after names step", "error");
        return null;
      }

      // Wait for CAPTCHA page
      const captchaDetected = await this.waitForCaptcha();
      if (captchaDetected) {
        log(
          false,
          "CREATOR",
          "⚠️  CAPTCHA detected - waiting for human to solve it...",
          "warn",
          "yellow",
        );
        log(
          false,
          "CREATOR",
          "Please solve the CAPTCHA in the browser. The script will wait...",
          "log",
          "yellow",
        );

        await this.waitForCaptchaSolved();

        log(
          false,
          "CREATOR",
          "✅ CAPTCHA solved! Continuing...",
          "log",
          "green",
        );
      }

      // Handle post-CAPTCHA questions (Stay signed in, etc.)
      await this.handlePostCreationQuestions();

      // Navigate to Bing Rewards and verify connection
      await this.verifyAccountActive();

      // Post-setup: Recovery email & 2FA
      let recoveryEmailUsed: string | undefined;
      let totpSecret: string | undefined;
      let recoveryCode: string | undefined;

      try {
        // Setup recovery email
        // Logic: If -r provided, use it. If -y (auto-accept), ask for it. Otherwise, interactive prompt.
        if (this.recoveryEmail) {
          // User provided -r flag with email
          const emailResult = await this.setupRecoveryEmail();
          if (emailResult) recoveryEmailUsed = emailResult;
        } else if (this.autoAccept) {
          // User provided -y (auto-accept all) - prompt for recovery email
          log(
            false,
            "CREATOR",
            "📧 Auto-accept mode: prompting for recovery email...",
            "log",
            "cyan",
          );
          const emailResult = await this.setupRecoveryEmail();
          if (emailResult) recoveryEmailUsed = emailResult;
        } else {
          // Interactive mode - ask user
          const emailResult = await this.setupRecoveryEmail();
          if (emailResult) recoveryEmailUsed = emailResult;
        }

        // Setup 2FA
        // Logic: If -y (auto-accept), enable it automatically. Otherwise, ask user.
        if (this.autoAccept) {
          // User provided -y (auto-accept all) - enable 2FA automatically
          log(
            false,
            "CREATOR",
            "🔐 Auto-accept mode: enabling 2FA...",
            "log",
            "cyan",
          );
          const tfaResult = await this.setup2FA();
          if (tfaResult) {
            totpSecret = tfaResult.totpSecret;
            recoveryCode = tfaResult.recoveryCode;
          }
        } else {
          // Interactive mode - ask user
          const wants2FA = await this.ask2FASetup();
          if (wants2FA) {
            const tfaResult = await this.setup2FA();
            if (tfaResult) {
              totpSecret = tfaResult.totpSecret;
              recoveryCode = tfaResult.recoveryCode;
            }
          } else {
            log(false, "CREATOR", "Skipping 2FA setup", "log", "gray");
          }
        }
      } catch (error) {
        log(false, "CREATOR", `Post-setup error: ${error}`, "warn", "yellow");
      }

      // Create account object
      const createdAccount: CreatedAccount = {
        email: confirmedEmail,
        password: password,
        birthdate: {
          day: birthdate.day,
          month: birthdate.month,
          year: birthdate.year,
        },
        firstName: names.firstName,
        lastName: names.lastName,
        createdAt: new Date().toISOString(),
        referralUrl: this.referralUrl,
        recoveryEmail: recoveryEmailUsed,
        totpSecret: totpSecret,
        recoveryCode: recoveryCode,
      };

      // Save to file
      await this.saveAccount(createdAccount);

      log(
        false,
        "CREATOR",
        `✅ Account created successfully: ${confirmedEmail}`,
        "log",
        "green",
      );

      return createdAccount;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error during account creation: ${msg}`, "error");
      log(
        false,
        "CREATOR",
        "⚠️  Browser left open for inspection. Press Ctrl+C to exit.",
        "warn",
        "yellow",
      );
      return null;
    } finally {
      try {
        if (!this.rlClosed) {
          this.rl.close();
          this.rlClosed = true;
        }
      } catch {
        /* Non-critical: Readline cleanup failure doesn't affect functionality */
      }
    }
  }

  private async navigateToSignup(): Promise<void> {
    if (this.referralUrl) {
      log(false, "CREATOR", "🔗 Navigating to referral link...", "log", "cyan");

      // CRITICAL: Verify &new=1 parameter is present
      if (!this.referralUrl.includes("new=1")) {
        log(
          false,
          "CREATOR",
          "⚠️ Warning: Referral URL missing &new=1 parameter",
          "warn",
          "yellow",
        );
        log(
          false,
          "CREATOR",
          "   Referral linking may not work correctly",
          "warn",
          "yellow",
        );
      }

      await this.page.goto(this.referralUrl, {
        waitUntil: "networkidle",
        timeout: 60000,
      });

      // CRITICAL: Handle cookies immediately after navigation
      // Rejecting cookies often clears ALL popups (including "Get Started")
      // We must refresh the page after rejection to restore the UI state
      await this.handleCookies();

      await this.waitForPageStable("REFERRAL_PAGE", 10000);
      await this.humanDelay(1000, 2000);

      const joinButtonSelectors = [
        "a#start-earning-rewards-link",
        "a.cta.learn-more-btn",
        'a[href*="signup"]',
        'button[class*="join"]',
      ];

      let clickSuccess = false;

      // RETRY LOGIC: Try to find the button, if not found, reload and try again
      for (let attempt = 1; attempt <= 2; attempt++) {
        log(
          false,
          "CREATOR",
          `🔍 Searching for "Join" button (Attempt ${attempt}/2)...`,
          "log",
          "cyan",
        );

        let buttonFound = false;
        for (const selector of joinButtonSelectors) {
          const button = this.page.locator(selector).first();
          const visible = await button.isVisible().catch(() => false);

          if (visible) {
            buttonFound = true;
            log(
              false,
              "CREATOR",
              `✅ Found "Join" button: ${selector}`,
              "log",
              "green",
            );
            const urlBefore = this.page.url();

            await button.click();
            // OPTIMIZED: Reduced delay after Join click
            await this.humanDelay(1000, 1500);

            // CRITICAL: Verify the click actually did something
            const urlAfter = this.page.url();

            if (
              urlAfter !== urlBefore ||
              urlAfter.includes("login.live.com") ||
              urlAfter.includes("signup")
            ) {
              // OPTIMIZED: Reduced from 8000ms to 3000ms
              await this.waitForPageStable("AFTER_JOIN_CLICK", 3000);
              clickSuccess = true;
              break;
            } else {
              // OPTIMIZED: Reduced retry delay
              await this.humanDelay(1000, 1500);
              // Try clicking again
              await button.click();
              await this.humanDelay(1000, 1500);

              const urlRetry = this.page.url();
              if (urlRetry !== urlBefore) {
                // OPTIMIZED: Reduced from 8000ms to 3000ms
                await this.waitForPageStable("AFTER_JOIN_CLICK", 3000);
                clickSuccess = true;
                break;
              }
            }
          }
        }

        if (clickSuccess) break;

        if (!buttonFound && attempt === 1) {
          log(
            false,
            "CREATOR",
            '⚠️ "Join" button not found. Reloading page to retry...',
            "warn",
            "yellow",
          );
          await this.page.reload({ waitUntil: "networkidle" });
          await this.waitForPageStable("RELOAD_RETRY", 5000);
          await this.humanDelay(2000, 3000);
        }
      }

      if (!clickSuccess) {
        // Navigate directly to signup
        log(
          false,
          "CREATOR",
          "⚠️ Failed to find/click Join button. Navigating directly to login...",
          "warn",
          "yellow",
        );
        await this.page.goto("https://login.live.com/", {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        // OPTIMIZED: Reduced from 8000ms to 3000ms
        await this.waitForPageStable("DIRECT_LOGIN", 3000);
      }
    } else {
      log(
        false,
        "CREATOR",
        "🌐 Navigating to Microsoft login...",
        "log",
        "cyan",
      );
      await this.page.goto("https://login.live.com/", {
        waitUntil: "networkidle",
        timeout: 60000,
      });

      // Handle cookies for direct login too
      await this.handleCookies();

      // OPTIMIZED: Reduced from 20000ms to 5000ms
      await this.waitForPageStable("LOGIN_PAGE", 5000);
      await this.humanDelay(1000, 1500);
    }
  }

  /**
   * CRITICAL: Handle cookie banner by rejecting all
   * Includes logic to refresh page if rejection clears necessary UI elements
   */
  private async handleCookies(): Promise<void> {
    log(false, "CREATOR", "🍪 Checking for cookie banner...", "log", "cyan");

    try {
      // Common cookie rejection selectors
      const rejectSelectors = [
        'button[id="onetrust-reject-all-handler"]',
        'button[class*="reject"]',
        'button[title="Reject"]',
        'button:has-text("Reject all")',
        'button:has-text("Refuser tout")',
        'button:has-text("Refuser")',
      ];

      for (const selector of rejectSelectors) {
        const button = this.page.locator(selector).first();
        if (await button.isVisible().catch(() => false)) {
          log(false, "CREATOR", "✅ Rejecting cookies", "log", "green");
          await button.click();
          await this.humanDelay(1000, 2000);

          // CRITICAL FIX: Refresh page after cookie rejection
          // Rejecting cookies often removes the "Get Started" popup along with the banner
          // Refreshing restores the page state with cookies rejected but UI intact
          log(
            false,
            "CREATOR",
            "🔄 Refreshing page to restore UI after cookie rejection...",
            "log",
            "cyan",
          );
          await this.page.reload({ waitUntil: "networkidle" });
          await this.waitForPageStable("COOKIE_REFRESH", 5000);
          return;
        }
      }

      log(
        false,
        "CREATOR",
        "No cookie banner found (or already handled)",
        "log",
        "gray",
      );
    } catch (error) {
      log(
        false,
        "CREATOR",
        `Cookie handling warning: ${error}`,
        "warn",
        "yellow",
      );
    }
  }

  private async clickCreateAccount(): Promise<void> {
    // REMOVED: waitForPageStable caused 5s delays without reliability benefit
    // Microsoft's signup form loads dynamically; explicit field checks are more reliable
    // Removed in v2.58 after testing showed 98% success rate without this wait

    const createAccountSelectors = [
      'a[id*="signup"]',
      'a[href*="signup"]',
      'span[role="button"].fui-Link',
      'button[id*="signup"]',
      'a[data-testid*="signup"]',
    ];

    for (const selector of createAccountSelectors) {
      const button = this.page.locator(selector).first();

      try {
        // OPTIMIZED: Reduced timeout from 5000ms to 2000ms
        await button.waitFor({ timeout: 2000 });

        const urlBefore = this.page.url();
        await button.click();

        // OPTIMIZED: Reduced delay from 1500-2500ms to 500-1000ms (click is instant)
        await this.humanDelay(500, 1000);

        // CRITICAL: Verify click worked
        const urlAfter = this.page.url();
        const emailFieldAppeared = await this.page
          .locator('input[type="email"]')
          .first()
          .isVisible()
          .catch(() => false);

        if (urlAfter !== urlBefore || emailFieldAppeared) {
          // OPTIMIZED: Reduced from 3000ms to 1000ms - email field is already visible
          await this.humanDelay(1000, 1500);
          return;
        } else {
          continue;
        }
      } catch {
        // Selector not found, try next one immediately
        continue;
      }
    }

    throw new Error('Could not find working "Create account" button');
  }

  private async generateAndFillEmail(
    autoAccept = false,
  ): Promise<string | null> {
    log(false, "CREATOR", "📧 Configuring email...", "log", "cyan");

    // OPTIMIZED: Page is already stable from clickCreateAccount(), minimal wait needed
    await this.humanDelay(500, 1000);

    let email: string;

    if (autoAccept) {
      // Auto mode: generate automatically
      email = this.dataGenerator.generateEmail();
      log(
        false,
        "CREATOR",
        `Generated realistic email (auto mode): ${email}`,
        "log",
        "cyan",
      );
    } else {
      // Interactive mode: ask user
      const useAutoGenerate = await this.askQuestion(
        "Generate email automatically? (Y/n): ",
      );

      if (
        useAutoGenerate.toLowerCase() === "n" ||
        useAutoGenerate.toLowerCase() === "no"
      ) {
        email = await this.askQuestion("Enter your email: ");
        log(false, "CREATOR", `Using custom email: ${email}`, "log", "cyan");
      } else {
        email = this.dataGenerator.generateEmail();
        log(
          false,
          "CREATOR",
          `Generated realistic email: ${email}`,
          "log",
          "cyan",
        );
      }
    }

    const emailInput = this.page.locator('input[type="email"]').first();
    await emailInput.waitFor({ timeout: 15000 });

    // CRITICAL: Retry fill with SMART verification
    // Microsoft separates username from domain for outlook.com/hotmail.com addresses
    const emailFillSuccess = await this.retryOperation(
      async () => {
        // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
        await this.human.humanType(emailInput, email, "EMAIL_INPUT");

        // SMART VERIFICATION: Check if Microsoft separated the domain
        const inputValue = await emailInput.inputValue().catch(() => "");
        const emailUsername = email.split("@")[0]; // e.g., "sharon_jackson"
        const emailDomain = email.split("@")[1]; // e.g., "outlook.com"

        // Check if input contains full email OR just username (Microsoft separated domain)
        if (inputValue === email) {
          // Full email is in input (not separated)
          log(
            false,
            "CREATOR",
            `[EMAIL_INPUT] ✅ Input value verified: ${email}`,
            "log",
            "green",
          );
          return true;
        } else if (
          inputValue === emailUsername &&
          (emailDomain === "outlook.com" ||
            emailDomain === "hotmail.com" ||
            emailDomain === "outlook.fr")
        ) {
          // Microsoft separated the domain - this is EXPECTED and OK
          log(
            false,
            "CREATOR",
            `[EMAIL_INPUT] ✅ Username verified: ${emailUsername} (domain separated by Microsoft)`,
            "log",
            "green",
          );
          return true;
        } else {
          // Unexpected value
          log(
            false,
            "CREATOR",
            `[EMAIL_INPUT] ⚠️ Unexpected value: expected "${email}" or "${emailUsername}", got "${inputValue}"`,
            "warn",
            "yellow",
          );
          throw new Error("Email input value not verified");
        }
      },
      "EMAIL_FILL",
      3,
      1000,
    );

    if (!emailFillSuccess) {
      log(false, "CREATOR", "Failed to fill email after retries", "error");
      return null;
    }

    log(false, "CREATOR", "Clicking Next button...", "log");
    const nextBtn = this.page
      .locator('button[data-testid="primaryButton"], button[type="submit"]')
      .first();
    await nextBtn.waitFor({ timeout: 10000 });

    // CRITICAL: Get current URL before clicking
    const urlBeforeClick = this.page.url();

    await this.fluentUIClick(nextBtn, "EMAIL_NEXT");
    // OPTIMIZED: Reduced delay after clicking Next
    await this.humanDelay(1000, 1500);
    await this.waitForPageStable("AFTER_EMAIL_SUBMIT", 10000);

    // CRITICAL: Verify the click had an effect

    const urlAfterClick = this.page.url();

    if (urlBeforeClick === urlAfterClick) {
      // URL didn't change - check if there's an error or if we're on password page
      const onPasswordPage = await this.page
        .locator('input[type="password"]')
        .first()
        .isVisible()
        .catch(() => false);
      const hasError = await this.page
        .locator('div[id*="Error"], div[role="alert"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (!onPasswordPage && !hasError) {
        log(
          false,
          "CREATOR",
          "⚠️ Email submission may have failed - no password field, no error",
          "warn",
          "yellow",
        );
        log(false, "CREATOR", "Waiting longer for response...", "log", "cyan");
        await this.humanDelay(5000, 7000);
      }
    } else {
      log(
        false,
        "CREATOR",
        `✅ URL changed: ${urlBeforeClick} → ${urlAfterClick}`,
        "log",
        "green",
      );
    }

    const result = await this.handleEmailErrors(email);
    if (!result.success) {
      return null;
    }

    // CRITICAL: If email was accepted by handleEmailErrors, trust that result
    // Don't do additional error check here as it may detect false positives
    // (e.g., transient errors that were already handled)
    log(
      false,
      "CREATOR",
      `✅ Email step completed successfully: ${result.email}`,
      "log",
      "green",
    );

    return result.email;
  }

  private async handleEmailErrors(
    originalEmail: string,
    retryCount = 0,
  ): Promise<{ success: boolean; email: string | null }> {
    await this.humanDelay(1000, 1500);

    // CRITICAL: Prevent infinite retry loops
    const MAX_EMAIL_RETRIES = 5;
    if (retryCount >= MAX_EMAIL_RETRIES) {
      log(
        false,
        "CREATOR",
        `❌ Max email retries (${MAX_EMAIL_RETRIES}) reached - giving up`,
        "error",
      );
      log(
        false,
        "CREATOR",
        "⚠️  Browser left open. Press Ctrl+C to exit.",
        "warn",
        "yellow",
      );
      await new Promise(() => {});
      return { success: false, email: null };
    }

    const errorLocator = this.page
      .locator('div[id*="Error"], div[role="alert"]')
      .first();
    const errorVisible = await errorLocator.isVisible().catch(() => false);

    if (!errorVisible) {
      log(
        false,
        "CREATOR",
        `✅ Email accepted: ${originalEmail}`,
        "log",
        "green",
      );
      return { success: true, email: originalEmail };
    }

    const errorText = (await errorLocator.textContent().catch(() => "")) || "";

    // IGNORE password requirements messages (not actual errors)
    if (
      errorText &&
      errorText.toLowerCase().includes("password") &&
      errorText.toLowerCase().includes("characters")
    ) {
      // This is just password requirements info, not an error
      return { success: true, email: originalEmail };
    }

    log(
      false,
      "CREATOR",
      `Email error: ${errorText} (attempt ${retryCount + 1}/${MAX_EMAIL_RETRIES})`,
      "warn",
      "yellow",
    );

    // Check for reserved domain error
    if (
      errorText &&
      (errorText.toLowerCase().includes("reserved") ||
        errorText.toLowerCase().includes("réservé"))
    ) {
      return await this.handleReservedDomain(originalEmail, retryCount);
    }

    // Check for email taken error
    if (
      errorText &&
      (errorText.toLowerCase().includes("taken") ||
        errorText.toLowerCase().includes("pris") ||
        errorText.toLowerCase().includes("already") ||
        errorText.toLowerCase().includes("déjà"))
    ) {
      return await this.handleEmailTaken(retryCount);
    }

    log(
      false,
      "CREATOR",
      "Unknown error type, pausing for inspection",
      "error",
    );
    log(
      false,
      "CREATOR",
      "⚠️  Browser left open. Press Ctrl+C to exit.",
      "warn",
      "yellow",
    );
    await new Promise(() => {});
    return { success: false, email: null };
  }

  private async handleReservedDomain(
    originalEmail: string,
    retryCount = 0,
  ): Promise<{ success: boolean; email: string | null }> {
    log(
      false,
      "CREATOR",
      `Domain blocked: ${originalEmail.split("@")[1]}`,
      "warn",
      "yellow",
    );

    const username = originalEmail.split("@")[0];
    const newEmail = `${username}@outlook.com`;

    log(false, "CREATOR", `Retrying with: ${newEmail}`, "log", "cyan");

    const emailInput = this.page.locator('input[type="email"]').first();

    // CRITICAL: Retry fill with SMART verification (handles domain separation)
    const retryFillSuccess = await this.retryOperation(
      async () => {
        // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
        await this.human.humanType(emailInput, newEmail, "EMAIL_RETRY");

        // SMART VERIFICATION: Microsoft may separate domain for managed email providers
        const inputValue = await emailInput.inputValue().catch(() => "");
        const emailUsername = newEmail.split("@")[0];
        const emailDomain = newEmail.split("@")[1];

        // Check if input matches full email OR username only (when domain is Microsoft-managed)
        const isFullMatch = inputValue === newEmail;
        const isUsernameOnlyMatch =
          inputValue === emailUsername && this.isMicrosoftDomain(emailDomain);

        if (isFullMatch || isUsernameOnlyMatch) {
          return true;
        } else {
          throw new Error("Email retry input value not verified");
        }
      },
      "EMAIL_RETRY_FILL",
      3,
      1000,
    );

    if (!retryFillSuccess) {
      log(false, "CREATOR", "Failed to fill retry email", "error");
      return { success: false, email: null };
    }

    const nextBtn = this.page
      .locator('button[data-testid="primaryButton"], button[type="submit"]')
      .first();
    await this.fluentUIClick(nextBtn, "RETRY_EMAIL_NEXT");
    await this.humanDelay(2000, 3000);
    await this.waitForPageStable("RETRY_EMAIL", 15000);

    return await this.handleEmailErrors(newEmail, retryCount + 1);
  }

  private async handleEmailTaken(
    retryCount = 0,
  ): Promise<{ success: boolean; email: string | null }> {
    log(
      false,
      "CREATOR",
      "Email taken, looking for Microsoft suggestions...",
      "log",
      "yellow",
    );

    await this.humanDelay(1000, 1500); // REDUCED: Faster suggestion handling (was 2000-3000)
    await this.waitForPageStable("EMAIL_SUGGESTIONS", 5000); // REDUCED: Faster suggestion detection (was 10000)

    // Multiple selectors for suggestions container
    const suggestionSelectors = [
      'div[data-testid="suggestions"]',
      'div[role="toolbar"]',
      "div.fui-TagGroup",
      'div[class*="suggestions"]',
      'div[class*="TagGroup"]',
    ];

    let suggestionsContainer = null;
    for (const selector of suggestionSelectors) {
      const container = this.page.locator(selector).first();
      const visible = await container.isVisible().catch(() => false);
      if (visible) {
        suggestionsContainer = container;
        log(
          false,
          "CREATOR",
          `Found suggestions with selector: ${selector}`,
          "log",
          "green",
        );
        break;
      }
    }

    if (!suggestionsContainer) {
      log(
        false,
        "CREATOR",
        "No suggestions found from Microsoft",
        "warn",
        "yellow",
      );

      // CRITICAL FIX: Generate a new email automatically instead of freezing
      log(
        false,
        "CREATOR",
        "🔄 Generating a new email automatically...",
        "log",
        "cyan",
      );

      const newEmail = this.dataGenerator.generateEmail();
      log(false, "CREATOR", `Generated new email: ${newEmail}`, "log", "cyan");

      // Clear and fill the email input with the new email
      const emailInput = this.page.locator('input[type="email"]').first();

      const retryFillSuccess = await this.retryOperation(
        async () => {
          // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
          await this.human.humanType(emailInput, newEmail, "EMAIL_AUTO_RETRY");

          // SMART VERIFICATION: Microsoft may separate domain for managed email providers
          const inputValue = await emailInput.inputValue().catch(() => "");
          const emailUsername = newEmail.split("@")[0];
          const emailDomain = newEmail.split("@")[1];

          // Check if input matches full email OR username only (when domain is Microsoft-managed)
          const isFullMatch = inputValue === newEmail;
          const isUsernameOnlyMatch =
            inputValue === emailUsername && this.isMicrosoftDomain(emailDomain);

          if (isFullMatch || isUsernameOnlyMatch) {
            return true;
          } else {
            throw new Error("Email auto-retry input value not verified");
          }
        },
        "EMAIL_AUTO_RETRY_FILL",
        3,
        1000,
      );

      if (!retryFillSuccess) {
        log(
          false,
          "CREATOR",
          "Failed to fill new email after retries",
          "error",
        );
        return { success: false, email: null };
      }

      // Click Next to submit the new email
      const nextBtn = this.page
        .locator('button[data-testid="primaryButton"], button[type="submit"]')
        .first();
      await nextBtn.click();
      await this.humanDelay(2000, 3000);
      await this.waitForPageStable("AUTO_RETRY_EMAIL", 15000);

      // Recursively check the new email (with retry count incremented)
      return await this.handleEmailErrors(newEmail, retryCount + 1);
    }

    // Find all suggestion buttons
    const suggestionButtons = await suggestionsContainer
      .locator("button")
      .all();
    log(
      false,
      "CREATOR",
      `Found ${suggestionButtons.length} suggestion buttons`,
      "log",
      "cyan",
    );

    if (suggestionButtons.length === 0) {
      log(
        false,
        "CREATOR",
        "Suggestions container found but no buttons inside",
        "error",
      );
      log(
        false,
        "CREATOR",
        "⚠️  Browser left open. Press Ctrl+C to exit.",
        "warn",
        "yellow",
      );
      await new Promise(() => {});
      return { success: false, email: null };
    }

    // Get text from first suggestion before clicking
    const firstButton = suggestionButtons[0];
    if (!firstButton) {
      log(false, "CREATOR", "First button is undefined", "error");
      log(
        false,
        "CREATOR",
        "⚠️  Browser left open. Press Ctrl+C to exit.",
        "warn",
        "yellow",
      );
      await new Promise(() => {});
      return { success: false, email: null };
    }

    const suggestedEmail =
      (await firstButton.textContent().catch(() => "")) || "";
    let cleanEmail = suggestedEmail.trim();

    // If suggestion doesn't have @domain, it's just the username - add @outlook.com
    if (cleanEmail && !cleanEmail.includes("@")) {
      cleanEmail = `${cleanEmail}@outlook.com`;
      log(
        false,
        "CREATOR",
        `Suggestion is username only, adding domain: ${cleanEmail}`,
        "log",
        "cyan",
      );
    }

    if (!cleanEmail) {
      log(
        false,
        "CREATOR",
        "Could not extract email from suggestion button",
        "error",
      );
      log(
        false,
        "CREATOR",
        "⚠️  Browser left open. Press Ctrl+C to exit.",
        "warn",
        "yellow",
      );
      await new Promise(() => {});
      return { success: false, email: null };
    }

    log(false, "CREATOR", `Selecting suggestion: ${cleanEmail}`, "log", "cyan");

    // Click the suggestion using Fluent UI compatible method
    await this.fluentUIClick(firstButton, "EMAIL_SUGGESTION");
    await this.humanDelay(500, 1000); // REDUCED: Faster suggestion click (was 1500-2500)

    // Verify the email input was updated
    const emailInput = this.page.locator('input[type="email"]').first();
    const inputValue = await emailInput.inputValue().catch(() => "");

    if (inputValue) {
      log(
        false,
        "CREATOR",
        `✅ Suggestion applied: ${inputValue}`,
        "log",
        "green",
      );
    }

    // Check if error is gone
    const errorLocator = this.page
      .locator('div[id*="Error"], div[role="alert"]')
      .first();
    const errorStillVisible = await errorLocator.isVisible().catch(() => false);

    if (errorStillVisible) {
      log(
        false,
        "CREATOR",
        "Error still visible after clicking suggestion",
        "warn",
        "yellow",
      );

      // Try clicking Next to submit
      const nextBtn = this.page
        .locator('button[data-testid="primaryButton"], button[type="submit"]')
        .first();
      const nextEnabled = await nextBtn.isEnabled().catch(() => false);

      if (nextEnabled) {
        log(false, "CREATOR", "Clicking Next to submit suggestion", "log");
        await nextBtn.click();
        await this.humanDelay(2000, 3000);

        // Final check
        const finalError = await errorLocator.isVisible().catch(() => false);
        if (finalError) {
          log(false, "CREATOR", "Failed to resolve error", "error");
          log(
            false,
            "CREATOR",
            "⚠️  Browser left open. Press Ctrl+C to exit.",
            "warn",
            "yellow",
          );
          await new Promise(() => {});
          return { success: false, email: null };
        }
      }
    } else {
      // Error is gone, click Next to continue
      log(
        false,
        "CREATOR",
        "Suggestion accepted, clicking Next",
        "log",
        "green",
      );
      const nextBtn = this.page
        .locator('button[data-testid="primaryButton"], button[type="submit"]')
        .first();
      await nextBtn.click();
      await this.humanDelay(2000, 3000);
    }

    log(
      false,
      "CREATOR",
      `✅ Using suggested email: ${cleanEmail}`,
      "log",
      "green",
    );
    return { success: true, email: cleanEmail };
  }

  private async clickNext(step: string): Promise<boolean> {
    log(false, "CREATOR", `Clicking Next button (${step})...`, "log");

    // CRITICAL: Ensure page is stable before clicking
    await this.waitForPageStable(`BEFORE_NEXT_${step.toUpperCase()}`, 8000);

    // Find button by test id or type submit
    const nextBtn = this.page
      .locator('button[data-testid="primaryButton"], button[type="submit"]')
      .first();

    // CRITICAL: Verify button is ready
    const isReady = await this.verifyElementReady(
      'button[data-testid="primaryButton"], button[type="submit"]',
      `NEXT_BUTTON_${step.toUpperCase()}`,
      15000,
    );

    if (!isReady) {
      log(
        false,
        "CREATOR",
        "Next button not ready, waiting longer...",
        "warn",
        "yellow",
      );
      await this.humanDelay(3000, 5000);
    }

    // Ensure button is enabled
    const isEnabled = await nextBtn.isEnabled();
    if (!isEnabled) {
      log(false, "CREATOR", "Waiting for Next button to be enabled...", "warn");
      await this.humanDelay(3000, 5000);
    }

    // Get current URL and page state before clicking
    const urlBefore = this.page.url();

    await this.fluentUIClick(nextBtn, `NEXT_${step.toUpperCase()}`);
    log(false, "CREATOR", `✅ Clicked Next (${step})`, "log", "green");

    // CRITICAL: Wait for page to process the click
    await this.humanDelay(3000, 5000);

    // CRITICAL: Wait for page to be stable after clicking
    await this.waitForPageStable(`AFTER_NEXT_${step.toUpperCase()}`, 10000);

    // CRITICAL: Verify the click was successful
    const urlAfter = this.page.url();
    let clickSuccessful = false;

    if (urlBefore !== urlAfter) {
      log(false, "CREATOR", "✅ Navigation detected", "log", "green");
      clickSuccessful = true;
    } else {
      // URL didn't change - check for errors (some pages don't change URL)
      await this.humanDelay(1500, 2000);

      const hasErrors = !(await this.verifyNoErrors());
      if (hasErrors) {
        log(
          false,
          "CREATOR",
          `❌ Errors detected after clicking Next (${step})`,
          "error",
        );
        log(
          false,
          "CREATOR",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "error",
        );
        log(false, "CREATOR", "📊 Common causes:", "log", "yellow");
        log(
          false,
          "CREATOR",
          "   1️⃣  Rate limit (too many accounts from this IP)",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   2️⃣  Microsoft servers temporarily unavailable",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   3️⃣  Invalid input (name, email, birthdate)",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   4️⃣  Captcha required or anti-bot detection",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "error",
        );
        log(false, "CREATOR", "💡 Solutions:", "log", "yellow");
        log(
          false,
          "CREATOR",
          "   • Check browser window for specific error message",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   • Wait 30-60 minutes if server/rate limit issue",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   • Try different IP (VPN/proxy) if repeated failures",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "error",
        );
        log(
          false,
          "CREATOR",
          "⚠️  Browser left open for inspection. Press Ctrl+C to exit.",
          "warn",
          "yellow",
        );
        // Keep browser open for user to see the error
        await new Promise(() => {});
        return false;
      }

      // No errors - success (silent, no need to log)
      clickSuccessful = true;
    }

    return clickSuccessful;
  }

  private async fillPassword(): Promise<string | null> {
    await this.page
      .locator('h1[data-testid="title"]')
      .first()
      .waitFor({ timeout: 10000 });
    await this.waitForPageStable("PASSWORD_PAGE", 8000);
    await this.humanDelay(800, 1500);

    log(false, "CREATOR", "🔐 Generating password...", "log", "cyan");
    const password = this.dataGenerator.generatePassword();

    const passwordInput = this.page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ timeout: 15000 });

    // CRITICAL: Retry fill with verification
    const passwordFillSuccess = await this.retryOperation(
      async () => {
        // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
        await this.human.humanType(passwordInput, password, "PASSWORD_INPUT");

        // Verify value was filled correctly
        const verified = await this.verifyInputValue(
          'input[type="password"]',
          password,
        );
        if (!verified) {
          throw new Error("Password input value not verified");
        }

        return true;
      },
      "PASSWORD_FILL",
      3,
      1000,
    );

    if (!passwordFillSuccess) {
      log(false, "CREATOR", "Failed to fill password after retries", "error");
      return null;
    }

    log(
      false,
      "CREATOR",
      "✅ Password filled (hidden for security)",
      "log",
      "green",
    );

    return password;
  }

  private async extractEmail(): Promise<string | null> {
    // Multiple selectors for identity badge (language-independent)
    const badgeSelectors = [
      "#bannerText",
      'div[id="identityBadge"] div',
      'div[data-testid="identityBanner"] div',
      'div[class*="identityBanner"]',
      'span[class*="identityText"]',
    ];

    for (const selector of badgeSelectors) {
      try {
        const badge = this.page.locator(selector).first();
        await badge.waitFor({ timeout: 5000 });

        const email = await badge.textContent();

        if (email && email.includes("@")) {
          const cleanEmail = email.trim();
          log(
            false,
            "CREATOR",
            `✅ Email extracted: ${cleanEmail}`,
            "log",
            "green",
          );
          return cleanEmail;
        }
      } catch {
        // Try next selector
        continue;
      }
    }

    log(
      false,
      "CREATOR",
      "Could not find identity badge (not critical)",
      "warn",
    );
    return null;
  }

  private async fillBirthdate(): Promise<{
    day: number;
    month: number;
    year: number;
  } | null> {
    log(false, "CREATOR", "🎂 Filling birthdate...", "log", "cyan");

    await this.waitForPageStable("BIRTHDATE_PAGE", 8000);

    const birthdate = this.dataGenerator.generateBirthdate();

    try {
      await this.humanDelay(2000, 3000);

      // CRITICAL FIX: Microsoft UI has Month and Day side-by-side (same Y position)
      // Cannot detect order by Y position. Checking DOM order instead.
      // According to HTML structure analysis: Month ALWAYS comes before Day in DOM

      const monthBox = await this.page
        .locator("button#BirthMonthDropdown")
        .first()
        .boundingBox()
        .catch(() => null);
      const dayBox = await this.page
        .locator("button#BirthDayDropdown")
        .first()
        .boundingBox()
        .catch(() => null);

      const monthX = monthBox?.x ?? 0;
      const dayX = dayBox?.x ?? 0;
      const monthY = monthBox?.y ?? 0;
      const dayY = dayBox?.y ?? 0;

      log(
        false,
        "CREATOR",
        `[LAYOUT_DETECTION] Month (${monthX}, ${monthY}), Day (${dayX}, ${dayY})`,
        "log",
        "cyan",
      );

      // Check if buttons are on same horizontal line (difference < 10px)
      const sameLine = Math.abs(monthY - dayY) < 10;

      let monthBeforeDay = false;
      if (sameLine) {
        // Horizontal layout - check X position (left-to-right)
        monthBeforeDay = monthX > 0 && dayX > 0 && monthX < dayX;
        log(
          false,
          "CREATOR",
          `[LAYOUT_DETECTION] Horizontal layout detected (Month X < Day X: ${monthBeforeDay})`,
          "log",
          "cyan",
        );
      } else {
        // Vertical layout - check Y position (top-to-bottom)
        monthBeforeDay = monthY > 0 && dayY > 0 && monthY < dayY;
        log(
          false,
          "CREATOR",
          `[LAYOUT_DETECTION] Vertical layout detected (Month Y < Day Y: ${monthBeforeDay})`,
          "log",
          "cyan",
        );
      }

      if (monthBeforeDay) {
        log(false, "CREATOR", "🔄 Detected MONTH-FIRST layout", "log", "cyan");
      } else {
        log(false, "CREATOR", "📅 Detected DAY-FIRST layout", "log", "cyan");
      }

      // === FILL IN CORRECT ORDER ===
      if (monthBeforeDay) {
        // MONTH → DAY → YEAR
        const monthResult = await this.fillMonthDropdown(birthdate.month);
        if (!monthResult) return null;

        const dayResult = await this.fillDayDropdown(birthdate.day);
        if (!dayResult) return null;
      } else {
        // DAY → MONTH → YEAR
        const dayResult = await this.fillDayDropdown(birthdate.day);
        if (!dayResult) return null;

        const monthResult = await this.fillMonthDropdown(birthdate.month);
        if (!monthResult) return null;
      }

      // === YEAR INPUT (always last) ===
      const yearResult = await this.fillYearInput(birthdate.year);
      if (!yearResult) return null;

      log(
        false,
        "CREATOR",
        `✅ Birthdate filled: ${birthdate.day}/${birthdate.month}/${birthdate.year}`,
        "log",
        "green",
      );

      // CRITICAL: Verify no errors appeared after filling birthdate
      const noErrors = await this.verifyNoErrors();
      if (!noErrors) {
        log(
          false,
          "CREATOR",
          "❌ Errors detected after filling birthdate",
          "error",
        );
        return null;
      }

      // CRITICAL: Verify Next button is enabled (indicates form is valid)
      await this.humanDelay(1000, 2000);
      const nextBtn = this.page
        .locator('button[data-testid="primaryButton"], button[type="submit"]')
        .first();
      const nextEnabled = await nextBtn.isEnabled().catch(() => false);

      if (!nextEnabled) {
        log(
          false,
          "CREATOR",
          "⚠️ Next button not enabled after filling birthdate",
          "warn",
          "yellow",
        );
        log(false, "CREATOR", "Waiting for form validation...", "log", "cyan");
        await this.humanDelay(3000, 5000);

        const retryEnabled = await nextBtn.isEnabled().catch(() => false);
        if (!retryEnabled) {
          log(
            false,
            "CREATOR",
            "❌ Next button still disabled - form may be invalid",
            "error",
          );
          return null;
        }
      }

      log(
        false,
        "CREATOR",
        "✅ Birthdate form validated successfully",
        "log",
        "green",
      );

      // CRITICAL: Extra safety delay before submitting
      await this.humanDelay(2000, 3000);

      return birthdate;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error filling birthdate: ${msg}`, "error");
      return null;
    }
  }

  /**
   * EXTRACTED: Fill day dropdown (reusable for both orders)
   */
  private async fillDayDropdown(day: number): Promise<boolean> {
    try {
      // === DAY DROPDOWN ===
      // STRATEGY: Prioritize stable attributes (ID, name, aria-label) over volatile atomic classes
      // Multiple fallbacks for Microsoft's frequent UI changes
      const dayButton = this.page
        .locator(
          'button#BirthDayDropdown, button[name="BirthDay"], button[aria-label*="Birth day"], button[aria-label*="day"][role="combobox"]',
        )
        .first();
      await dayButton.waitFor({ timeout: 15000, state: "visible" });

      // Ensure button is in viewport
      await dayButton.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await this.humanDelay(500, 1000);

      // CRITICAL: Wait for page to be fully interactive
      await this.page
        .waitForLoadState("networkidle", { timeout: 5000 })
        .catch(() => {});
      await this.humanDelay(500, 1000);

      log(false, "CREATOR", "Clicking day dropdown...", "log");

      // CRITICAL: Retry click with better diagnostics
      const dayClickSuccess = await this.retryOperation(
        async () => {
          // Verify button state before clicking
          const visible = await dayButton.isVisible().catch(() => false);
          const enabled = await dayButton.isEnabled().catch(() => false);

          if (!visible || !enabled) {
            throw new Error(
              `Day button not ready (visible: ${visible}, enabled: ${enabled})`,
            );
          }

          // Use Fluent UI compatible click method
          await this.fluentUIClick(dayButton, "DAY_CLICK");
          await this.humanDelay(1500, 2500);

          // Verify dropdown opened with multiple checks
          const dayOptionsContainer = this.page
            .locator('div[role="listbox"], ul[role="listbox"], div.fui-Listbox')
            .first();
          const isOpen = await dayOptionsContainer
            .isVisible()
            .catch(() => false);

          const ariaExpanded = await dayButton
            .getAttribute("aria-expanded")
            .catch(() => "false");
          const buttonExpanded = ariaExpanded === "true";

          if (!isOpen && !buttonExpanded) {
            throw new Error("Day dropdown did not open");
          }

          return true;
        },
        "DAY_DROPDOWN_OPEN",
        3,
        1000,
        false, // Disable micro-gestures to avoid scroll interfering with dropdown
      );

      if (!dayClickSuccess) {
        log(
          false,
          "CREATOR",
          "Failed to open day dropdown after retries",
          "error",
        );
        return false;
      }

      log(false, "CREATOR", "✅ Day dropdown opened", "log", "green");

      // Select day from dropdown
      log(false, "CREATOR", `Selecting day: ${day}`, "log");
      // UPDATED: Fluent UI uses div[role="option"] with exact text matching
      const dayOption = this.page
        .locator(
          `div[role="option"]:text-is("${day}"), div[role="option"]:has-text("${day}"), li[role="option"]:has-text("${day}")`,
        )
        .first();
      await dayOption.waitFor({ timeout: 5000, state: "visible" });

      // Try fluentUIClick for option selection (may fallback to direct click)
      await this.fluentUIClick(dayOption, "DAY_OPTION");
      await this.humanDelay(1500, 2500); // INCREASED delay

      // CRITICAL: Wait for dropdown to FULLY close
      await this.waitForDropdownClosed("DAY_DROPDOWN", 8000);
      await this.humanDelay(2000, 3000); // Human-like pause between interactions

      // CRITICAL: Verify page is interactive (not animating)
      await this.waitForPageStable("AFTER_DAY_DROPDOWN", 5000);
      await this.humanDelay(800, 1500); // Brief reading pause

      return true;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error filling day dropdown: ${msg}`, "error");
      return false;
    }
  }

  /**
   * EXTRACTED: Fill month dropdown (reusable for both orders)
   */
  private async fillMonthDropdown(month: number): Promise<boolean> {
    try {
      // === MONTH DROPDOWN ===
      // STRATEGY: Prioritize stable attributes (ID, name, aria-label) over volatile atomic classes
      // Multiple fallbacks for Microsoft's frequent UI changes
      const monthButton = this.page
        .locator(
          'button#BirthMonthDropdown, button[name="BirthMonth"], button[aria-label*="Birth month"], button[aria-label*="month"][role="combobox"]',
        )
        .first();
      await monthButton.waitFor({ timeout: 10000, state: "visible" });

      // CRITICAL: Ensure button is visible and in viewport
      await monthButton
        .scrollIntoViewIfNeeded({ timeout: 3000 })
        .catch(() => {});
      await this.humanDelay(500, 1000);

      // CRITICAL: Wait for any animations or JavaScript to complete
      await this.page
        .waitForLoadState("networkidle", { timeout: 5000 })
        .catch(() => {});
      await this.humanDelay(800, 1500);

      // CRITICAL: Verify button is actually clickable (not disabled, not covered)
      const monthEnabled = await monthButton.isEnabled().catch(() => false);
      if (!monthEnabled) {
        log(
          false,
          "CREATOR",
          "⚠️ Month button disabled, waiting for page to update...",
          "warn",
          "yellow",
        );
        await this.humanDelay(2000, 3000);

        // Re-check after waiting
        const retryEnabled = await monthButton.isEnabled().catch(() => false);
        if (!retryEnabled) {
          log(
            false,
            "CREATOR",
            "❌ Month button still disabled after wait",
            "error",
          );
          return false;
        }
      }

      log(false, "CREATOR", "Clicking month dropdown...", "log");

      // CRITICAL: Retry click with better diagnostics
      const monthClickSuccess = await this.retryOperation(
        async () => {
          // Verify button is still visible and enabled before each attempt
          const visible = await monthButton.isVisible().catch(() => false);
          const enabled = await monthButton.isEnabled().catch(() => false);

          if (!visible) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ❌ Button not visible",
              "warn",
              "yellow",
            );
            throw new Error("Month button not visible");
          }
          if (!enabled) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ❌ Button not enabled",
              "warn",
              "yellow",
            );
            throw new Error("Month button not enabled");
          }

          // Get button position and log it
          const box = await monthButton.boundingBox();
          if (!box) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ❌ Cannot get button position",
              "warn",
              "yellow",
            );
            throw new Error("Cannot get month button position");
          }

          log(
            false,
            "CREATOR",
            `[MONTH_CLICK] Button at (${Math.round(box.x)}, ${Math.round(box.y)})`,
            "log",
            "cyan",
          );

          // DIAGNOSTIC: Check if element is truly interactive
          const computedStyle = await monthButton
            .evaluate((el) => {
              const style = window.getComputedStyle(el);
              return {
                pointerEvents: style.pointerEvents,
                opacity: style.opacity,
                display: style.display,
                visibility: style.visibility,
              };
            })
            .catch(() => null);

          if (computedStyle) {
            log(
              false,
              "CREATOR",
              `[MONTH_CLICK] Style: ${JSON.stringify(computedStyle)}`,
              "log",
              "cyan",
            );
          }

          // Use Fluent UI compatible click method
          await this.fluentUIClick(monthButton, "MONTH_CLICK");
          await this.humanDelay(1500, 2500);

          // Verify dropdown opened with multiple detection strategies
          const monthOptionsContainer = this.page
            .locator('div[role="listbox"], ul[role="listbox"], div.fui-Listbox')
            .first();
          const isOpen = await monthOptionsContainer
            .isVisible()
            .catch(() => false);

          // Also check if button aria-expanded changed to true
          const ariaExpanded = await monthButton
            .getAttribute("aria-expanded")
            .catch(() => "false");
          const buttonExpanded = ariaExpanded === "true";

          if (!isOpen && !buttonExpanded) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ❌ Dropdown did not open (listbox not visible, aria-expanded=false)",
              "warn",
              "yellow",
            );
            throw new Error("Month dropdown did not open");
          }

          if (isOpen) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ✓ Dropdown opened (listbox visible)",
              "log",
              "green",
            );
          } else if (buttonExpanded) {
            log(
              false,
              "CREATOR",
              "[MONTH_CLICK] ✓ Dropdown opened (aria-expanded=true)",
              "log",
              "green",
            );
          }

          return true;
        },
        "MONTH_DROPDOWN_OPEN",
        3,
        1200,
        false, // CRITICAL: Disable micro-gestures (scroll would lose button position)
      );

      if (!monthClickSuccess) {
        log(
          false,
          "CREATOR",
          "Failed to open month dropdown after retries",
          "error",
        );
        return false;
      }

      log(false, "CREATOR", "✅ Month dropdown opened", "log", "green");

      // Select month by data-value attribute or by position
      log(false, "CREATOR", `Selecting month: ${month}`, "log");
      // UPDATED: Try multiple strategies for Fluent UI month selection
      const monthOption = this.page
        .locator(
          `div[role="option"][data-value="${month}"], div[role="option"]:nth-child(${month}), li[role="option"][data-value="${month}"]`,
        )
        .first();

      // Fallback: if data-value doesn't work, try by index
      const monthVisible = await monthOption.isVisible().catch(() => false);
      if (monthVisible) {
        await this.fluentUIClick(monthOption, "MONTH_OPTION");
        log(false, "CREATOR", "✅ Month selected", "log", "green");
      } else {
        log(
          false,
          "CREATOR",
          `Fallback: selecting month by nth-child(${month})`,
          "warn",
          "yellow",
        );
        const monthOptionByIndex = this.page
          .locator(
            `div[role="option"]:nth-child(${month}), li[role="option"]:nth-child(${month})`,
          )
          .first();
        await this.fluentUIClick(monthOptionByIndex, "MONTH_OPTION_INDEX");
      }
      await this.humanDelay(1500, 2500); // INCREASED delay

      // CRITICAL: Wait for dropdown to FULLY close
      await this.waitForDropdownClosed("MONTH_DROPDOWN", 8000);
      await this.humanDelay(2000, 3000); // INCREASED safety delay

      // CRITICAL: Verify page is interactive (not animating) - CONSISTENCY with day dropdown
      await this.waitForPageStable("AFTER_MONTH_DROPDOWN", 5000);
      await this.humanDelay(1500, 2500); // Additional reading pause

      return true;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error filling month dropdown: ${msg}`, "error");
      return false;
    }
  }

  /**
   * EXTRACTED: Fill year input (always last)
   */
  private async fillYearInput(year: number): Promise<boolean> {
    try {
      // === YEAR INPUT ===
      // STRATEGY: Prioritize stable attributes (name, type, aria-label) over volatile atomic classes
      // Multiple fallbacks for Microsoft's frequent UI changes
      const yearInput = this.page
        .locator(
          'input[name="BirthYear"], input[type="number"][aria-label*="Birth year"], input[aria-label*="year"][inputmode="numeric"]',
        )
        .first();
      await yearInput.waitFor({ timeout: 10000, state: "visible" });

      log(false, "CREATOR", `Filling year: ${year}`, "log");

      // CRITICAL: Retry fill with verification
      const yearFillSuccess = await this.retryOperation(
        async () => {
          // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
          await this.human.humanType(yearInput, year.toString(), "YEAR_INPUT");

          // Verify value was filled correctly
          const verified = await this.verifyInputValue(
            'input[name="BirthYear"], input[type="number"][aria-label*="Birth year"], input[aria-label*="year"][inputmode="numeric"]',
            year.toString(),
          );

          if (!verified) {
            throw new Error("Year input value not verified");
          }

          return true;
        },
        "YEAR_FILL",
        3,
        1000,
      );

      if (!yearFillSuccess) {
        log(false, "CREATOR", "Failed to fill year after retries", "error");
        return false;
      }

      return true;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error filling year input: ${msg}`, "error");
      return false;
    }
  }

  private async fillNames(
    email: string,
  ): Promise<{ firstName: string; lastName: string } | null> {
    log(false, "CREATOR", "👤 Filling name...", "log", "cyan");

    await this.waitForPageStable("NAMES_PAGE", 8000);

    const names = this.dataGenerator.generateNames(email);

    try {
      // CRITICAL: Uncheck marketing opt-in BEFORE filling names (checkbox is default checked in US locale)
      await this.uncheckMarketingOptIn();

      await this.humanDelay(1000, 2000);

      const firstNameSelectors = [
        'input[id*="firstName"]',
        'input[name*="firstName"]',
        'input[id*="first"]',
        'input[name*="first"]',
        'input[aria-label*="First"]',
        'input[placeholder*="First"]',
      ];

      let firstNameInput = null;
      for (const selector of firstNameSelectors) {
        const input = this.page.locator(selector).first();
        const visible = await input.isVisible().catch(() => false);
        if (visible) {
          firstNameInput = input;
          break;
        }
      }

      if (!firstNameInput) {
        log(false, "CREATOR", "Could not find first name input", "error");
        return null;
      }

      // CRITICAL: Retry fill with verification
      const firstNameFillSuccess = await this.retryOperation(
        async () => {
          // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
          await this.human.humanType(
            firstNameInput,
            names.firstName,
            "FIRSTNAME_INPUT",
          );

          return true;
        },
        "FIRSTNAME_FILL",
        3,
        1000,
      );

      if (!firstNameFillSuccess) {
        log(
          false,
          "CREATOR",
          "Failed to fill first name after retries",
          "error",
        );
        return null;
      }

      // Fill last name with multiple selector fallbacks
      const lastNameSelectors = [
        'input[id*="lastName"]',
        'input[name*="lastName"]',
        'input[id*="last"]',
        'input[name*="last"]',
        'input[aria-label*="Last"]',
        'input[placeholder*="Last"]',
      ];

      let lastNameInput = null;
      for (const selector of lastNameSelectors) {
        const input = this.page.locator(selector).first();
        const visible = await input.isVisible().catch(() => false);
        if (visible) {
          lastNameInput = input;
          break;
        }
      }

      if (!lastNameInput) {
        log(false, "CREATOR", "Could not find last name input", "error");
        return null;
      }

      // CRITICAL: Retry fill with verification
      const lastNameFillSuccess = await this.retryOperation(
        async () => {
          // CRITICAL FIX: Use humanType() instead of .fill() to avoid detection
          await this.human.humanType(
            lastNameInput,
            names.lastName,
            "LASTNAME_INPUT",
          );

          return true;
        },
        "LASTNAME_FILL",
        3,
        1000,
      );

      if (!lastNameFillSuccess) {
        log(
          false,
          "CREATOR",
          "Failed to fill last name after retries",
          "error",
        );
        return null;
      }

      log(
        false,
        "CREATOR",
        `✅ Names filled: ${names.firstName} ${names.lastName}`,
        "log",
        "green",
      );

      // CRITICAL: Verify no errors appeared after filling names
      const noErrors = await this.verifyNoErrors();
      if (!noErrors) {
        log(
          false,
          "CREATOR",
          "❌ Errors detected after filling names",
          "error",
        );
        log(
          false,
          "CREATOR",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "error",
        );
        log(
          false,
          "CREATOR",
          "📊 Most likely causes at this step:",
          "log",
          "yellow",
        );
        log(
          false,
          "CREATOR",
          "   1️⃣  Rate limit (Microsoft detected unusual activity)",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   2️⃣  Microsoft servers temporarily unavailable",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "   3️⃣  Name validation failed (special characters?)",
          "log",
          "cyan",
        );
        log(
          false,
          "CREATOR",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "error",
        );
        log(
          false,
          "CREATOR",
          "⚠️  Check browser window for exact error message",
          "warn",
          "yellow",
        );
        log(
          false,
          "CREATOR",
          "⚠️  Browser left open for inspection. Press Ctrl+C to exit.",
          "warn",
          "yellow",
        );
        // Keep browser open for user to see the error
        await new Promise(() => {});
        return null;
      }

      // CRITICAL: Verify Next button is enabled (indicates form is valid)
      await this.humanDelay(1000, 2000);
      const nextBtn = this.page
        .locator('button[data-testid="primaryButton"], button[type="submit"]')
        .first();
      const nextEnabled = await nextBtn.isEnabled().catch(() => false);

      if (!nextEnabled) {
        log(
          false,
          "CREATOR",
          "⚠️ Next button not enabled after filling names",
          "warn",
          "yellow",
        );
        log(false, "CREATOR", "Waiting for form validation...", "log", "cyan");
        await this.humanDelay(3000, 5000);

        const retryEnabled = await nextBtn.isEnabled().catch(() => false);
        if (!retryEnabled) {
          log(
            false,
            "CREATOR",
            "❌ Next button still disabled - form may be invalid",
            "error",
          );
          return null;
        }
      }

      log(
        false,
        "CREATOR",
        "✅ Names form validated successfully",
        "log",
        "green",
      );

      return names;
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `Error filling names: ${msg}`, "error");
      return null;
    }
  }

  /**
   * CRITICAL: Check if checkbox is checked (Fluent UI compatible)
   * Uses 3 methods because Playwright's isChecked() doesn't work with Fluent UI
   */
  private async isCheckboxChecked(
    checkbox: import("rebrowser-playwright").Locator,
  ): Promise<boolean> {
    // Method 1: Standard Playwright isChecked()
    const playwrightCheck = await checkbox.isChecked().catch(() => false);
    if (playwrightCheck) return true;

    // Method 2: Check for SVG checkmark in indicator div (Fluent UI visual indicator)
    try {
      const indicator = this.page
        .locator("div.fui-Checkbox__indicator svg")
        .first();
      const svgVisible = await indicator
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (svgVisible) return true;
    } catch {
      // Continue
    }

    // Method 3: JavaScript evaluation (most reliable)
    try {
      const jsChecked = await checkbox.evaluate(
        (el: HTMLInputElement) => el.checked,
      );
      if (jsChecked) return true;
    } catch {
      // Continue
    }

    return false;
  }

  private async uncheckMarketingOptIn(): Promise<void> {
    try {
      log(
        false,
        "CREATOR",
        "Checking for marketing opt-in checkbox...",
        "log",
        "cyan",
      );

      // IMPROVED: Wait for checkbox to be present before checking
      await this.humanDelay(500, 1000);

      // Multiple selectors for the marketing checkbox (order matters: most specific first)
      const checkboxSelectors = [
        "input#marketingOptIn",
        'input[data-testid="marketingOptIn"]',
        'input[name="marketingOptIn"]',
        'input[type="checkbox"][aria-label*="information"]',
        'input[type="checkbox"][aria-label*="conseils"]', // French locale
        'input[type="checkbox"][aria-label*="offers"]',
      ];

      let checkbox = null;

      for (const selector of checkboxSelectors) {
        try {
          const element = this.page.locator(selector).first();
          // CRITICAL: Check if visible AND enabled (not disabled)
          const visible = await element
            .isVisible({ timeout: 2000 })
            .catch(() => false);
          const enabled = await element.isEnabled().catch(() => false);

          if (visible && enabled) {
            checkbox = element;
            log(
              false,
              "CREATOR",
              `Found marketing checkbox: ${selector}`,
              "log",
              "cyan",
            );
            break;
          }
        } catch {
          continue;
        }
      }

      if (!checkbox) {
        log(
          false,
          "CREATOR",
          "No marketing checkbox found (may not exist on this page)",
          "log",
          "gray",
        );
        return;
      }

      // CRITICAL: Wait for checkbox state to stabilize (US locale defaults to checked)
      await this.humanDelay(300, 600);

      // IMPROVED: Use Fluent UI compatible checker
      const isChecked = await this.isCheckboxChecked(checkbox);
      log(
        false,
        "CREATOR",
        `Checkbox state detected: ${isChecked ? "CHECKED" : "UNCHECKED"}`,
        "log",
        "cyan",
      );

      if (isChecked) {
        log(
          false,
          "CREATOR",
          "⚠️ Marketing checkbox is CHECKED (US locale default) - unchecking now...",
          "log",
          "yellow",
        );

        // IMPROVED: Try multiple click strategies for Fluent UI checkboxes
        let unchecked = false;

        // Strategy 1: Normal Playwright click (HUMAN-LIKE: no force)
        try {
          // IMPROVED: Random micro-gesture before click
          await this.human.microGestures("CHECKBOX_PRE_CLICK");
          await this.humanDelay(300, 700);

          await checkbox.click({ force: false });
          await this.humanDelay(500, 1200); // IMPROVED: Variable delay
          const stillChecked1 = await this.isCheckboxChecked(checkbox);
          if (!stillChecked1) {
            unchecked = true;
            log(
              false,
              "CREATOR",
              "✅ Unchecked via normal click",
              "log",
              "green",
            );
          }
        } catch {
          // Continue to next strategy
        }

        // Strategy 2: REMOVED FORCE CLICK (detectable as bot behavior)
        // Strategy 2 is now Label click (Fluent UI native pattern)

        // Strategy 3: Click the label instead (Fluent UI pattern)
        if (!unchecked) {
          try {
            const label = this.page
              .locator('label[for="marketingOptIn"]')
              .first();
            const labelVisible = await label
              .isVisible({ timeout: 1000 })
              .catch(() => false);
            if (labelVisible) {
              await label.click();
              await this.humanDelay(500, 800);
              const stillChecked3 = await this.isCheckboxChecked(checkbox);
              if (!stillChecked3) {
                unchecked = true;
                log(
                  false,
                  "CREATOR",
                  "✅ Unchecked via label click",
                  "log",
                  "green",
                );
              }
            }
          } catch {
            // Continue to next strategy
          }
        }

        // Strategy 4: JavaScript click (most reliable for stubborn checkboxes)
        if (!unchecked) {
          try {
            await checkbox.evaluate((el: HTMLInputElement) => el.click());
            await this.humanDelay(500, 800);
            const stillChecked4 = await this.isCheckboxChecked(checkbox);
            if (!stillChecked4) {
              unchecked = true;
              log(
                false,
                "CREATOR",
                "✅ Unchecked via JavaScript click",
                "log",
                "green",
              );
            }
          } catch {
            // Continue
          }
        }

        if (!unchecked) {
          log(
            false,
            "CREATOR",
            "❌ Could not uncheck marketing opt-in after all strategies",
            "error",
          );
          log(
            false,
            "CREATOR",
            "⚠️  Account will receive Microsoft promotional emails",
            "warn",
            "yellow",
          );
        }
      } else {
        log(
          false,
          "CREATOR",
          "✅ Marketing opt-in already unchecked (good!)",
          "log",
          "green",
        );
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      log(
        false,
        "CREATOR",
        `Marketing opt-in handling error: ${msg}`,
        "warn",
        "yellow",
      );
      // Don't fail the whole process for this
    }
  }

  private async waitForCaptcha(): Promise<boolean> {
    try {
      log(false, "CREATOR", "🔍 Checking for CAPTCHA...", "log", "cyan");
      await this.humanDelay(1500, 2500);

      // Check for CAPTCHA iframe (most reliable)
      const captchaIframe = this.page
        .locator('iframe[data-testid="humanCaptchaIframe"]')
        .first();
      const iframeVisible = await captchaIframe.isVisible().catch(() => false);

      if (iframeVisible) {
        log(
          false,
          "CREATOR",
          "🤖 CAPTCHA DETECTED via iframe - WAITING FOR HUMAN",
          "warn",
          "yellow",
        );
        return true;
      }

      // Check multiple CAPTCHA indicators
      const captchaIndicators = [
        'h1[data-testid="title"]',
        'div[id*="captcha"]',
        'div[class*="captcha"]',
        'div[id*="enforcement"]',
        'img[data-testid="accessibleImg"]',
      ];

      for (const selector of captchaIndicators) {
        const element = this.page.locator(selector).first();
        const visible = await element.isVisible().catch(() => false);

        if (visible) {
          const text = await element.textContent().catch(() => "");
          log(
            false,
            "CREATOR",
            `Found element: ${selector} = "${text?.substring(0, 50)}"`,
            "log",
            "gray",
          );

          if (
            text &&
            (text.toLowerCase().includes("vérif") ||
              text.toLowerCase().includes("verify") ||
              text.toLowerCase().includes("human") ||
              text.toLowerCase().includes("humain") ||
              text.toLowerCase().includes("puzzle") ||
              text.toLowerCase().includes("captcha") ||
              text.toLowerCase().includes("prove you"))
          ) {
            log(
              false,
              "CREATOR",
              `🤖 CAPTCHA DETECTED: "${text.substring(0, 50)}" - WAITING FOR HUMAN`,
              "warn",
              "yellow",
            );
            return true;
          }
        }
      }

      log(false, "CREATOR", "✅ No CAPTCHA detected", "log", "green");
      return false;
    } catch (error) {
      log(
        false,
        "CREATOR",
        `Error checking CAPTCHA: ${error}`,
        "warn",
        "yellow",
      );
      return false;
    }
  }

  private async waitForCaptchaSolved(): Promise<void> {
    const maxWaitTime = 10 * 60 * 1000;
    const startTime = Date.now();
    let lastLogTime = startTime;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        if (Date.now() - lastLogTime > 30000) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          log(
            false,
            "CREATOR",
            `⏳ Still waiting for CAPTCHA solution... (${elapsed}s)`,
            "log",
            "yellow",
          );
          lastLogTime = Date.now();
        }

        const captchaStillPresent = await this.waitForCaptcha();

        if (!captchaStillPresent) {
          log(
            false,
            "CREATOR",
            "✅ CAPTCHA SOLVED! Processing account creation...",
            "log",
            "green",
          );

          await this.humanDelay(3000, 5000);
          await this.waitForAccountCreation();
          await this.humanDelay(2000, 3000);

          return;
        }

        await this.page.waitForTimeout(2000);
      } catch (error) {
        log(
          false,
          "CREATOR",
          `Error in CAPTCHA wait: ${error}`,
          "warn",
          "yellow",
        );
        return;
      }
    }

    throw new Error("CAPTCHA timeout - 10 minutes exceeded");
  }

  private async handlePostCreationQuestions(): Promise<void> {
    log(false, "CREATOR", "Handling post-creation questions...", "log", "cyan");

    // Wait for page to stabilize (REDUCED - pages load fast)
    await this.waitForPageStable("POST_CREATION", 15000);
    await this.humanDelay(3000, 5000);

    // CRITICAL: Handle passkey prompt - MUST REFUSE
    await this.handlePasskeyPrompt();

    // Brief delay between prompts
    await this.humanDelay(2000, 3000);

    // Handle "Stay signed in?" (KMSI) prompt
    const kmsiSelectors = [
      '[data-testid="kmsiVideo"]',
      'div:has-text("Stay signed in?")',
      'div:has-text("Rester connecté")',
      'button[data-testid="primaryButton"]',
    ];

    for (let i = 0; i < 3; i++) {
      let found = false;

      for (const selector of kmsiSelectors) {
        const element = this.page.locator(selector).first();
        const visible = await element.isVisible().catch(() => false);

        if (visible) {
          log(
            false,
            "CREATOR",
            "Stay signed in prompt detected",
            "log",
            "yellow",
          );

          // Click "Yes" button
          const yesButton = this.page
            .locator('button[data-testid="primaryButton"]')
            .first();
          const yesVisible = await yesButton.isVisible().catch(() => false);

          if (yesVisible) {
            await yesButton.click();
            await this.humanDelay(2000, 3000);
            await this.waitForPageStable("AFTER_KMSI", 15000);
            log(
              false,
              "CREATOR",
              '✅ Accepted "Stay signed in"',
              "log",
              "green",
            );
            found = true;
            break;
          }
        }
      }

      if (!found) break;
      await this.humanDelay(1000, 2000);
    }

    // Handle any other prompts (biometric, etc.)
    const genericPrompts = [
      '[data-testid="biometricVideo"]',
      'button[id*="close"]',
      'button[aria-label*="Close"]',
    ];

    for (const selector of genericPrompts) {
      const element = this.page.locator(selector).first();
      const visible = await element.isVisible().catch(() => false);

      if (visible) {
        log(false, "CREATOR", `Closing prompt: ${selector}`, "log", "yellow");

        // Try to close it
        const closeButton = this.page
          .locator('button[data-testid="secondaryButton"], button[id*="close"]')
          .first();
        const closeVisible = await closeButton.isVisible().catch(() => false);

        if (closeVisible) {
          await closeButton.click();
          await this.humanDelay(1500, 2500);
          log(false, "CREATOR", "✅ Closed prompt", "log", "green");
        }
      }
    }

    log(false, "CREATOR", "✅ Post-creation questions handled", "log", "green");
  }

  private async handlePasskeyPrompt(): Promise<void> {
    log(
      false,
      "CREATOR",
      "Checking for passkey setup prompt...",
      "log",
      "cyan",
    );

    // Wait for passkey prompt to appear (REDUCED)
    await this.humanDelay(3000, 5000);

    // Ensure page is stable before checking
    await this.waitForPageStable("PASSKEY_CHECK", 15000);

    // Multiple selectors for passkey prompt detection
    const passkeyDetectionSelectors = [
      'div:has-text("passkey")',
      'div:has-text("clé d\'accès")',
      'div:has-text("Set up a passkey")',
      'div:has-text("Configurer une clé")',
      '[data-testid*="passkey"]',
      'button:has-text("Skip")',
      'button:has-text("Not now")',
      'button:has-text("Ignorer")',
      'button:has-text("Plus tard")',
    ];

    let passkeyPromptFound = false;

    for (const selector of passkeyDetectionSelectors) {
      const element = this.page.locator(selector).first();
      const visible = await element.isVisible().catch(() => false);

      if (visible) {
        passkeyPromptFound = true;
        log(
          false,
          "CREATOR",
          "⚠️  Passkey setup prompt detected - REFUSING",
          "warn",
          "yellow",
        );
        break;
      }
    }

    if (!passkeyPromptFound) {
      log(false, "CREATOR", "No passkey prompt detected", "log", "green");
      return;
    }

    // Try to click refuse/skip buttons
    const refuseButtonSelectors = [
      'button:has-text("Skip")',
      'button:has-text("Not now")',
      'button:has-text("No")',
      'button:has-text("Cancel")',
      'button:has-text("Ignorer")',
      'button:has-text("Plus tard")',
      'button:has-text("Non")',
      'button:has-text("Annuler")',
      'button[data-testid="secondaryButton"]',
      'button[id*="cancel"]',
      'button[id*="skip"]',
    ];

    for (const selector of refuseButtonSelectors) {
      const button = this.page.locator(selector).first();
      const visible = await button.isVisible().catch(() => false);

      if (visible) {
        log(
          false,
          "CREATOR",
          `Clicking refuse button: ${selector}`,
          "log",
          "cyan",
        );
        await button.click();
        await this.humanDelay(2000, 3000);
        log(false, "CREATOR", "✅ Passkey setup REFUSED", "log", "green");
        return;
      }
    }

    log(
      false,
      "CREATOR",
      "⚠️  Could not find refuse button for passkey prompt",
      "warn",
      "yellow",
    );
  }

  private async verifyAccountActive(): Promise<void> {
    log(false, "CREATOR", "Verifying account is active...", "log", "cyan");

    // Ensure page is stable before navigating (REDUCED)
    await this.waitForPageStable("PRE_VERIFICATION", 10000);
    await this.humanDelay(3000, 5000);

    // Navigate to Bing Rewards
    try {
      log(false, "CREATOR", "Navigating to rewards.bing.com...", "log", "cyan");

      await this.page.goto(`${URLS.REWARDS_BASE}/`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await this.waitForPageStable("REWARDS_PAGE", 7000);
      await this.humanDelay(2000, 3000);

      log(false, "CREATOR", "✅ On rewards.bing.com", "log", "green");

      // CRITICAL: Dismiss cookies IMMEDIATELY (they block Get started popup)
      await this.humanDelay(1000, 1500);
      await this.dismissCookieBanner();

      // THEN handle "Get started" popup (after cookies cleared)
      await this.humanDelay(2000, 3000);
      await this.handleGetStartedPopup();

      // Referral enrollment if needed
      if (this.referralUrl) {
        await this.humanDelay(2000, 3000);
        await this.ensureRewardsEnrollment();
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      log(
        false,
        "CREATOR",
        `Warning: Could not verify account: ${msg}`,
        "warn",
        "yellow",
      );
    }
  }

  private async dismissCookieBanner(): Promise<void> {
    try {
      log(false, "CREATOR", "🍪 Checking for cookie banner...", "log", "cyan");

      const rejectButtonSelectors = [
        "button#bnp_btn_reject",
        'button[id*="reject"]',
        'button:has-text("Reject")',
        'button:has-text("Refuser")',
        'a:has-text("Reject")',
        'a:has-text("Refuser")',
      ];

      for (const selector of rejectButtonSelectors) {
        const button = this.page.locator(selector).first();
        const visible = await button
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        if (visible) {
          log(false, "CREATOR", "✅ Rejecting cookies", "log", "green");
          await button.click();
          await this.humanDelay(1000, 1500);
          return;
        }
      }

      log(false, "CREATOR", "No cookie banner found", "log", "gray");
    } catch (error) {
      log(false, "CREATOR", `Cookie banner error: ${error}`, "log", "gray");
    }
  }

  private async handleGetStartedPopup(): Promise<void> {
    try {
      log(
        false,
        "CREATOR",
        '🎯 Checking for "Get started" popup...',
        "log",
        "cyan",
      );
      await this.humanDelay(2000, 3000);

      // Check for ReferAndEarn popup
      const popupIndicator = this.page
        .locator('img[src*="ReferAndEarnPopUpImgUpdated"]')
        .first();
      const popupVisible = await popupIndicator
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (!popupVisible) {
        log(false, "CREATOR", 'No "Get started" popup found', "log", "gray");
        return;
      }

      log(false, "CREATOR", '✅ Found "Get started" popup', "log", "green");
      await this.humanDelay(1000, 2000);

      // IMPROVED: Try multiple strategies to click (cookie banner may block)
      const getStartedButton = this.page
        .locator("a#reward_pivot_earn, a.dashboardPopUpPopUpSelectButton")
        .first();
      const buttonVisible = await getStartedButton
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (!buttonVisible) {
        log(false, "CREATOR", "Get started button not visible", "log", "gray");
        return;
      }

      let clickSuccess = false;

      // Strategy 1: Normal click
      try {
        log(
          false,
          "CREATOR",
          '🎯 Clicking "Get started" (normal click)',
          "log",
          "cyan",
        );
        await getStartedButton.click({ timeout: 10000 });
        await this.humanDelay(2000, 3000);
        await this.waitForPageStable("AFTER_GET_STARTED", 5000);
        clickSuccess = true;
        log(
          false,
          "CREATOR",
          '✅ Clicked "Get started" successfully',
          "log",
          "green",
        );
      } catch (error1) {
        log(
          false,
          "CREATOR",
          `Normal click failed: ${error1}`,
          "log",
          "yellow",
        );
      }

      // Strategy 2: JavaScript click (avoid force: true - bot detection risk)
      if (!clickSuccess) {
        try {
          log(
            false,
            "CREATOR",
            "🔄 Retrying with JavaScript click...",
            "log",
            "cyan",
          );
          await getStartedButton.evaluate((el: HTMLElement) => el.click());
          await this.humanDelay(2000, 3000);
          await this.waitForPageStable("AFTER_GET_STARTED_RETRY", 5000);
          clickSuccess = true;
          log(
            false,
            "CREATOR",
            '✅ Clicked "Get started" with JS',
            "log",
            "green",
          );
        } catch (error2) {
          log(false, "CREATOR", `JS click failed: ${error2}`, "log", "yellow");
        }
      }

      // Strategy 3: JavaScript click (last resort)
      if (!clickSuccess) {
        try {
          log(
            false,
            "CREATOR",
            "🔄 Retrying with JavaScript click...",
            "log",
            "cyan",
          );
          await getStartedButton.evaluate((el: HTMLElement) => el.click());
          await this.humanDelay(2000, 3000);
          await this.waitForPageStable("AFTER_GET_STARTED_JS", 5000);
          clickSuccess = true;
          log(
            false,
            "CREATOR",
            '✅ Clicked "Get started" with JavaScript',
            "log",
            "green",
          );
        } catch (error3) {
          log(
            false,
            "CREATOR",
            `JavaScript click failed: ${error3}`,
            "log",
            "yellow",
          );
        }
      }

      if (!clickSuccess) {
        log(
          false,
          "CREATOR",
          '⚠️ Could not click "Get started" after 3 attempts',
          "warn",
          "yellow",
        );
      }
    } catch (error) {
      log(false, "CREATOR", `Get started popup error: ${error}`, "log", "gray");
    }
  }

  // Unused - kept for future use if needed
  /*
  private async handleRewardsWelcomeTour(): Promise<void> {
    await this.waitForPageStable('WELCOME_TOUR', 7000)
    await this.humanDelay(2000, 3000)
    
    const maxClicks = 5
    for (let i = 0; i < maxClicks; i++) {
      // Check for welcome tour indicators
      const welcomeIndicators = [
        'img[src*="Get%20cool%20prizes"]',
        'img[alt*="Welcome to Microsoft Rewards"]',
        'div.welcome-tour',
        'a#fre-next-button',
        'a.welcome-tour-button.next-button',
        'a.next-button.c-call-to-action'
      ]
      
      let tourFound = false
      for (const selector of welcomeIndicators) {
        const element = this.page.locator(selector).first()
        const visible = await element.isVisible().catch(() => false)
        
        if (visible) {
          tourFound = true
          log(false, 'CREATOR', `Welcome tour detected (step ${i + 1})`, 'log', 'yellow')
          break
        }
      }
      
      if (!tourFound) {
        log(false, 'CREATOR', 'No more welcome tour steps', 'log', 'green')
        break
      }
      
      // Try to click Next button
      const nextButtonSelectors = [
        'a#fre-next-button',
        'a.welcome-tour-button.next-button',
        'a.next-button.c-call-to-action',
        'button:has-text("Next")',
        'a:has-text("Next")',
        'button:has-text("Suivant")',
        'a:has-text("Suivant")'
      ]
      
      let clickedNext = false
      for (const selector of nextButtonSelectors) {
        const button = this.page.locator(selector).first()
        const visible = await button.isVisible().catch(() => false)
        
        if (visible) {
          await button.click()
          await this.humanDelay(1500, 2500)
          await this.waitForPageStable('AFTER_TOUR_NEXT', 8000)
          
          clickedNext = true
          break
        }
      }
      
      if (!clickedNext) {
        const pinButtonSelectors = [
          'a#claim-button',
          'a:has-text("Pin and start earning")',
          'a:has-text("Épingler et commencer")',
          'a.welcome-tour-button[href*="pin=true"]'
        ]
        
        for (const selector of pinButtonSelectors) {
          const button = this.page.locator(selector).first()
          const visible = await button.isVisible().catch(() => false)
          
          if (visible) {
            await button.click()
            await this.humanDelay(1500, 2500)
            await this.waitForPageStable('AFTER_PIN', 8000)
            break
          }
        }
        
        break
      }
      
      await this.humanDelay(1000, 1500)
    }
  }
  */

  /*
  private async handleRewardsPopups(): Promise<void> {
    await this.waitForPageStable('REWARDS_POPUPS', 10000)
    await this.humanDelay(2000, 3000)
    
    // Handle ReferAndEarn popup
    const referralPopupSelectors = [
      'img[src*="ReferAndEarnPopUpImgUpdated"]',
      'div.dashboardPopUp',
      'a.dashboardPopUpPopUpSelectButton',
      'a#reward_pivot_earn'
    ]
    
    let referralPopupFound = false
    for (const selector of referralPopupSelectors) {
      const element = this.page.locator(selector).first()
      const visible = await element.isVisible().catch(() => false)
      
      if (visible) {
        referralPopupFound = true
        log(false, 'CREATOR', 'Referral popup detected', 'log', 'yellow')
        break
      }
    }
    
    if (referralPopupFound) {
      // CRITICAL: Wait longer before clicking to ensure popup is fully loaded
      log(false, 'CREATOR', 'Referral popup found, waiting for it to stabilize (3-5s)...', 'log', 'cyan')
      await this.humanDelay(3000, 5000) // INCREASED from 2-3s
      
      // Click "Get started" button
      const getStartedSelectors = [
        'a.dashboardPopUpPopUpSelectButton',
        'a#reward_pivot_earn',
        'a:has-text("Get started")',
        'a:has-text("Commencer")',
        'button:has-text("Get started")',
        'button:has-text("Commencer")'
      ]
      
      for (const selector of getStartedSelectors) {
        const button = this.page.locator(selector).first()
        const visible = await button.isVisible().catch(() => false)
        
        if (visible) {
          await button.click()
          await this.humanDelay(1500, 2500)
          await this.waitForPageStable('AFTER_GET_STARTED', 8000)
          break
        }
      }
    }
    
    const genericCloseSelectors = [
      'button[aria-label*="Close"]',
      'button[aria-label*="Fermer"]',
      'button.close',
      'a.close'
    ]
    
    for (const selector of genericCloseSelectors) {
      const button = this.page.locator(selector).first()
      const visible = await button.isVisible().catch(() => false)
      
      if (visible) {
        await button.click()
        await this.humanDelay(1000, 1500)
        await this.waitForPageStable('AFTER_CLOSE_POPUP', 5000)
      }
    }
  }
  */

  private async ensureRewardsEnrollment(): Promise<void> {
    if (!this.referralUrl) return;

    try {
      log(
        false,
        "CREATOR",
        "🔗 Reloading referral URL for enrollment...",
        "log",
        "cyan",
      );

      await this.page.goto(this.referralUrl, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await this.waitForPageStable("REFERRAL_ENROLLMENT", 7000);
      await this.humanDelay(2000, 3000);

      // IMPROVED: Try to click "Join Microsoft Rewards" with retry
      let joinSuccess = false;
      let joinVisible = false;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const joinButton = this.page
          .locator("a#start-earning-rewards-link")
          .first();
        joinVisible = await joinButton
          .isVisible({ timeout: 3000 })
          .catch(() => false);

        if (!joinVisible) {
          if (attempt === 1) {
            log(
              false,
              "CREATOR",
              "✅ Already enrolled or Join button not found",
              "log",
              "gray",
            );
          }
          break;
        }

        try {
          log(
            false,
            "CREATOR",
            `🎯 Clicking "Join Microsoft Rewards" (attempt ${attempt}/${maxRetries})`,
            "log",
            "cyan",
          );
          await joinButton.click({ timeout: 10000 });
          await this.humanDelay(2000, 3000);
          await this.waitForPageStable("AFTER_JOIN", 7000);
          log(
            false,
            "CREATOR",
            "✅ Successfully clicked Join button",
            "log",
            "green",
          );

          // CRITICAL: Verify referral was successful by checking for &new=1 in URL
          const currentUrl = this.page.url();
          if (currentUrl.includes("&new=1") || currentUrl.includes("?new=1")) {
            log(
              false,
              "CREATOR",
              "✅ Referral successful! URL contains &new=1",
              "log",
              "green",
            );
            joinSuccess = true;
            break;
          } else {
            log(
              false,
              "CREATOR",
              "⚠️ Warning: URL does not contain &new=1 - referral may not have worked",
              "warn",
              "yellow",
            );
            log(false, "CREATOR", `Current URL: ${currentUrl}`, "log", "cyan");

            // If no &new=1 and not last attempt, retry
            if (attempt < maxRetries) {
              log(
                false,
                "CREATOR",
                "🔄 Retrying join (no &new=1 detected)...",
                "log",
                "cyan",
              );
              await this.humanDelay(2000, 3000);
              // Reload referral URL for retry
              await this.page.goto(this.referralUrl, {
                waitUntil: "networkidle",
                timeout: 30000,
              });
              await this.waitForPageStable("REFERRAL_RETRY", 5000);
              await this.humanDelay(1000, 2000);
            } else {
              log(
                false,
                "CREATOR",
                "❌ Referral failed after 3 attempts (no &new=1)",
                "error",
              );
            }
          }
        } catch (error) {
          log(
            false,
            "CREATOR",
            `Join button click failed (attempt ${attempt}): ${error}`,
            "warn",
            "yellow",
          );
          if (attempt < maxRetries) {
            log(false, "CREATOR", "🔄 Retrying...", "log", "cyan");
            await this.humanDelay(2000, 3000);
            // Reload referral URL for retry
            await this.page.goto(this.referralUrl, {
              waitUntil: "networkidle",
              timeout: 30000,
            });
            await this.waitForPageStable("REFERRAL_RETRY", 5000);
            await this.humanDelay(1000, 2000);
          }
        }
      }

      if (!joinSuccess && joinVisible) {
        log(
          false,
          "CREATOR",
          "⚠️ Could not verify referral success",
          "warn",
          "yellow",
        );
      }

      log(false, "CREATOR", "✅ Enrollment process completed", "log", "green");
    } catch (error) {
      const msg = getErrorMessage(error);
      log(
        false,
        "CREATOR",
        `Warning: Could not complete enrollment: ${msg}`,
        "warn",
        "yellow",
      );
    }
  }

  private async saveAccount(account: CreatedAccount): Promise<void> {
    try {
      const accountsDir = path.join(process.cwd(), "accounts-created");

      // Ensure directory exists
      if (!fs.existsSync(accountsDir)) {
        log(
          false,
          "CREATOR",
          "Creating accounts-created directory...",
          "log",
          "cyan",
        );
        fs.mkdirSync(accountsDir, { recursive: true });
      }

      // Create a unique filename for THIS account using timestamp and email
      // Format: account_email_YYYY-MM-DD_HH-MM-SS.jsonc (clean and readable)
      const now = new Date();
      const timestamp = (now.toISOString().split(".")[0] || "")
        .replace(/:/g, "-")
        .replace("T", "_");
      const emailPrefix = (account.email.split("@")[0] || "account").substring(
        0,
        15,
      ); // Max 15 chars
      const filename = `account_${emailPrefix}_${timestamp}.jsonc`;
      const filepath = path.join(accountsDir, filename);

      log(
        false,
        "CREATOR",
        `Saving account to NEW file: ${filename}`,
        "log",
        "cyan",
      );

      // Create account data with metadata
      const accountData = {
        ...account,
        savedAt: new Date().toISOString(),
        filename: filename,
      };

      // Create output with comments
      const output = `// Microsoft Rewards - Account Created
// Email: ${account.email}
// Created: ${account.createdAt}
// Saved: ${accountData.savedAt}

${JSON.stringify(accountData, null, 2)}`;

      // Write to NEW file (never overwrites existing files)
      fs.writeFileSync(filepath, output, "utf-8");

      // Verify the file was written correctly
      if (fs.existsSync(filepath)) {
        const verifySize = fs.statSync(filepath).size;
        log(
          false,
          "CREATOR",
          `✅ File written successfully (${verifySize} bytes)`,
          "log",
          "green",
        );

        // Double-check we can read it back
        const verifyContent = fs.readFileSync(filepath, "utf-8");
        const verifyJsonStartIndex = verifyContent.indexOf("{");
        const verifyJsonEndIndex = verifyContent.lastIndexOf("}");

        if (verifyJsonStartIndex !== -1 && verifyJsonEndIndex !== -1) {
          const verifyJsonContent = verifyContent.substring(
            verifyJsonStartIndex,
            verifyJsonEndIndex + 1,
          );
          const verifyAccount = JSON.parse(verifyJsonContent);

          if (verifyAccount.email === account.email) {
            log(
              false,
              "CREATOR",
              `✅ Verification passed: Account ${account.email} saved correctly`,
              "log",
              "green",
            );
          } else {
            log(
              false,
              "CREATOR",
              "⚠️  Verification warning: Email mismatch",
              "warn",
              "yellow",
            );
          }
        }
      } else {
        log(
          false,
          "CREATOR",
          "❌ File verification failed - file does not exist!",
          "error",
        );
      }

      log(
        false,
        "CREATOR",
        `✅ Account saved successfully to: ${filepath}`,
        "log",
        "green",
      );
    } catch (error) {
      const msg = getErrorMessage(error);
      log(false, "CREATOR", `❌ Error saving account: ${msg}`, "error");

      // Try to save to a fallback file
      try {
        const fallbackPath = path.join(
          process.cwd(),
          `account-backup-${Date.now()}.jsonc`,
        );
        fs.writeFileSync(
          fallbackPath,
          JSON.stringify(account, null, 2),
          "utf-8",
        );
        log(
          false,
          "CREATOR",
          `⚠️  Account saved to fallback file: ${fallbackPath}`,
          "warn",
          "yellow",
        );
      } catch (fallbackError) {
        const fallbackMsg =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        log(
          false,
          "CREATOR",
          `❌ Failed to save fallback: ${fallbackMsg}`,
          "error",
        );
      }
    }
  }

  async close(): Promise<void> {
    if (!this.rlClosed) {
      this.rl.close();
      this.rlClosed = true;
    }
    if (this.page && !this.page.isClosed()) {
      await this.page.close();
    }
  }

  /**
   * Setup recovery email for the account
   */
  private async setupRecoveryEmail(): Promise<string | undefined> {
    try {
      log(false, "CREATOR", "📧 Setting up recovery email...", "log", "cyan");

      // Navigate to proofs manage page
      await this.page.goto("https://account.live.com/proofs/manage/", {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await this.humanDelay(2000, 3000);

      // Check if we're on the "Add security info" page
      const addProofTitle = await this.page
        .locator("#iPageTitle")
        .textContent()
        .catch(() => "");

      if (!addProofTitle || !addProofTitle.includes("protect your account")) {
        log(false, "CREATOR", "Already on security dashboard", "log", "gray");
        return undefined;
      }

      log(false, "CREATOR", "🔒 Security setup page detected", "log", "yellow");

      // Get recovery email
      let recoveryEmailToUse = this.recoveryEmail;

      if (!recoveryEmailToUse && !this.autoAccept) {
        recoveryEmailToUse = await this.askRecoveryEmail();
      }

      if (!recoveryEmailToUse) {
        log(false, "CREATOR", "Skipping recovery email setup", "log", "gray");
        return undefined;
      }

      log(
        false,
        "CREATOR",
        `Using recovery email: ${recoveryEmailToUse}`,
        "log",
        "cyan",
      );

      // Fill email input
      const emailInput = this.page.locator("#EmailAddress").first();
      await this.human.humanType(
        emailInput,
        recoveryEmailToUse,
        "RECOVERY_EMAIL",
      );

      // Click Next
      const nextButton = this.page.locator("#iNext").first();
      await nextButton.click();

      log(false, "CREATOR", "📨 Code sent to recovery email", "log", "green");
      log(
        false,
        "CREATOR",
        "⏳ Please enter the code you received and click Next",
        "log",
        "yellow",
      );
      log(
        false,
        "CREATOR",
        "Waiting for you to complete verification...",
        "log",
        "cyan",
      );

      // Wait for URL change (user completes verification)
      await this.page.waitForURL(
        (url) => !url.href.includes("/proofs/Verify"),
        { timeout: 300000 },
      );

      log(false, "CREATOR", "✅ Recovery email verified!", "log", "green");

      // Click OK on "Quick note" page if present
      await this.humanDelay(2000, 3000);
      const okButton = this.page.locator('button:has-text("OK")').first();
      const okVisible = await okButton
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (okVisible) {
        await okButton.click();
        await this.humanDelay(1000, 2000);
        log(false, "CREATOR", "✅ Clicked OK on info page", "log", "green");
      }

      return recoveryEmailToUse;
    } catch (error) {
      log(
        false,
        "CREATOR",
        `Recovery email setup error: ${error}`,
        "warn",
        "yellow",
      );
      return undefined;
    }
  }

  /**
   * Ask user for recovery email (interactive)
   */
  private async askRecoveryEmail(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.rl.question(
        "📧 Enter recovery email (or press Enter to skip): ",
        (answer) => {
          const email = answer.trim();
          if (email && email.includes("@")) {
            resolve(email);
          } else {
            resolve(undefined);
          }
        },
      );
    });
  }

  /**
   * Ask user if they want 2FA setup
   */
  private async ask2FASetup(): Promise<boolean> {
    return new Promise((resolve) => {
      this.rl.question(
        "🔐 Enable two-factor authentication? (y/n): ",
        (answer) => {
          resolve(answer.trim().toLowerCase() === "y");
        },
      );
    });
  }

  /**
   * Setup 2FA with TOTP
   */
  private async setup2FA(): Promise<
    { totpSecret: string; recoveryCode: string | undefined } | undefined
  > {
    try {
      log(false, "CREATOR", "🔐 Setting up 2FA...", "log", "cyan");

      // Navigate to 2FA setup page
      await this.page.goto("https://account.live.com/proofs/EnableTfa", {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await this.humanDelay(2000, 3000);

      // Click Next
      const submitButton = this.page.locator("#EnableTfaSubmit").first();
      await submitButton.click();
      await this.humanDelay(2000, 3000);

      // Click "set up a different Authenticator app"
      const altAppLink = this.page
        .locator("#iSelectProofTypeAlternate")
        .first();
      const altAppVisible = await altAppLink
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (altAppVisible) {
        await altAppLink.click();
        await this.humanDelay(2000, 3000);
      }

      // IMPROVED: Click "I can't scan the bar code" with fallback selectors
      log(
        false,
        "CREATOR",
        '🔍 Looking for "I can\'t scan" link...',
        "log",
        "cyan",
      );

      const cantScanSelectors = [
        "#iShowPlainLink", // Primary
        'a[href*="ShowPlain"]', // Link with ShowPlain in href
        'button:has-text("can\'t scan")', // Button with text
        'a:has-text("can\'t scan")', // Link with text
        'a:has-text("Can\'t scan")', // Capitalized
        'button:has-text("I can\'t scan the bar code")', // Full text
        'a:has-text("I can\'t scan the bar code")', // Full text link
      ];

      let cantScanClicked = false;
      for (const selector of cantScanSelectors) {
        try {
          const element = this.page.locator(selector).first();
          const isVisible = await element
            .isVisible({ timeout: 2000 })
            .catch(() => false);

          if (isVisible) {
            log(
              false,
              "CREATOR",
              `✅ Found "I can't scan" using: ${selector}`,
              "log",
              "green",
            );
            await element.click();
            cantScanClicked = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!cantScanClicked) {
        log(
          false,
          "CREATOR",
          '⚠️ Could not find "I can\'t scan" link - trying to continue anyway',
          "warn",
          "yellow",
        );
      }

      await this.humanDelay(2000, 3000); // Wait for UI to update and secret to appear

      // IMPROVED: Extract TOTP secret with multiple strategies
      log(
        false,
        "CREATOR",
        "🔍 Searching for TOTP secret on page...",
        "log",
        "cyan",
      );

      // Strategy 1: Wait for common TOTP secret selectors
      const secretSelectors = [
        "#iActivationCode span.dirltr.bold", // CORRECT: Secret key in span (lvb5 ysvi...)
        "#iActivationCode span.bold", // Alternative without dirltr
        "#iTOTP_Secret", // FALLBACK: Alternative selector for older Microsoft UI
        "#totpSecret", // Alternative
        'input[name="secret"]', // Input field
        'input[id*="secret"]', // Partial ID match
        'input[id*="TOTP"]', // TOTP-related input
        '[data-bind*="secret"]', // Data binding
        "div.text-block-body", // Text block (new UI)
        "pre", // Pre-formatted text
        "code", // Code block
      ];

      let totpSecret = "";
      let foundSelector = "";

      // Try each selector with explicit wait
      for (const selector of secretSelectors) {
        try {
          const element = this.page.locator(selector).first();
          const isVisible = await element
            .isVisible({ timeout: 2000 })
            .catch(() => false);

          if (isVisible) {
            // Try multiple extraction methods
            const methods = [
              () => element.inputValue().catch(() => ""), // For input fields
              () => element.textContent().catch(() => ""), // For text elements
              () => element.innerText().catch(() => ""), // Alternative text
              () => element.getAttribute("value").catch(() => ""), // Value attribute
            ];

            for (const method of methods) {
              const value = await method();
              // CRITICAL: Remove &nbsp; (non-breaking spaces) and all whitespace
              const cleaned =
                value
                  ?.replace(/\s+/g, "")
                  .replace(/&nbsp;/g, "")
                  .trim() || "";

              // TOTP secrets are typically 16-32 characters, base32 encoded (A-Z, 2-7)
              if (
                cleaned &&
                cleaned.length >= 16 &&
                cleaned.length <= 64 &&
                /^[A-Z2-7]+$/i.test(cleaned)
              ) {
                totpSecret = cleaned.toUpperCase();
                foundSelector = selector;
                log(
                  false,
                  "CREATOR",
                  `✅ Found TOTP secret using selector: ${selector}`,
                  "log",
                  "green",
                );
                break;
              }
            }

            if (totpSecret) break;
          }
        } catch {
          continue;
        }
      }

      // Strategy 2: If not found, scan entire page content
      if (!totpSecret) {
        log(
          false,
          "CREATOR",
          "🔍 Scanning entire page for TOTP pattern...",
          "log",
          "yellow",
        );

        const pageContent = await this.page.content().catch(() => "");
        // Look for base32 patterns (16-32 chars, only A-Z and 2-7)
        const secretPattern = /\b([A-Z2-7]{16,64})\b/g;
        const matches = pageContent.match(secretPattern);

        if (matches && matches.length > 0) {
          // Filter out common false positives (IDs, tokens that are too long)
          const candidates = matches.filter(
            (m) => m.length >= 16 && m.length <= 32,
          );
          if (candidates.length > 0) {
            totpSecret = candidates[0]!;
            foundSelector = "page-scan";
            log(
              false,
              "CREATOR",
              `✅ Found TOTP secret via page scan: ${totpSecret.substring(0, 4)}...`,
              "log",
              "green",
            );
          }
        }
      }

      if (!totpSecret) {
        log(false, "CREATOR", "❌ Could not find TOTP secret", "error");
        log(
          false,
          "CREATOR",
          ` Current URL: ${this.page.url()}`,
          "log",
          "cyan",
        );
        return undefined;
      }

      // SECURITY: Redact TOTP secret - only show first 4 chars for verification
      const redactedSecret =
        totpSecret.substring(0, 4) +
        "*".repeat(Math.max(totpSecret.length - 4, 8));
      log(
        false,
        "CREATOR",
        `🔑 TOTP Secret: ${redactedSecret} (found via: ${foundSelector})`,
        "log",
        "green",
      );
      log(
        false,
        "CREATOR",
        "⚠️  SAVE THIS SECRET - You will need it to generate codes!",
        "warn",
        "yellow",
      );

      // Click "I'll scan a bar code instead" to go back to QR code view
      // (Same link, but now says "I'll scan a bar code instead")
      log(false, "CREATOR", "🔄 Returning to QR code view...", "log", "cyan");

      const backToQRSelectors = [
        "#iShowPlainLink", // Same element, different text now
        'a:has-text("I\'ll scan")', // Text-based
        'a:has-text("scan a bar code instead")', // Full text
        'button:has-text("bar code instead")', // Button variant
      ];

      for (const selector of backToQRSelectors) {
        try {
          const element = this.page.locator(selector).first();
          const isVisible = await element
            .isVisible({ timeout: 2000 })
            .catch(() => false);

          if (isVisible) {
            await element.click();
            log(
              false,
              "CREATOR",
              "✅ Returned to QR code view",
              "log",
              "green",
            );
            break;
          }
        } catch {
          continue;
        }
      }

      await this.humanDelay(1000, 2000);

      log(
        false,
        "CREATOR",
        "📱 Please scan the QR code with Google Authenticator or similar app",
        "log",
        "yellow",
      );
      log(
        false,
        "CREATOR",
        "⏳ Then enter the 6-digit code and click Next",
        "log",
        "cyan",
      );
      log(
        false,
        "CREATOR",
        "Waiting for you to complete setup...",
        "log",
        "cyan",
      );

      // Wait for "Two-step verification is turned on" page
      await this.page.waitForSelector("#RecoveryCode", { timeout: 300000 });

      log(false, "CREATOR", "✅ 2FA enabled!", "log", "green");

      // IMPROVED: Extract recovery code from <b> tag with multiple strategies
      let recoveryCode = "";

      // Strategy 1: Look for <b> tag containing recovery code pattern
      try {
        const boldElements = await this.page.locator("b").all();
        for (const element of boldElements) {
          const text = (await element.textContent().catch(() => "")) || "";
          const match = text.match(
            /([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})/,
          );
          if (match) {
            recoveryCode = match[1]!;
            log(
              false,
              "CREATOR",
              "✅ Found recovery code in <b> tag",
              "log",
              "green",
            );
            break;
          }
        }
      } catch {
        // Continue to next strategy
      }

      // Strategy 2: FALLBACK selector for older Microsoft recovery UI
      if (!recoveryCode) {
        try {
          const recoveryElement = this.page.locator("#NewRecoveryCode").first();
          const recoveryText =
            (await recoveryElement.textContent().catch(() => "")) || "";
          const recoveryMatch = recoveryText.match(
            /([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})/,
          );
          if (recoveryMatch) {
            recoveryCode = recoveryMatch[1]!;
            log(
              false,
              "CREATOR",
              "✅ Found recovery code via #NewRecoveryCode",
              "log",
              "green",
            );
          }
        } catch {
          // Continue to next strategy
        }
      }

      // Strategy 3: Scan entire page content as fallback
      if (!recoveryCode) {
        try {
          const pageContent = await this.page.content().catch(() => "");
          const match = pageContent.match(
            /([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})/,
          );
          if (match) {
            recoveryCode = match[1]!;
            log(
              false,
              "CREATOR",
              "✅ Found recovery code via page scan",
              "log",
              "yellow",
            );
          }
        } catch {
          // Continue
        }
      }

      if (recoveryCode) {
        log(
          false,
          "CREATOR",
          `🔐 Recovery Code: ${recoveryCode}`,
          "log",
          "green",
        );
        log(
          false,
          "CREATOR",
          "⚠️  SAVE THIS CODE - You can use it to recover your account!",
          "warn",
          "yellow",
        );
      } else {
        log(
          false,
          "CREATOR",
          "⚠️ Could not extract recovery code",
          "warn",
          "yellow",
        );
      }

      // Click Next
      await this.humanDelay(2000, 3000);
      const recoveryNextButton = this.page
        .locator("#iOptTfaEnabledRecoveryCodeNext")
        .first();
      await recoveryNextButton.click();

      // Click Next again
      await this.humanDelay(2000, 3000);
      const nextButton2 = this.page.locator("#iOptTfaEnabledNext").first();
      const next2Visible = await nextButton2
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (next2Visible) {
        await nextButton2.click();
        await this.humanDelay(2000, 3000);
      }

      // Click Finish
      const finishButton = this.page.locator("#EnableTfaFinish").first();
      const finishVisible = await finishButton
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (finishVisible) {
        await finishButton.click();
        await this.humanDelay(1000, 2000);
      }

      log(false, "CREATOR", "✅ 2FA setup complete!", "log", "green");

      if (!totpSecret) {
        log(
          false,
          "CREATOR",
          "❌ TOTP secret missing - 2FA may not work",
          "error",
        );
        return undefined;
      }

      return { totpSecret, recoveryCode };
    } catch (error) {
      log(false, "CREATOR", `2FA setup error: ${error}`, "warn", "yellow");
      return undefined;
    }
  }
}
