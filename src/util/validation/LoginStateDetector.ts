import type { Page } from "rebrowser-playwright";

/**
 * Login flow states for better tracking and debugging
 */
export enum LoginState {
  Unknown = "UNKNOWN",
  InitialLoad = "INITIAL_LOAD",
  EmailPage = "EMAIL_PAGE",
  EmailSubmitted = "EMAIL_SUBMITTED",
  PasswordPage = "PASSWORD_PAGE",
  PasswordSubmitted = "PASSWORD_SUBMITTED",
  TwoFactorRequired = "2FA_REQUIRED",
  TwoFactorSubmitted = "2FA_SUBMITTED",
  PasskeyPrompt = "PASSKEY_PROMPT",
  RecoveryCheck = "RECOVERY_CHECK",
  LoggedIn = "LOGGED_IN",
  Blocked = "BLOCKED",
  Error = "ERROR",
}

/**
 * Result of login state detection
 */
interface LoginStateDetection {
  state: LoginState;
  confidence: "high" | "medium" | "low";
  url: string;
  indicators: string[];
}

/**
 * LoginStateDetector: Intelligent detection of current login flow state
 * Helps avoid assumptions and provides clear visibility of where we are
 */
export class LoginStateDetector {
  /**
   * Detect current state of login flow based on page URL and DOM
   */
  static async detectState(page: Page): Promise<LoginStateDetection> {
    const url = page.url();
    const indicators: string[] = [];

    // State 1: Already logged in (rewards portal)
    if (
      url.includes("rewards.bing.com") ||
      url.includes("rewards.microsoft.com")
    ) {
      // STRICT CHECK: Must have actual portal elements, not just domain
      const hasPortal = await page
        .locator(
          'html[data-role-name*="RewardsPortal"], #dashboard, main[data-bi-name="dashboard"], #more-activities',
        )
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (hasPortal) {
        indicators.push("Rewards portal detected");
        return {
          state: LoginState.LoggedIn,
          confidence: "high",
          url,
          indicators,
        };
      }

      // On rewards domain but no portal = still loading or redirecting to login
      // Do NOT assume logged in just because of domain
      indicators.push("On rewards domain but portal not detected");

      // Check if actually redirecting to login
      const isRedirectingToLogin =
        url.includes("login.live.com") ||
        url.includes("login.microsoftonline.com") ||
        (await page
          .locator('input[type="email"], input[name="loginfmt"]')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false));

      if (isRedirectingToLogin) {
        indicators.push("Redirecting to login");
        return {
          state: LoginState.EmailPage,
          confidence: "medium",
          url,
          indicators,
        };
      }

      // Unknown state - not logged in, not login page
      return { state: LoginState.Unknown, confidence: "low", url, indicators };
    }

    // State 2: Microsoft login pages
    if (
      url.includes("login.live.com") ||
      url.includes("login.microsoftonline.com")
    ) {
      // Check for email input
      const hasEmailInput = await page
        .locator('input[type="email"], input[name="loginfmt"]')
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);

      if (hasEmailInput) {
        indicators.push("Email input field detected");
        return {
          state: LoginState.EmailPage,
          confidence: "high",
          url,
          indicators,
        };
      }

      // Check for password input
      const hasPasswordInput = await page
        .locator('input[type="password"], input[name="passwd"]')
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);

      if (hasPasswordInput) {
        indicators.push("Password input field detected");
        return {
          state: LoginState.PasswordPage,
          confidence: "high",
          url,
          indicators,
        };
      }

      // Check for 2FA/OTP input
      const hasTotpInput = await page
        .locator('input[name="otc"], input[autocomplete="one-time-code"]')
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);

      if (hasTotpInput) {
        indicators.push("2FA/TOTP input field detected");
        return {
          state: LoginState.TwoFactorRequired,
          confidence: "high",
          url,
          indicators,
        };
      }

      // Check for passkey/Windows Hello prompts
      const hasPasskeyPrompt = await page
        .locator('[data-testid="title"]')
        .first()
        .textContent()
        .then((text: string | null) =>
          /sign in faster|passkey|fingerprint|windows hello/i.test(text || ""),
        )
        .catch(() => false);

      if (hasPasskeyPrompt) {
        indicators.push("Passkey/Windows Hello prompt detected");
        return {
          state: LoginState.PasskeyPrompt,
          confidence: "high",
          url,
          indicators,
        };
      }

      // Check for blocked/error messages
      const hasBlockedMessage = await page
        .locator('[data-testid="title"], h1')
        .first()
        .textContent()
        .then((text: string | null) =>
          /can[''`]?t sign you in|blocked|locked/i.test(text || ""),
        )
        .catch(() => false);

      if (hasBlockedMessage) {
        indicators.push("Account blocked/error message detected");
        return {
          state: LoginState.Blocked,
          confidence: "high",
          url,
          indicators,
        };
      }

      // Generic login page
      indicators.push("On Microsoft login domain, state unclear");
      return { state: LoginState.Unknown, confidence: "low", url, indicators };
    }

    // State 3: OAuth flow (mobile token)
    if (
      url.includes("/oauth20_authorize.srf") ||
      url.includes("/oauth20_desktop.srf")
    ) {
      indicators.push("OAuth flow detected");
      return {
        state: LoginState.EmailSubmitted,
        confidence: "medium",
        url,
        indicators,
      };
    }

    // Unknown state
    indicators.push("Unknown page");
    return { state: LoginState.Unknown, confidence: "low", url, indicators };
  }

  /**
   * Wait for state transition with timeout
   * Returns true if expected state reached, false if timeout
   */
  static async waitForState(
    page: Page,
    expectedState: LoginState,
    timeoutMs: number = 10000,
  ): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const detection = await LoginStateDetector.detectState(page);
      if (detection.state === expectedState) {
        return true;
      }

      // Fast polling for quick transitions
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Wait for any of multiple states (whichever comes first)
   */
  static async waitForAnyState(
    page: Page,
    expectedStates: LoginState[],
    timeoutMs: number = 10000,
  ): Promise<LoginState | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const detection = await LoginStateDetector.detectState(page);
      if (expectedStates.includes(detection.state)) {
        return detection.state;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return null;
  }
}
