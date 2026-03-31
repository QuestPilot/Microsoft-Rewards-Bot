import type { Page } from "rebrowser-playwright";
import { DISCORD } from "../../constants";
import { MicrosoftRewardsBot } from "../../index";
import { SecurityIncident } from "./types";

export class SecurityUtils {
  private bot: MicrosoftRewardsBot;
  private compromisedInterval?: NodeJS.Timeout;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  public async sendIncidentAlert(
    incident: SecurityIncident,
    severity: "warn" | "critical" = "warn",
  ) {
    const lines = [
      `[Incident] ${incident.kind}`,
      `Account: ${incident.account}`,
    ];
    if (incident.details?.length)
      lines.push(`Details: ${incident.details.join(" | ")}`);
    if (incident.next?.length)
      lines.push(`Next: ${incident.next.join(" -> ")}`);
    if (incident.docsUrl) lines.push(`Docs: ${incident.docsUrl}`);
    const level: "warn" | "error" = severity === "critical" ? "error" : "warn";
    this.bot.log(this.bot.isMobile, "SECURITY", lines.join(" | "), level);
    try {
      const { sendSummaryWebhook } =
        await import("../../util/notifications/ConclusionWebhook");
      const fields = [
        { name: "Account", value: incident.account },
        ...(incident.details?.length
          ? [{ name: "Details", value: incident.details.join("\n") }]
          : []),
        ...(incident.next?.length
          ? [{ name: "Next steps", value: incident.next.join("\n") }]
          : []),
        ...(incident.docsUrl
          ? [{ name: "Docs", value: incident.docsUrl }]
          : []),
      ];
      await sendSummaryWebhook(
        this.bot.config,
        `🔐 ${incident.kind}`,
        Array.isArray(incident.details)
          ? incident.details.join("\n")
          : incident.details || "Security check detected unusual activity",
        fields,
        severity === "critical" ? DISCORD.COLOR_RED : DISCORD.COLOR_ORANGE,
      );
    } catch {
      /* Non-critical: Webhook notification failures don't block login flow */
    }
  }

  public getDocsUrl(anchor?: string) {
    const base =
      process.env.DOCS_BASE?.trim() ||
      "https://github.com/LightZirconite/Microsoft-Rewards-Bot/blob/main/docs/security.md";
    const map: Record<string, string> = {
      "recovery-email-mismatch": "#recovery-email-mismatch",
      "we-cant-sign-you-in": "#we-cant-sign-you-in-blocked",
    };
    return anchor && map[anchor] ? `${base}${map[anchor]}` : base;
  }

  public startCompromisedInterval() {
    this.cleanupCompromisedInterval();
    this.compromisedInterval = setInterval(() => {
      try {
        this.bot.log(
          this.bot.isMobile,
          "SECURITY",
          "Security standby active. Manual review required before proceeding.",
          "warn",
        );
      } catch {
        // Intentionally silent
      }
    }, 300000); // 5 minutes
  }

  public cleanupCompromisedInterval() {
    if (this.compromisedInterval) {
      clearInterval(this.compromisedInterval);
      this.compromisedInterval = undefined;
    }
  }

  public async openDocsTab(page: Page, url: string) {
    try {
      const ctx = page.context();
      const tab = await ctx.newPage();
      await tab.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      /* Non-critical */
    }
  }
}
