import readline from "readline";
import type { Locator, Page } from "rebrowser-playwright";

import { TIMEOUTS } from "../../constants";
import { MicrosoftRewardsBot } from "../../index";
import { HumanTyping } from "../../util/browser/HumanTyping";
import { getErrorMessage } from "../../util/core/Utils";
import { logError } from "../../util/notifications/Logger";
import { generateTOTP } from "../../util/security/Totp";
import type { PasskeyHandler } from "./PasskeyHandler";

export class TotpHandler {
  private bot: MicrosoftRewardsBot;
  private lastTotpSubmit = 0;
  private totpAttempts = 0;
  private currentTotpSecret?: string;
  private passkeyHandler?: PasskeyHandler;

  // Unified selector system - DRY principle
  private static readonly TOTP_SELECTORS = {
    input: [
      'input[name="otc"]',
      "#idTxtBx_SAOTCC_OTC",
      "#idTxtBx_SAOTCS_OTC",
      'input[data-testid="otcInput"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"][name="otc"]',
      'input[id^="floatingLabelInput"]',
    ],
    altOptions: [
      "#idA_SAOTCS_ProofPickerChange",
      "#idA_SAOTCC_AlternateLogin",
      'a:has-text("Use a different verification option")',
      'a:has-text("Sign in another way")',
      'a:has-text("I can\'t use my Microsoft Authenticator app right now")',
      'button:has-text("Use a different verification option")',
      'button:has-text("Sign in another way")',
    ],
    challenge: [
      '[data-value="PhoneAppOTP"]',
      '[data-value="OneTimeCode"]',
      'button:has-text("Use a verification code")',
      'button:has-text("Enter code manually")',
      'button:has-text("Enter a code from your authenticator app")',
      'button:has-text("Use code from your authentication app")',
      'button:has-text("Utiliser un code de vérification")',
      'button:has-text("Entrer un code depuis votre application")',
      'button:has-text("Entrez un code")',
      'div[role="button"]:has-text("Use a verification code")',
      'div[role="button"]:has-text("Enter a code")',
    ],
    submit: [
      "#idSubmit_SAOTCC_Continue",
      "#idSubmit_SAOTCC_OTC",
      'button[type="submit"]:has-text("Verify")',
      'button[type="submit"]:has-text("Continuer")',
      'button:has-text("Verify")',
      'button:has-text("Continuer")',
      'button:has-text("Submit")',
      'button[type="submit"]:has-text("Next")',
      'button:has-text("Next")',
      'button[data-testid="primaryButton"]:has-text("Next")',
    ],
  } as const;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  public setPasskeyHandler(handler: PasskeyHandler) {
    this.passkeyHandler = handler;
  }

  public setTotpSecret(secret?: string) {
    this.currentTotpSecret = (secret && secret.trim()) || undefined;
    this.lastTotpSubmit = 0;
    this.totpAttempts = 0;
  }

  public reset() {
    this.lastTotpSubmit = 0;
    this.totpAttempts = 0;
  }

