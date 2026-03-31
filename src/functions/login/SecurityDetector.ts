import type { Page } from "rebrowser-playwright";
import { MicrosoftRewardsBot } from "../../index";
import { logError } from "../../util/notifications/Logger";
import { SecurityUtils } from "./SecurityUtils";
import { SecurityIncident } from "./types";

export class SecurityDetector {
  private bot: MicrosoftRewardsBot;
  private securityUtils: SecurityUtils;

  private static readonly SIGN_IN_BLOCK_PATTERNS: {
    re: RegExp;
    label: string;
  }[] = [
    { re: /we can['’`]?t sign you in/i, label: "cant-sign-in" },
    {
      re: /incorrect account or password too many times/i,
      label: "too-many-incorrect",
    },
    {
      re: /used an incorrect account or password too many times/i,
      label: "too-many-incorrect-variant",
    },
    { re: /sign-in has been blocked/i, label: "sign-in-blocked-phrase" },
    { re: /your account has been locked/i, label: "account-locked" },
  ];

  constructor(bot: MicrosoftRewardsBot, securityUtils: SecurityUtils) {
    this.bot = bot;
    this.securityUtils = securityUtils;
  }

  public async detectSignInBlocked(page: Page): Promise<boolean> {
    if (
      this.bot.compromisedModeActive &&
      this.bot.compromisedReason === "sign-in-blocked"
    )
      return true;
    try {
      let text = "";
      for (const sel of [
        '[data-testid="title"]',
        "h1",
        'div[role="heading"]',
        "div.text-title",
      ]) {
        const el = await page
          .waitForSelector(sel, { timeout: 600 })
          .catch(() => null);
        if (el) {
          const t = ((await el.textContent()) || "").trim();
          if (t && t.length < 300) text += " " + t;
        }
      }
      const lower = text.toLowerCase();
      let matched: string | null = null;
      for (const p of SecurityDetector.SIGN_IN_BLOCK_PATTERNS) {
        if (p.re.test(lower)) {
          matched = p.label;
          break;
        }
      }
      if (!matched) return false;
      const email = this.bot.currentAccountEmail || "unknown";
      const docsUrl = this.securityUtils.getDocsUrl("we-cant-sign-you-in");
      const incident: SecurityIncident = {
        kind: "We can't sign you in (blocked)",
        account: email,
        details: [matched ? `Pattern: ${matched}` : "Pattern: unknown"],
        next: ["Manual recovery required before continuing"],
        docsUrl,
      };
      await this.securityUtils.sendIncidentAlert(incident, "warn");
      this.bot.compromisedModeActive = true;
      this.bot.compromisedReason = "sign-in-blocked";
      this.securityUtils.startCompromisedInterval();
      await this.bot
        .engageGlobalStandby("sign-in-blocked", email)
        .catch(
          logError(
            "LOGIN-SECURITY",
            "Global standby engagement failed",
            this.bot.isMobile,
          ),
        );
      // Open security docs for immediate guidance (best-effort)
      await this.securityUtils
        .openDocsTab(page, docsUrl)
        .catch(
          logError(
            "LOGIN-SECURITY",
            "Failed to open docs tab",
            this.bot.isMobile,
          ),
        );
      return true;
    } catch {
      return false;
    }
  }

  public async checkAccountLocked(page: Page) {
    const locked = await page
      .waitForSelector("#serviceAbuseLandingTitle", { timeout: 1200 })
      .then(() => true)
      .catch(() => false);
    if (locked) {
      this.bot.log(
        this.bot.isMobile,
        "CHECK-LOCKED",
        "Account locked by Microsoft (serviceAbuseLandingTitle)",
        "error",
      );
      throw new Error(
        "Account locked by Microsoft - please review account status",
      );
    }
  }

  /**
   * Check if account is suspended/banned and disable it in accounts.jsonc
   * @param page Playwright page
   * @returns True if account is suspended
   */
  public async checkAccountSuspended(page: Page): Promise<boolean> {
    try {
      // Check for suspension page elements
      const suspendedSelectors = [
        "#rewards-user-suspended-error",
        "#fraudErrorBody",
        "#suspendedAccountHeader",
      ];

      for (const selector of suspendedSelectors) {
        const element = await page
          .waitForSelector(selector, { timeout: 800 })
          .catch(() => null);
        if (element) {
          const email = this.bot.currentAccountEmail || "unknown";
          this.bot.log(
            this.bot.isMobile,
            "ACCOUNT-SUSPENDED",
            `⛔ Account ${email} has been SUSPENDED by Microsoft`,
            "error",
          );

          // Get suspension details from page
          const headerText = await page
            .locator("#suspendedAccountHeader")
            .textContent()
            .catch(() => "");
          const summaryText = await page
            .locator("#fraudSummary")
            .textContent()
            .catch(() => "");

          // Log detailed information
          if (headerText) {
            this.bot.log(
              this.bot.isMobile,
              "ACCOUNT-SUSPENDED",
              `Header: ${headerText.trim()}`,
              "error",
            );
          }
          if (summaryText) {
            this.bot.log(
              this.bot.isMobile,
              "ACCOUNT-SUSPENDED",
              `Summary: ${summaryText.trim().substring(0, 200)}...`,
              "error",
            );
          }

          // Disable account in accounts.jsonc
          try {
            const { disableBannedAccount } =
              await import("../../util/state/AccountDisabler");
            await disableBannedAccount(
              email,
              "Account suspended by Microsoft Rewards",
            );
            this.bot.log(
              this.bot.isMobile,
              "ACCOUNT-SUSPENDED",
              `✓ Account ${email} disabled in accounts.jsonc`,
              "warn",
            );
          } catch (disableError) {
            this.bot.log(
              this.bot.isMobile,
              "ACCOUNT-SUSPENDED",
              `Failed to disable account in config: ${disableError}`,
              "error",
            );
          }

          // Send incident alert
          const incident: SecurityIncident = {
            kind: "Account Suspended",
            account: email,
            details: [
              headerText?.trim() || "Account suspended",
              summaryText?.trim().substring(0, 300) ||
                "Microsoft Rewards violations detected",
            ],
            next: [
              "Account has been automatically disabled in accounts.jsonc",
              "Review suspension details at https://rewards.bing.com",
              "Contact Microsoft Support if you believe this is an error",
            ],
            docsUrl:
              "https://support.microsoft.com/topic/c5ab735d-c6d9-4bb9-30ad-d828e954b6a9",
          };
          await this.securityUtils.sendIncidentAlert(incident, "critical");

          // Engage global standby
          this.bot.compromisedModeActive = true;
          this.bot.compromisedReason = "account-suspended";
          this.securityUtils.startCompromisedInterval();
          await this.bot
            .engageGlobalStandby("account-suspended", email)
            .catch(
              logError(
                "LOGIN-SECURITY",
                "Global standby engagement failed",
                this.bot.isMobile,
              ),
            );

          return true;
        }
      }

      return false;
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "ACCOUNT-SUSPENDED",
        `Check failed: ${error}`,
        "warn",
      );
      return false;
    }
  }
}
