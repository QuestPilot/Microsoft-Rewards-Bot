import { AxiosRequestConfig } from "axios";
import * as crypto from "crypto";
import type { Page } from "rebrowser-playwright";

import { TIMEOUTS, URLS } from "../constants";
import { MicrosoftRewardsBot } from "../index";
import { OAuth } from "../interface/OAuth";
import { HumanTyping } from "../util/browser/HumanTyping";
import {
    waitForElementSmart,
    waitForPageReady,
} from "../util/browser/SmartWait";
import { Retry } from "../util/core/Retry";
import { getErrorMessage } from "../util/core/Utils";
import { logError } from "../util/notifications/Logger";
import { saveSessionData } from "../util/state/Load";
import {
    LoginState,
    LoginStateDetector,
} from "../util/validation/LoginStateDetector";

// New Handlers
import { PasskeyHandler } from "./login/PasskeyHandler";
import { RecoveryHandler } from "./login/RecoveryHandler";
import { SecurityDetector } from "./login/SecurityDetector";
import { SecurityUtils } from "./login/SecurityUtils";
import { TotpHandler } from "./login/TotpHandler";

// Constants
const SELECTORS = {
  emailInput: 'input[type="email"]',
  passwordInput: 'input[type="password"]',
  submitBtn: 'button[type="submit"]',
} as const;

const LOGIN_TARGET = { host: "rewards.bing.com", path: "/" };

const DEFAULT_TIMEOUTS = {
  loginMaxMs: (() => {
    const val = Number(process.env.LOGIN_MAX_WAIT_MS || 180000);
    return !Number.isFinite(val) || val < 10000 || val > 600000 ? 180000 : val;
  })(),
  short: 200,
  medium: 800,
  long: 1500,
  veryLong: 2000,
  extraLong: 3000,
  oauthMaxMs: 300000, // INCREASED: 5 minutes for OAuth (mobile auth is often slow)
  portalWaitMs: 15000,
  elementCheck: 100,
  fastPoll: 500,
  emailFieldWait: 8000,
  passwordFieldWait: 4000,
  rewardsPortalCheck: 8000,
  navigationTimeout: 30000,
  navigationTimeoutLinux: 30000, // OPTIMIZED: Reduced from 60s (TLS protection now ultra-fast)
  navigationTimeoutWindows: 90000, // Windows is slower at initializing contexts (issue: context closure)
  bingVerificationMaxIterations: 10,
  bingVerificationMaxIterationsMobile: 8,
} as const;

export class Login {
  private bot: MicrosoftRewardsBot;
  private clientId = "0000000040170455";
  private authBaseUrl = "https://login.live.com/oauth20_authorize.srf";
  private redirectUrl = "https://login.live.com/oauth20_desktop.srf";
  private tokenUrl =
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
  private scope = "service::prod.rewardsplatform.microsoft.com::MBI_SSL";

  private static readonly PASSWORD_OPTION_SELECTORS = {
    otherWays: [
      "#signInAnotherWay",
      "button#signInAnotherWay",
      'button[data-id="signInAnotherWay"]',
      'button:has-text("Other ways to sign in")',
      'span[role="button"]:has-text("Other ways to sign in")',
      'a:has-text("Other ways to sign in")',
      'button:has-text("Sign in another way")',
      'span[role="button"]:has-text("Sign in another way")',
      'a:has-text("Sign in another way")',
      'button:has-text("Try another way")',
      'span[role="button"]:has-text("Try another way")',
      'button:has-text("Use a different verification option")',
    ],
    usePassword: [
      'button:has-text("Use your password")',
      'button:has-text("Use my password")',
      'span[role="button"]:has-text("Use your password")',
      'span[role="button"]:has-text("Use my password")',
      'a:has-text("Use your password")',
      'a:has-text("Use my password")',
      'div[role="menuitem"]:has-text("Use your password")',
      'div[role="menuitem"]:has-text("Use my password")',
      'div[role="button"]:has-text("Use your password")',
      'div[role="button"]:has-text("Use my password")',
      'div[role="option"]:has-text("Use your password")',
      'div[role="option"]:has-text("Use my password")',
      'button[data-value="Password"]',
      'div[data-value="Password"]',
    ],
  } as const;

  // Handlers
  private totpHandler: TotpHandler;
  private passkeyHandler: PasskeyHandler;
  private recoveryHandler: RecoveryHandler;
  private securityDetector: SecurityDetector;
  private securityUtils: SecurityUtils;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;

    // Initialize handlers
    this.securityUtils = new SecurityUtils(bot);
    this.totpHandler = new TotpHandler(bot);
    this.passkeyHandler = new PasskeyHandler(bot);
    this.recoveryHandler = new RecoveryHandler(bot, this.securityUtils);
    this.securityDetector = new SecurityDetector(bot, this.securityUtils);

    // Connect PasskeyHandler to TotpHandler for post-TOTP passkey handling
    this.totpHandler.setPasskeyHandler(this.passkeyHandler);