  public async handle2FA(page: Page) {
    try {
      // Dismiss any popups/dialogs before checking 2FA (Terms Update, etc.)
      await this.bot.browser.utils.tryDismissAllMessages(page);
      await this.bot.utils.wait(TIMEOUTS.SHORT);

      const usedTotp = await this.tryAutoTotp(
        page,
        "2FA initial step",
        this.currentTotpSecret,
      );
      if (usedTotp) return;

      const number = await this.fetchAuthenticatorNumber(page);
      if (number) {
        await this.approveAuthenticator(page, number);
        return;
      }
      await this.handleSMSOrTotp(page);
    } catch (e) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `2FA error: ${getErrorMessage(e)}`,
        "warn",
      );
    }
  }

  public async tryAutoTotp(
    page: Page,
    context: string,
    currentTotpSecret?: string,
  ): Promise<boolean> {
    const secret = currentTotpSecret || this.currentTotpSecret;
    if (!secret) return false;
    const throttleMs = 5000;
    if (Date.now() - this.lastTotpSubmit < throttleMs) return false;

    const selector = await this.ensureTotpInput(page);
    if (!selector) return false;

    if (this.totpAttempts >= 3) {
      const errMsg =
        "TOTP challenge still present after multiple attempts; verify authenticator secret or approvals.";
      this.bot.log(this.bot.isMobile, "LOGIN", errMsg, "error");
      throw new Error(errMsg);
    }

    this.bot.log(
      this.bot.isMobile,
      "LOGIN",
      `Detected TOTP challenge during ${context}; submitting code automatically`,
    );
    await this.submitTotpCode(page, selector, secret);
    this.totpAttempts += 1;
    this.lastTotpSubmit = Date.now();

    // Handle potential Passkey QR code dialog that appears after TOTP submission
    if (this.passkeyHandler) {
      await this.bot.utils.wait(800); // Brief wait for dialog to appear
      try {
        await this.passkeyHandler.handlePasskeyPrompts(page, "main");
      } catch (error) {
        // Non-critical: continue even if passkey handling fails
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Passkey handling after TOTP: ${error}`,
          "warn",
        );
      }
    }

    await this.bot.utils.wait(1200);
    return true;
  }

  private async fetchAuthenticatorNumber(page: Page): Promise<string | null> {
    try {
      const el = await page.waitForSelector(
        '#displaySign, div[data-testid="displaySign"]>span',
        { timeout: 2500 },
      );
      return (await el.textContent())?.trim() || null;
    } catch {
      // Attempt resend loop in parallel mode
      if (this.bot.config.parallel) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Parallel mode: throttling authenticator push requests",
          "log",
          "yellow",
        );
        for (let attempts = 0; attempts < 6; attempts++) {
          // max 6 minutes retry window
          const resend = await page
            .waitForSelector(
              'button[aria-describedby="pushNotificationsTitle errorDescription"]',
              { timeout: 1500 },
            )
            .catch(() => null);
          if (!resend) break;
          await this.bot.utils.wait(TIMEOUTS.ONE_MINUTE);
          await resend
            .click()
            .catch(logError("LOGIN", "Resend click failed", this.bot.isMobile));
        }
      }
      await page
        .click('button[aria-describedby="confirmSendTitle"]')
        .catch(
          logError("LOGIN", "Confirm send click failed", this.bot.isMobile),
        );
      await this.bot.utils.wait(TIMEOUTS.MEDIUM);
      try {
        const el = await page.waitForSelector(
          '#displaySign, div[data-testid="displaySign"]>span',
          { timeout: 2000 },
        );
        return (await el.textContent())?.trim() || null;
      } catch {
        return null;
      }
    }
  }

  private async approveAuthenticator(page: Page, numberToPress: string) {
    for (let cycle = 0; cycle < 6; cycle++) {
      // max ~6 refresh cycles
      try {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          `Approve login in Authenticator (press ${numberToPress})`,
        );
        await page.waitForSelector('form[name="f1"]', {
          state: "detached",
          timeout: 60000,
        });
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Authenticator approval successful",
        );
        return;
      } catch {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Authenticator code expired – refreshing",
        );
        const retryBtn = await page
          .waitForSelector('button[data-testid="primaryButton"]', {
            timeout: 3000,
          })
          .catch(() => null);
        if (retryBtn)
          await retryBtn
            .click()
            .catch(
              logError(
                "LOGIN-AUTH",
                "Refresh button click failed",
                this.bot.isMobile,
              ),
            );
        const refreshed = await this.fetchAuthenticatorNumber(page);
        if (!refreshed) {
          this.bot.log(
            this.bot.isMobile,
            "LOGIN",
            "Could not refresh authenticator code",
            "warn",
          );
          return;
        }
        numberToPress = refreshed;
      }
    }
    this.bot.log(
      this.bot.isMobile,
      "LOGIN",
      "Authenticator approval loop exited (max cycles reached)",
      "warn",
    );
  }

  private async handleSMSOrTotp(page: Page) {
    // TOTP auto entry (second chance if ensureTotpInput needed longer)
    const usedTotp = await this.tryAutoTotp(
      page,
      "manual 2FA entry",
      this.currentTotpSecret,
    );
    if (usedTotp) return;

    // Manual prompt with 120s timeout
    this.bot.log(
      this.bot.isMobile,
      "LOGIN",
      "Waiting for user 2FA code (SMS / Email / App fallback)",
    );
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      // FIXED: Add 120s timeout with proper cleanup to prevent memory leak
      let timeoutHandle: NodeJS.Timeout | undefined;
      const code = await Promise.race([
        new Promise<string>((res) => {
          rl.question("Enter 2FA code:\n", (ans) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            rl.close();
            res(ans.trim());
          });
        }),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            rl.close();
            reject(new Error("2FA code input timeout after 120s"));
          }, 120000);
        }),
      ]);

      // Check if input field still exists before trying to fill
      const inputExists = await page
        .locator('input[name="otc"]')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (!inputExists) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "Page changed while waiting for code (user progressed manually)",
          "warn",
        );
        return;
      }

      // FIXED: Use HumanTyping instead of .fill() to avoid bot detection
      await HumanTyping.typeTotp(page.locator('input[name="otc"]'), code);
      await page.keyboard.press("Enter");
      this.bot.log(this.bot.isMobile, "LOGIN", "2FA code submitted");
    } catch (error) {
      if (error instanceof Error && error.message.includes("timeout")) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "2FA code input timeout (120s) - user AFK",
          "error",
        );
        throw error;
      }
      // Other errors, just log and continue
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `2FA code entry error: ${getErrorMessage(error)}`,
        "warn",
      );
    } finally {
      try {
        rl.close();
      } catch {
        // Intentionally silent: readline interface already closed or error during cleanup
        // This is a cleanup operation that shouldn't throw
      }
    }
  }

  public async ensureTotpInput(page: Page): Promise<string | null> {
    const selector = await this.findFirstTotpInput(page);
    if (selector) return selector;

    const attempts = 4;
    for (let i = 0; i < attempts; i++) {
      let acted = false;

      // Step 1: expose alternative verification options if hidden
      if (!acted) {
        acted = await this.clickFirstVisibleSelector(
          page,
          TotpHandler.TOTP_SELECTORS.altOptions,
        );
        if (acted) await this.bot.utils.wait(900);
      }

      // Step 2: choose authenticator code option if available
      if (!acted) {
        acted = await this.clickFirstVisibleSelector(
          page,
          TotpHandler.TOTP_SELECTORS.challenge,
        );
        if (acted) await this.bot.utils.wait(900);
      }

      const ready = await this.findFirstTotpInput(page);
      if (ready) return ready;

      if (!acted) break;
    }

    return null;
  }

  private async submitTotpCode(page: Page, selector: string, secret: string) {
    try {
      const code = generateTOTP(secret.trim());
      const input = page.locator(selector).first();
      if (!(await input.isVisible().catch(() => false))) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN",
          "TOTP input unexpectedly hidden",
          "warn",
        );
        return;
      }
      // FIXED: Use HumanTyping instead of .fill() to avoid bot detection
      await HumanTyping.typeTotp(input, code);
      // Use unified selector system
      const submit = await this.findFirstVisibleLocator(
        page,
        TotpHandler.TOTP_SELECTORS.submit,
      );
      if (submit) {
        await submit
          .click()
          .catch(
            logError(
              "LOGIN-TOTP",
              "Auto-submit click failed",
              this.bot.isMobile,
            ),
          );
      } else {
        await page.keyboard
          .press("Enter")
          .catch(
            logError(
              "LOGIN-TOTP",
              "Auto-submit Enter failed",
              this.bot.isMobile,
            ),
          );
      }
      this.bot.log(this.bot.isMobile, "LOGIN", "Submitted TOTP automatically");
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN",
        `Failed to submit TOTP automatically: ${getErrorMessage(error)}`,
        "warn",
      );
    }
  }

  // Locate the most likely authenticator input on the page using heuristics
  private async findFirstTotpInput(page: Page): Promise<string | null> {
    const headingHint = await this.detectTotpHeading(page);
    for (const sel of TotpHandler.TOTP_SELECTORS.input) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        if (await this.isLikelyTotpInput(page, loc, sel, headingHint)) {
          if (sel.includes("floatingLabelInput")) {
            const idAttr = await loc.getAttribute("id");
            if (idAttr) return `#${idAttr}`;
          }
          return sel;
        }
      }
    }
    return null;
  }

  private async isLikelyTotpInput(
    page: Page,
    locator: Locator,
    selector: string,
    headingHint: string | null,
  ): Promise<boolean> {
    try {
      if (!(await locator.isVisible().catch(() => false))) return false;

      const attr = async (name: string) =>
        ((await locator.getAttribute(name)) || "").toLowerCase();
      const type = await attr("type");

      // Explicit exclusions: never treat email or password fields as TOTP
      if (type === "email" || type === "password") return false;

      const nameAttr = await attr("name");
      // Explicit exclusions: login/email/password field names
      if (
        nameAttr.includes("loginfmt") ||
        nameAttr.includes("passwd") ||
        nameAttr.includes("email") ||
        nameAttr.includes("login")
      )
        return false;

      // Strong positive signals for TOTP
      if (
        nameAttr.includes("otc") ||
        nameAttr.includes("otp") ||
        nameAttr.includes("code")
      )
        return true;

      const autocomplete = await attr("autocomplete");
      if (autocomplete.includes("one-time")) return true;

      const inputmode = await attr("inputmode");
      if (inputmode === "numeric") return true;

      const pattern = (await locator.getAttribute("pattern")) || "";
      if (pattern && /\d/.test(pattern)) return true;

      const aria = await attr("aria-label");
      if (
        aria.includes("code") ||
        aria.includes("otp") ||
        aria.includes("authenticator")
      )
        return true;

      const placeholder = await attr("placeholder");
      if (
        placeholder.includes("code") ||
        placeholder.includes("security") ||
        placeholder.includes("authenticator")
      )
        return true;

      if (/otc|otp/.test(selector)) return true;

      const idAttr = await attr("id");
      if (idAttr.startsWith("floatinglabelinput")) {
        if (headingHint || (await this.detectTotpHeading(page))) return true;
      }
      if (selector.toLowerCase().includes("floatinglabelinput")) {
        if (headingHint || (await this.detectTotpHeading(page))) return true;
      }

      const maxLength = await locator.getAttribute("maxlength");
      if (maxLength && Number(maxLength) > 0 && Number(maxLength) <= 8)
        return true;

      const dataTestId = await attr("data-testid");
      if (dataTestId.includes("otc") || dataTestId.includes("otp")) return true;

      const labelText = await locator
        .evaluate((node) => {
          const label = node.closest("label");
          if (label && label.textContent) return label.textContent;
          const describedBy = node.getAttribute("aria-describedby");
          if (!describedBy) return "";
          const parts = describedBy.split(/\s+/).filter(Boolean);
          const texts: string[] = [];
          parts.forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.textContent) texts.push(el.textContent);
          });
          return texts.join(" ");
        })
        .catch(() => "");

      if (
        labelText &&
        /code|otp|authenticator|sécurité|securité|security/i.test(labelText)
      )
        return true;
      if (
        headingHint &&
        /code|otp|authenticator/i.test(headingHint.toLowerCase())
      )
        return true;
    } catch {
      /* fall through to false */
    }

    return false;
  }

  private async detectTotpHeading(page: Page): Promise<string | null> {
    const headings = page.locator(
      '[data-testid="title"], h1, h2, div[role="heading"]',
    );
    const count = await headings.count().catch(() => 0);
    const max = Math.min(count, 6);
    for (let i = 0; i < max; i++) {
      const text = (
        await headings
          .nth(i)
          .textContent()
          .catch(() => null)
      )?.trim();
      if (!text) continue;
      const lowered = text.toLowerCase();
      if (/authenticator/.test(lowered) && /code/.test(lowered)) return text;
      if (
        /code de vérification|code de verification|code de sécurité|code de securité/.test(
          lowered,
        )
      )
        return text;
      if (/enter your security code|enter your code/.test(lowered)) return text;
    }
    return null;
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

  private async findFirstVisibleLocator(
    page: Page,
    selectors: readonly string[],
  ): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  }
}