    this.securityUtils.cleanupCompromisedInterval();
  }

  /**
   * Reusable navigation with retry logic and chrome-error recovery
   */
  private async navigateWithRetry(
    page: Page,
    url: string,
    context: string,
    maxAttempts = 3,
  ): Promise<{ success: boolean; recoveryUsed: boolean }> {
    const isLinux = process.platform === "linux";
    const isWindows = process.platform === "win32";
    // CRITICAL FIX: Windows needs 90s timeout to avoid "Target page, context or browser has been closed"
    const navigationTimeout = isWindows
      ? DEFAULT_TIMEOUTS.navigationTimeoutWindows
      : isLinux
        ? DEFAULT_TIMEOUTS.navigationTimeoutLinux
        : DEFAULT_TIMEOUTS.navigationTimeout;

    let navigationSucceeded = false;
    let recoveryUsed = false;
    let attempts = 0;

    while (!navigationSucceeded && attempts < maxAttempts) {
      attempts++;
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
        navigationSucceeded = true;
      } catch (error) {
        const errorMsg = getErrorMessage(error);

        if (errorMsg.includes("chrome-error://chromewebdata/")) {
          this.bot.log(
            this.bot.isMobile,
            context,
            `Navigation interrupted by chrome-error (attempt ${attempts}/${maxAttempts}), attempting recovery...`,
            "warn",
          );

          await this.bot.utils.wait(DEFAULT_TIMEOUTS.long);

          try {
            await page.reload({
              waitUntil: "domcontentloaded",
              timeout: navigationTimeout,
            });
            navigationSucceeded = true;
            recoveryUsed = true;
            this.bot.log(
              this.bot.isMobile,
              context,
              "✓ Recovery successful via reload",
            );
          } catch (reloadError) {
            if (attempts < maxAttempts) {
              this.bot.log(
                this.bot.isMobile,
                context,
                `Reload failed (attempt ${attempts}/${maxAttempts}), trying fresh navigation...`,
                "warn",
              );
              await this.bot.utils.wait(DEFAULT_TIMEOUTS.veryLong);
            } else {
              throw reloadError;
            }
          }
        } else if (
          errorMsg.includes("ERR_PROXY_CONNECTION_FAILED") ||
          errorMsg.includes("ERR_TUNNEL_CONNECTION_FAILED")
        ) {
          this.bot.log(
            this.bot.isMobile,
            context,
            `Proxy connection failed (attempt ${attempts}/${maxAttempts}): ${errorMsg}`,
            "warn",
          );
          if (attempts < maxAttempts) {
            await this.bot.utils.wait(DEFAULT_TIMEOUTS.extraLong * attempts);
          } else {
            throw new Error(
              `Proxy connection failed for ${context} - check proxy configuration`,
            );
          }
        } else if (attempts < maxAttempts) {
          this.bot.log(
            this.bot.isMobile,
            context,
            `Navigation failed (attempt ${attempts}/${maxAttempts}): ${errorMsg}`,
            "warn",
          );
          await this.bot.utils.wait(DEFAULT_TIMEOUTS.veryLong * attempts);
        } else {
          throw error;
        }
      }
    }

    return { success: navigationSucceeded, recoveryUsed };
  }

  // --------------- Public API ---------------
  async login(
    page: Page,
    email: string,
    password: string,
    totpSecret?: string,
  ) {
    try {
      this.securityUtils.cleanupCompromisedInterval();

      this.bot.log(this.bot.isMobile, "LOGIN", "Starting login process");
      this.totpHandler.setTotpSecret(totpSecret);

      const resumed = await this.tryReuseExistingSession(page);
      if (resumed) {
        const needsVerification = !page.url().includes("rewards.bing.com");
        if (needsVerification) {
          await this.verifyBingContext(page);
        }
        await saveSessionData(
          this.bot.config.sessionPath,
          page.context(),
          email,
          this.bot.isMobile,
        );
        this.bot.log(this.bot.isMobile, "LOGIN", "Session restored");
        this.totpHandler.setTotpSecret(undefined);
        return;
      }

      const { success: navigationSucceeded, recoveryUsed } =
        await this.navigateWithRetry(page, URLS.REWARDS_DASHBOARD, "LOGIN");

      if (!navigationSucceeded) {
        throw new Error(
          "Failed to navigate to dashboard after multiple attempts",
        );
      }

      if (!recoveryUsed) {
        await this.bot.utils.wait(DEFAULT_TIMEOUTS.fastPoll);
        const content = await page.content().catch(() => "");
        const hasHttp400 =
          content.includes("HTTP ERROR 400") ||
          content.includes("This page isn't working") ||
          content.includes("This page is not working");

        if (hasHttp400) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "HTTP 400 detected in content, reloading...",
            "warn",
          );
          const isLinux = process.platform === "linux";
          const timeout = isLinux
            ? DEFAULT_TIMEOUTS.navigationTimeoutLinux
            : DEFAULT_TIMEOUTS.navigationTimeout;
          await page.reload({ waitUntil: "domcontentloaded", timeout });
          await this.bot.utils.wait(DEFAULT_TIMEOUTS.medium);
        }
      }

      await this.disableFido(page);

      const [reloadResult, totpResult, portalCheck] = await Promise.allSettled([
        this.bot.browser.utils.reloadBadPage(page),
        this.totpHandler.tryAutoTotp(page, "initial landing"),
        page.waitForSelector('html[data-role-name="RewardsPortal"]', {
          timeout: 3000,
        }),
      ]);

      if (reloadResult.status === "rejected") {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Reload check failed (non-critical): ${reloadResult.reason}`,
          "warn",
        );
      }
      if (totpResult.status === "rejected") {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Auto-TOTP check failed (non-critical): ${totpResult.reason}`,
          "warn",
        );
      }

      await this.securityDetector.checkAccountLocked(page);

      const alreadyAuthenticated = portalCheck.status === "fulfilled";
      if (!alreadyAuthenticated) {
        await this.performLoginFlow(page, email, password);
      } else {
        this.bot.log(this.bot.isMobile, "LOGIN", "Already authenticated");
      }

      const needsBingVerification = !page.url().includes("rewards.bing.com");
      if (needsBingVerification) {
        await this.verifyBingContext(page);
      }

      await saveSessionData(
        this.bot.config.sessionPath,
        page.context(),
        email,
        this.bot.isMobile,
      );
      this.bot.log(this.bot.isMobile, "LOGIN", "Login complete");
      this.totpHandler.setTotpSecret(undefined);
    } catch (e) {
      const errorMessage = getErrorMessage(e);
      const stackTrace = e instanceof Error ? e.stack : undefined;
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `Failed login: ${errorMessage}${stackTrace ? `\nStack: ${stackTrace.split("\n").slice(0, 3).join(" | ")}` : ""}`,
        "error",
      );
      throw new Error(`Login failed for ${email}: ${errorMessage}`);
    } finally {
      this.securityUtils.cleanupCompromisedInterval();
    }
  }

  async getMobileAccessToken(page: Page, email: string, totpSecret?: string) {
    this.totpHandler.setTotpSecret(totpSecret);

    await this.disableFido(page);
    const url = new URL(this.authBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUrl);
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("state", crypto.randomBytes(16).toString("hex"));
    url.searchParams.set("access_type", "offline_access");
    url.searchParams.set("login_hint", email);

    const { success: navigationSucceeded, recoveryUsed } =
      await this.navigateWithRetry(page, url.href, "LOGIN-APP");

    if (!navigationSucceeded) {
      throw new Error(
        "Failed to navigate to OAuth page after multiple attempts",
      );
    }

    if (!recoveryUsed) {
      await this.bot.utils.wait(DEFAULT_TIMEOUTS.fastPoll);
      const content = await page.content().catch((err) => {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-APP",
          `Failed to get page content for HTTP 400 check: ${err}`,
          "warn",
        );
        return "";
      });
      const hasHttp400 =
        content.includes("HTTP ERROR 400") ||
        content.includes("This page isn't working") ||
        content.includes("This page is not working");

      if (hasHttp400) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-APP",
          "HTTP 400 detected, reloading...",
          "warn",
        );
        const isLinux = process.platform === "linux";
        const timeout = isLinux
          ? DEFAULT_TIMEOUTS.navigationTimeoutLinux
          : DEFAULT_TIMEOUTS.navigationTimeout;
        await page.reload({ waitUntil: "domcontentloaded", timeout });
        await this.bot.utils.wait(DEFAULT_TIMEOUTS.medium);
      }
    }
    const start = Date.now();
    this.bot.log(this.bot.isMobile, "LOGIN-APP", "Authorizing mobile scope...");
    let code = "";
    let lastLogTime = start;
    let checkCount = 0;

    while (Date.now() - start < DEFAULT_TIMEOUTS.oauthMaxMs) {
      checkCount++;

      const u = new URL(page.url());
      if (
        u.hostname === "login.live.com" &&
        u.pathname === "/oauth20_desktop.srf"
      ) {
        code = u.searchParams.get("code") || "";
        if (code) break;
      }

      if (checkCount % 3 === 0) {
        await Promise.allSettled([
          this.passkeyHandler.handlePasskeyPrompts(page, "oauth"),
          this.totpHandler.tryAutoTotp(page, "mobile-oauth"),
          this.bot.browser.utils.tryDismissAllMessages(page),
        ]);
      }

      const now = Date.now();
      if (now - lastLogTime > 30000) {
        const elapsed = Math.round((now - start) / 1000);
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-APP",
          `Waiting for OAuth code... (${elapsed}s, URL: ${u.hostname}${u.pathname})`,
          "warn",
        );
        lastLogTime = now;
      }

      const pollDelay = Date.now() - start < 30000 ? 800 : 1500;
      await this.bot.utils.wait(pollDelay);
    }
    if (!code) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const currentUrl = page.url();
      this.bot.log(
        this.bot.isMobile,
        "LOGIN-APP",
        `OAuth code not received after ${elapsed}s. Current URL: ${currentUrl}`,
        "error",
      );
      throw new Error(
        `OAuth code not received within ${DEFAULT_TIMEOUTS.oauthMaxMs / 1000}s (mobile auth can be slow, check manual login)`,
      );
    }

    this.bot.log(
      this.bot.isMobile,
      "LOGIN-APP",
      `OAuth code received in ${Math.round((Date.now() - start) / 1000)}s`,
    );

    const form = new URLSearchParams();
    form.append("grant_type", "authorization_code");
    form.append("client_id", this.clientId);
    form.append("code", code);
    form.append("redirect_uri", this.redirectUrl);

    const isRetryable = (e: unknown): boolean => {
      if (!e || typeof e !== "object") return false;
      const err = e as { response?: { status?: number }; code?: string };
      const status = err.response?.status;
      return (
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 429 ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNREFUSED"
      );
    };

    const req: AxiosRequestConfig = {
      url: this.tokenUrl,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    };

    const oauthRetryPolicy = {
      maxAttempts: 5,
      baseDelay: 2000,
      maxDelay: 60000,
      multiplier: 2,
      jitter: 0.3,
    };
    const retry = new Retry(oauthRetryPolicy);
    try {
      const resp = await retry.run(
        () => this.bot.axios.request(req),
        isRetryable,
      );
      const data: OAuth = resp.data;
      this.bot.log(
        this.bot.isMobile,
        "LOGIN-APP",
        `Authorized in ${Math.round((Date.now() - start) / 1000)}s`,
      );
      this.totpHandler.setTotpSecret(undefined);
      return data.access_token;
    } catch (error) {
      this.totpHandler.setTotpSecret(undefined);
      const err = error as { response?: { status?: number }; message?: string };
      const statusCode = err.response?.status;
      const errMsg = err.message || String(error);
      if (statusCode) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-APP",
          `Token exchange failed after ${oauthRetryPolicy.maxAttempts} retries with status ${statusCode}: ${errMsg}`,
          "error",
        );
      } else {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-APP",
          `Token exchange failed after ${oauthRetryPolicy.maxAttempts} retries (network error): ${errMsg}`,
          "error",
        );
      }
      throw new Error(
        `OAuth token exchange failed: ${statusCode ? `HTTP ${statusCode}` : "Network error"} - ${errMsg}`,
      );
    } finally {
      this.securityUtils.cleanupCompromisedInterval();
    }
  }

  // --------------- Main Flow ---------------
  private async tryReuseExistingSession(page: Page): Promise<boolean> {
    const homeUrl = "https://lgtw.tf/Microsoft-Rewards-Bot-Legacy";
    try {
      const { success: navigationSucceeded, recoveryUsed } =
        await this.navigateWithRetry(page, homeUrl, "LOGIN");

      if (!navigationSucceeded) return false;

      await page
        .waitForLoadState("domcontentloaded")
        .catch(
          logError("LOGIN", "DOMContentLoaded timeout", this.bot.isMobile),
        );

      if (!recoveryUsed) {
        await this.bot.utils.wait(DEFAULT_TIMEOUTS.fastPoll);
        const content = await page.content().catch(() => "");
        const hasHttp400 =
          content.includes("HTTP ERROR 400") ||
          content.includes("This page isn't working") ||
          content.includes("This page is not working");

        if (hasHttp400) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "HTTP 400 on session check, reloading...",
            "warn",
          );
          const isLinux = process.platform === "linux";
          const timeout = isLinux
            ? DEFAULT_TIMEOUTS.navigationTimeoutLinux
            : DEFAULT_TIMEOUTS.navigationTimeout;
          await page.reload({ waitUntil: "domcontentloaded", timeout });
          await this.bot.utils.wait(DEFAULT_TIMEOUTS.medium);
        }
      }
      await this.bot.browser.utils.reloadBadPage(page);
      await this.bot.utils.wait(250);

      // TRACKING SITE DETECTION: Wait for automatic redirect from tracking page
      let pageUrl = page.url();
      if (
        pageUrl.includes("lgtw.tf/Microsoft-Rewards-Bot-Legacy") ||
        pageUrl.includes("about:blank")
      ) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Detected tracking page, waiting for auto-redirect (max 8s)...",
        );

        // Wait for redirect to rewards.bing.com (tracking site redirects after ~5s)
        // Using Promise.race to ensure we respect the timeout
        const redirectPromise = page.waitForFunction(
          () => {
            const href = window.location.href;
            return (
              href.includes("rewards.bing.com") ||
              href.includes("bing.com") ||
              (href.includes("microsoft.com") && !href.includes("lgtw.tf"))
            );
          },
          { timeout: 8000, polling: 200 }, // Check every 200ms
        );

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redirect timeout")), 8000),
        );

        try {
          await Promise.race([redirectPromise, timeoutPromise]);
          await this.bot.utils.wait(TIMEOUTS.SHORT); // Let page stabilize
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "✓ Auto-redirect completed successfully",
          );
        } catch (error) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "Tracking redirect timeout, attempting manual navigation...",
            "warn",
          );
          // Fallback: navigate directly to rewards.bing.com
          try {
            await page.goto(`${URLS.REWARDS_BASE}/`, {
              waitUntil: "domcontentloaded",
              timeout: DEFAULT_TIMEOUTS.navigationTimeout,
            });
            await this.bot.utils.wait(TIMEOUTS.SHORT);
          } catch (navError) {
            this.bot.log(
              this.bot.isMobile,
              "LOGIN",
              `Manual navigation failed: ${getErrorMessage(navError)}`,
              "warn",
            );
          }
        }
      }

      let portalSelector = await this.waitForRewardsRoot(page, 8000);

      if (!portalSelector) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Portal not detected (8s), retrying once...",
          "warn",
        );
        await this.bot.utils.wait(TIMEOUTS.ONE_SECOND);
        await this.bot.browser.utils.reloadBadPage(page);
        portalSelector = await this.waitForRewardsRoot(page, 5000);
      }

      if (portalSelector) {
        const currentUrl = page.url();
        if (
          currentUrl.includes("login.live.com") ||
          currentUrl.includes("login.microsoftonline.com")
        ) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "Detected redirect to login page - session not valid",
            "warn",
          );
          return false;
        }

        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `✅ Existing session still valid (${portalSelector}) — saved 2-3 minutes!`,
        );
        await this.securityDetector.checkAccountLocked(page);
        return true;
      }

      if (await this.totpHandler.tryAutoTotp(page, "session reuse probe")) {
        await this.bot.utils.wait(900);
        const postTotp = await this.waitForRewardsRoot(page, 5000);
        if (postTotp) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            `Existing session unlocked via TOTP (${postTotp})`,
          );
          await this.securityDetector.checkAccountLocked(page);
          return true;
        }
      }

      const finalUrl = page.url();
      if (
        finalUrl.includes("login.live.com") ||
        finalUrl.includes("login.microsoftonline.com")
      ) {
        await this.passkeyHandler.handlePasskeyPrompts(page, "main");
      }
    } catch {
      /* Expected: Session reuse attempt may fail if expired/invalid */
    }
    return false;
  }

  private async performLoginFlow(page: Page, email: string, password: string) {
    const currentState = await LoginStateDetector.detectState(page);

    if (currentState.state === LoginState.TwoFactorRequired) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Already at 2FA page, skipping email entry",
      );
      await this.inputPasswordOr2FA(page, password);
      await this.securityDetector.checkAccountLocked(page);
      await this.awaitRewardsPortal(page);
      return;
    }

    if (currentState.state === LoginState.LoggedIn) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Already logged in, skipping login flow",
      );
      return;
    }

    await this.inputEmail(page, email);

    await waitForPageReady(page, {
      timeoutMs: 10000,
    });

    const passwordPageReached = await LoginStateDetector.waitForAnyState(
      page,
      [
        LoginState.PasswordPage,
        LoginState.TwoFactorRequired,
        LoginState.LoggedIn,
      ],
      8000,
    );

    if (passwordPageReached === LoginState.LoggedIn) {
      const actuallyLoggedIn = await page
        .locator('#more-activities, html[data-role-name*="RewardsPortal"]')
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (actuallyLoggedIn) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Already authenticated after email (fast path)",
        );
        return;
      } else {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "False positive on LoggedIn state, continuing with password entry",
          "warn",
        );
      }
    }

    if (!passwordPageReached) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Password page not reached, continuing...",
        "warn",
      );
    } else if (passwordPageReached !== LoginState.LoggedIn) {
      this.bot.log(this.bot.isMobile, "LOGIN", `State: ${passwordPageReached}`);
    }

    await this.bot.browser.utils.reloadBadPage(page);

    await this.recoveryHandler.tryRecoveryMismatchCheck(page, email);
    if (
      this.bot.compromisedModeActive &&
      this.bot.compromisedReason === "recovery-mismatch"
    ) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Recovery mismatch detected – stopping before password entry",
        "warn",
      );
      return;
    }

    await this.switchToPasswordLink(page);

    await this.inputPasswordOr2FA(page, password);
    if (
      this.bot.compromisedModeActive &&
      this.bot.compromisedReason === "sign-in-blocked"
    ) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Blocked sign-in detected — halting.",
        "warn",
      );
      return;
    }

    await this.securityDetector.checkAccountLocked(page);
    await this.awaitRewardsPortal(page);
  }

  // --------------- Input Steps ---------------
  private async inputEmail(page: Page, email: string) {
    const currentUrl = page.url();
    if (
      !currentUrl.includes("login.live.com") &&
      !currentUrl.includes("login.microsoftonline.com")
    ) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `Not on login page (URL: ${currentUrl}), skipping email entry`,
        "warn",
      );
      return;
    }

    const readyResult = await waitForPageReady(page);

    if (readyResult.timeMs > 5000) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `Page load slow: ${readyResult.timeMs}ms`,
        "warn",
      );
    }

    const state = await LoginStateDetector.detectState(page);
    if (state.state === LoginState.TwoFactorRequired) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "TOTP/2FA detected before email entry, handling...",
        "warn",
      );
      if (await this.totpHandler.tryAutoTotp(page, "pre-email TOTP")) {
        await this.bot.utils.wait(TIMEOUTS.SHORT);
        return;
      }
    }

    if (state.state === LoginState.LoggedIn) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Already logged in, skipping email entry",
      );
      return;
    }

    let emailResult = await waitForElementSmart(page, SELECTORS.emailInput, {
      initialTimeoutMs: 2000,
      extendedTimeoutMs: 5000,
      state: "visible",
    });

    if (!emailResult.found) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Email field not found, retrying...",
        "warn",
      );

      const totpHandled = await this.totpHandler.tryAutoTotp(
        page,
        "pre-email challenge",
      );
      if (totpHandled) {
        await this.bot.utils.wait(TIMEOUTS.SHORT);
        emailResult = await waitForElementSmart(page, SELECTORS.emailInput, {
          initialTimeoutMs: 2000,
          extendedTimeoutMs: 5000,
          state: "visible",
        });
      }
    }

    if (!emailResult.found) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Email field missing, checking page state...",
        "warn",
      );
      await this.bot.utils.wait(100);

      const content = await page.content().catch(() => "");
      if (content.length < 1000) {
        this.bot.log(this.bot.isMobile, "LOGIN", "Reloading page...", "warn");
        await page
          .reload({ waitUntil: "domcontentloaded", timeout: 10000 })
          .catch(() => {});
        await waitForPageReady(page);
      }

      const totpRetry = await this.totpHandler.tryAutoTotp(
        page,
        "pre-email retry",
      );
      if (totpRetry) {
        await this.bot.utils.wait(TIMEOUTS.SHORT);
      }

      emailResult = await waitForElementSmart(page, SELECTORS.emailInput, {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: 5000,
        state: "visible",
      });

      if (!emailResult.found) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Email field not present after all retries",
          "error",
        );
        throw new Error(
          "Login form email field not found after multiple attempts",
        );
      }
    }

    const prefilledResult = await waitForElementSmart(
      page,
      "#userDisplayName",
      {
        initialTimeoutMs: 500,
        extendedTimeoutMs: 1000,
        state: "visible",
      },
    );

    if (!prefilledResult.found) {
      // FIXED: Use HumanTyping instead of .fill() to avoid bot detection
      await HumanTyping.typeEmail(page.locator(SELECTORS.emailInput), email);
    } else {
      this.bot.log(this.bot.isMobile, "LOGIN", "Email prefilled");
    }

    const submitResult = await waitForElementSmart(page, SELECTORS.submitBtn, {
      initialTimeoutMs: 500,
      extendedTimeoutMs: 1500,
      state: "visible",
    });

    if (submitResult.found && submitResult.element) {
      await submitResult.element
        .click()
        .catch((e) =>
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            `Email submit click failed: ${getErrorMessage(e)}`,
            "warn",
          ),
        );
      this.bot.log(this.bot.isMobile, "LOGIN", "Submitted email");
    }
  }

  private async inputPasswordOr2FA(page: Page, password: string) {
    const switchResult = await waitForElementSmart(
      page,
      "#idA_PWD_SwitchToPassword",
      {
        initialTimeoutMs: 500,
        extendedTimeoutMs: 1000,
        state: "visible",
      },
    );

    if (switchResult.found && switchResult.element) {
      await switchResult.element
        .click()
        .catch((e) =>
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            `Switch to password failed: ${getErrorMessage(e)}`,
            "warn",
          ),
        );
      await this.bot.utils.wait(300);
    }

    const totpDetected = await this.totpHandler.tryAutoTotp(
      page,
      "pre-password TOTP check",
    );
    if (totpDetected) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "TOTP challenge appeared before password entry",
      );
      return;
    }

    let passwordResult = await waitForElementSmart(
      page,
      SELECTORS.passwordInput,
      {
        initialTimeoutMs: 1500,
        extendedTimeoutMs: 3000,
        state: "visible",
      },
    );

    if (!passwordResult.found) {
      await this.bot.utils.wait(TIMEOUTS.SHORT);
      passwordResult = await waitForElementSmart(
        page,
        SELECTORS.passwordInput,
        {
          initialTimeoutMs: 1500,
          extendedTimeoutMs: 2500,
          state: "visible",
        },
      );
    }

    if (!passwordResult.found) {
      const blocked = await this.securityDetector.detectSignInBlocked(page);
      if (blocked) return;
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Password field absent — invoking 2FA handler",
        "warn",
      );
      await this.totpHandler.handle2FA(page);
      return;
    }

    const blocked = await this.securityDetector.detectSignInBlocked(page);
    if (blocked) return;

    // FIXED: Use HumanTyping instead of .fill() to avoid bot detection
    await HumanTyping.typePassword(
      page.locator(SELECTORS.passwordInput),
      password,
    );

    const submitResult = await waitForElementSmart(page, SELECTORS.submitBtn, {
      initialTimeoutMs: 500,
      extendedTimeoutMs: 1500,
      state: "visible",
    });

    if (submitResult.found && submitResult.element) {
      await submitResult.element
        .click()
        .catch((e) =>
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            `Password submit failed: ${getErrorMessage(e)}`,
            "warn",
          ),
        );
      this.bot.log(this.bot.isMobile, "LOGIN", "Password submitted");
    }
  }

  private async waitForRewardsRoot(
    page: Page,
    timeoutMs: number,
  ): Promise<string | null> {
    const selectors = [
      'html[data-role-name="RewardsPortal"]',
      'html[data-role-name*="RewardsPortal"]',
      'body[data-role-name*="RewardsPortal"]',
      '[data-role-name*="RewardsPortal"]',
      '[data-bi-name="rewards-dashboard"]',
      'main[data-bi-name="dashboard"]',
      "#more-activities",
      "#dashboard",
      '[class*="rewards"]',
      '[id*="rewards-dashboard"]',
      "main.dashboard-container",
      ".dashboard-content",
      '[data-bi-area="rewards"]',
      ".rewards-container",
      "#rewards-app",
      '[role="main"]',
    ];

    const start = Date.now();
    let lastLogTime = start;
    let checkCount = 0;

    while (Date.now() - start < timeoutMs) {
      checkCount++;

      const url = page.url();
      const isRewardsDomain =
        url.includes("rewards.bing.com") ||
        url.includes("rewards.microsoft.com");

      if (isRewardsDomain) {
        const [hasContent, notLoggedIn, hasAuthIndicators] = await Promise.all([
          page
            .evaluate(
              () => document.body && document.body.innerText.length > 100,
            )
            .catch(() => false),
          page
            .evaluate(() => {
              const signInSelectors = [
                'a[href*="signin"]',
                'button:has-text("Sign in")',
                '[data-bi-id*="signin"]',
              ];
              for (const sel of signInSelectors) {
                try {
                  const elements = document.querySelectorAll(sel);
                  for (const el of elements) {
                    const text = el.textContent?.toLowerCase() || "";
                    if (
                      text.includes("sign in") &&
                      (el as HTMLElement).offsetParent !== null
                    ) {
                      return true;
                    }
                  }
                } catch {
                  /* ignore */
                }
              }
              return false;
            })
            .catch(() => false),
          page
            .evaluate(() => {
              const authSelectors = [
                "#id_n",
                '[id*="point"]',
                '[class*="userProfile"]',
                "#more-activities",
              ];
              for (const sel of authSelectors) {
                try {
                  const el = document.querySelector(sel);
                  if (el && (el as HTMLElement).offsetParent !== null)
                    return true;
                } catch {
                  /* ignore */
                }
              }
              return false;
            })
            .catch(() => false),
        ]);

        if (hasContent && !notLoggedIn && hasAuthIndicators) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "Rewards page detected (authenticated)",
          );
          return "rewards-url-authenticated";
        }

        if (hasContent && notLoggedIn) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "On rewards page but not authenticated yet",
            "warn",
          );
        }
      }

      if (checkCount % 2 === 0) {
        for (const sel of selectors) {
          const loc = page.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            return sel;
          }
        }
      }

      const now = Date.now();
      if (now - lastLogTime > 5000) {
        const elapsed = Math.round((now - start) / 1000);
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Still waiting for portal... (${elapsed}s, URL: ${url})`,
          "warn",
        );
        lastLogTime = now;
      }

      const pollDelay =
        Date.now() - start < 5000
          ? DEFAULT_TIMEOUTS.elementCheck
          : DEFAULT_TIMEOUTS.short;
      await this.bot.utils.wait(pollDelay);
    }
    return null;
  }

  private async awaitRewardsPortal(page: Page) {
    const start = Date.now();
    let lastUrl = "";
    let checkCount = 0;

    const initialState = await LoginStateDetector.detectState(page);
    if (initialState.state === LoginState.LoggedIn) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Already on rewards portal (early exit)",
      );
      return;
    }

    while (Date.now() - start < DEFAULT_TIMEOUTS.loginMaxMs) {
      checkCount++;

      const currentUrl = page.url();
      if (currentUrl !== lastUrl) {
        if (process.env.DEBUG_REWARDS_VERBOSE === "1") {
          this.bot.log(this.bot.isMobile, "LOGIN", `Navigation: ${currentUrl}`);
        }
        lastUrl = currentUrl;
      }

      if (checkCount % 5 === 0) {
        const state = await LoginStateDetector.detectState(page);
        if (state.state === LoginState.LoggedIn) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            `State detector confirmed: ${state.state} (confidence: ${state.confidence})`,
          );
          break;
        }
        if (state.state === LoginState.Blocked) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "Blocked state detected during portal wait",
            "error",
          );
          throw new Error("Account blocked during login");
        }
      }

      const u = new URL(currentUrl);
      const isRewardsHost = u.hostname === LOGIN_TARGET.host;
      const isKnownPath =
        u.pathname === LOGIN_TARGET.path ||
        u.pathname === "/dashboard" ||
        u.pathname === "/rewardsapp/dashboard" ||
        u.pathname.startsWith("/?");
      if (isRewardsHost && isKnownPath) break;

      if (checkCount % 3 === 0) {
        await Promise.allSettled([
          this.passkeyHandler.handlePasskeyPrompts(page, "main"),
          this.totpHandler.tryAutoTotp(page, "post-password wait"),
          this.bot.browser.utils.tryDismissAllMessages(page),
        ]);
      } else {
        await this.passkeyHandler.handlePasskeyPrompts(page, "main");
      }

      const waitTime =
        Date.now() - start < 10000 ? DEFAULT_TIMEOUTS.fastPoll : 1000;
      await this.bot.utils.wait(waitTime);
    }

    this.bot.log(this.bot.isMobile, "LOGIN", "Checking for portal elements...");
    const portalSelector = await this.waitForRewardsRoot(
      page,
      DEFAULT_TIMEOUTS.portalWaitMs,
    );

    if (!portalSelector) {
      // Before trying fallback, check if account is suspended/banned
      const isSuspended =
        await this.securityDetector.checkAccountSuspended(page);
      if (isSuspended) {
        throw new Error(
          "Account suspended by Microsoft Rewards - disabled in accounts.jsonc",
        );
      }

      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Portal not found, trying goHome() fallback...",
        "warn",
      );

      try {
        await this.bot.browser.func.goHome(page);
        await this.bot.utils.wait(TIMEOUTS.MEDIUM);
      } catch (e) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `goHome() failed: ${getErrorMessage(e)}`,
          "warn",
        );
      }

      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        "Retry: checking for portal elements...",
      );
      const fallbackSelector = await this.waitForRewardsRoot(
        page,
        DEFAULT_TIMEOUTS.portalWaitMs,
      );

      if (!fallbackSelector) {
        const currentUrl = page.url();
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Current URL: ${currentUrl}`,
          "error",
        );

        const pageContent = await page
          .evaluate(() => {
            return {
              title: document.title,
              bodyLength: document.body?.innerText?.length || 0,
              hasRewardsText:
                document.body?.innerText?.toLowerCase().includes("rewards") ||
                false,
              visibleElements: document.querySelectorAll(
                "*[data-role-name], *[data-bi-name], main, #dashboard",
              ).length,
            };
          })
          .catch(() => ({
            title: "unknown",
            bodyLength: 0,
            hasRewardsText: false,
            visibleElements: 0,
          }));

        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Page info: ${JSON.stringify(pageContent)}`,
          "error",
        );
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Portal element missing",
          "error",
        );
        throw new Error(
          `Rewards portal not detected. URL: ${currentUrl}. Check reports/ folder`,
        );
      }
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `Portal found via fallback (${fallbackSelector})`,
      );
      return;
    }

    this.bot.log(
      this.bot.isMobile,
      "LOGIN",
      `Portal found (${portalSelector})`,
    );
  }

  private async verifyBingContext(page: Page) {
    try {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN-BING",
        "Verifying Bing auth context",
      );

      const verificationUrl = URLS.BING_SIGNIN;

      const { success: navigationSucceeded } = await this.navigateWithRetry(
        page,
        verificationUrl,
        "LOGIN-BING",
      );

      if (!navigationSucceeded) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          "Bing verification navigation failed after multiple attempts",
          "warn",
        );
        return;
      }

      await this.bot.utils.wait(DEFAULT_TIMEOUTS.medium);
      const content = await page.content().catch(() => "");
      const hasHttp400 =
        content.includes("HTTP ERROR 400") ||
        content.includes("This page isn't working") ||
        content.includes("This page is not working");

      if (hasHttp400) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          "HTTP 400 detected during Bing verification, reloading...",
          "warn",
        );
        const isLinux = process.platform === "linux";
        const timeout = isLinux
          ? DEFAULT_TIMEOUTS.navigationTimeoutLinux
          : DEFAULT_TIMEOUTS.navigationTimeout;
        await page
          .reload({ waitUntil: "domcontentloaded", timeout })
          .catch(
            logError(
              "LOGIN-BING",
              "Reload after HTTP 400 failed",
              this.bot.isMobile,
            ),
          );
        await this.bot.utils.wait(DEFAULT_TIMEOUTS.medium);
      }

      const maxIterations = this.bot.isMobile
        ? DEFAULT_TIMEOUTS.bingVerificationMaxIterationsMobile
        : DEFAULT_TIMEOUTS.bingVerificationMaxIterations;
      for (let i = 0; i < maxIterations; i++) {
        const u = new URL(page.url());

        if (u.hostname === "www.bing.com" && u.pathname === "/") {
          await this.bot.browser.utils.tryDismissAllMessages(page);

          const ok = await page
            .waitForSelector("#id_n", { timeout: 3000 })
            .then(() => true)
            .catch(() => false);
          if (ok) {
            this.bot.log(
              this.bot.isMobile,
              "LOGIN-BING",
              "Bing verification passed (user profile detected)",
            );
            return;
          }

          if (this.bot.isMobile) {
            this.bot.log(
              this.bot.isMobile,
              "LOGIN-BING",
              "Bing verification passed (mobile mode - profile check skipped)",
            );
            return;
          }
        }

        if (
          u.hostname.includes("login.live.com") ||
          u.hostname.includes("login.microsoftonline.com")
        ) {
          await this.passkeyHandler.handlePasskeyPrompts(page, "main");
          await this.totpHandler.tryAutoTotp(page, "bing-verification");
        }

        const waitTime = i < 3 ? 1000 : 1500;
        await this.bot.utils.wait(waitTime);
      }

      const finalUrl = page.url();
      if (finalUrl.includes("www.bing.com")) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          "Bing verification completed (on Bing domain, assuming success)",
        );
      } else {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          `Bing verification uncertain - final URL: ${finalUrl}`,
          "warn",
        );
      }
    } catch (e) {
      const errorMsg = getErrorMessage(e);
      this.bot.log(
        this.bot.isMobile,
        "LOGIN-BING",
        `Bing verification error: ${errorMsg}`,
        "warn",
      );

      if (errorMsg.includes("Proxy connection failed")) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          "Skipping Bing verification due to proxy issues - continuing anyway",
          "warn",
        );
      } else {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-BING",
          "Bing verification failed but continuing login process",
          "warn",
        );
      }
    }
  }

  private async clickFirstVisibleSelector(
    page: Page,
    selectors: readonly string[],
  ): Promise<boolean> {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc
          .click()
          .catch(
            logError(
              "LOGIN",
              `Click failed for selector: ${sel}`,
              this.bot.isMobile,
            ),
          );
        return true;
      }
    }
    return false;
  }

  private async switchToPasswordLink(page: Page) {
    try {
      const passwordClicked = await this.tryClickPasswordOption(page);
      if (passwordClicked) return;

      const otherWays = await this.clickFirstVisibleSelector(
        page,
        Login.PASSWORD_OPTION_SELECTORS.otherWays,
      );
      if (otherWays) {
        await this.bot.utils.wait(600);
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Opened alternate sign-in options",
        );
        await this.tryClickPasswordOption(page);
      }
    } catch {
      /* Link may not be present - expected on password-first flows */
    }
  }

  private async tryClickPasswordOption(page: Page): Promise<boolean> {
    const clicked = await this.clickFirstVisibleSelector(
      page,
      Login.PASSWORD_OPTION_SELECTORS.usePassword,
    );
    if (clicked) {
      await this.bot.utils.wait(800);
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        'Clicked "Use your password" option',
      );
      return true;
    }

    const legacy = await page
      .locator(
        'xpath=//span[@role="button" and (contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"use your password") or contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"utilisez votre mot de passe"))]',
      )
      .first();
    if (await legacy.isVisible().catch(() => false)) {
      await legacy
        .click()
        .catch(
          logError(
            "LOGIN",
            "Use password link click failed",
            this.bot.isMobile,
          ),
        );
      await this.bot.utils.wait(800);
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        'Clicked "Use your password" link',
      );
      return true;
    }

    return false;
  }

  private async disableFido(page: Page) {
    await page
      .route("**/GetCredentialType.srf*", (route) => {
        try {
          const body = JSON.parse(route.request().postData() || "{}");
          body.isFidoSupported = false;
          route.continue({ postData: JSON.stringify(body) });
        } catch {
          route.continue();
        }
      })
      .catch(
        logError(
          "LOGIN-FIDO",
          "Route interception setup failed",
          this.bot.isMobile,
        ),
      );
  }
}
