import type { Page } from "rebrowser-playwright";
import { MicrosoftRewardsBot } from "../../index";
import { logError } from "../../util/notifications/Logger";
import { SecurityUtils } from "./SecurityUtils";
import { SecurityIncident } from "./types";

export class RecoveryHandler {
  private bot: MicrosoftRewardsBot;
  private securityUtils: SecurityUtils;

  constructor(bot: MicrosoftRewardsBot, securityUtils: SecurityUtils) {
    this.bot = bot;
    this.securityUtils = securityUtils;
  }

  public async tryRecoveryMismatchCheck(page: Page, email: string) {
    try {
      await this.detectAndHandleRecoveryMismatch(page, email);
    } catch {
      // Intentionally silent: Recovery mismatch check is a best-effort security check
      // Failure here should not break the login flow as the page may simply not have recovery info
    }
  }

  private async detectAndHandleRecoveryMismatch(page: Page, email: string) {
    try {
      const recoveryEmail: string | undefined =
        this.bot.currentAccountRecoveryEmail;
      if (!recoveryEmail || !/@/.test(recoveryEmail)) return;
      const accountEmail = email;
      const parseRef = (val: string) => {
        const [l, d] = val.split("@");
        return {
          local: l || "",
          domain: (d || "").toLowerCase(),
          prefix2: (l || "").slice(0, 2).toLowerCase(),
        };
      };
      const refs = [parseRef(recoveryEmail), parseRef(accountEmail)].filter(
        (r) => r.domain && r.prefix2,
      );
      if (refs.length === 0) return;

      const candidates: string[] = [];
      // Direct selectors (Microsoft variants + French spans)
      const sel =
        '[data-testid="recoveryEmailHint"], #recoveryEmail, [id*="ProofEmail"], [id*="EmailProof"], [data-testid*="Email"], span:has(span.fui-Text)';
      const el = await page
        .waitForSelector(sel, { timeout: 1500 })
        .catch(() => null);
      if (el) {
        const t = ((await el.textContent()) || "").trim();
        if (t) candidates.push(t);
      }

      // List items
      const li = page.locator('[role="listitem"], li');
      const liCount = await li.count().catch(() => 0);
      for (let i = 0; i < liCount && i < 12; i++) {
        const t =
          (
            await li
              .nth(i)
              .textContent()
              .catch(() => "")
          )?.trim() || "";
        if (t && /@/.test(t)) candidates.push(t);
      }

      // XPath generic masked patterns
      const xp = page.locator(
        'xpath=//*[contains(normalize-space(.), "@") and (contains(normalize-space(.), "*") or contains(normalize-space(.), "•"))]',
      );
      const xpCount = await xp.count().catch(() => 0);
      for (let i = 0; i < xpCount && i < 12; i++) {
        const t =
          (
            await xp
              .nth(i)
              .textContent()
              .catch(() => "")
          )?.trim() || "";
        if (t && t.length < 300) candidates.push(t);
      }

      // Normalize
      const seen = new Set<string>();
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const uniq = candidates
        .map(norm)
        .filter((t) => t && !seen.has(t) && seen.add(t));
      // Masked filter
      let masked = uniq.filter((t) => /@/.test(t) && /[*•]/.test(t));

      if (masked.length === 0) {
        // Fallback full HTML scan
        try {
          const html = await page.content();
          const generic =
            /[A-Za-z0-9]{1,4}[*•]{2,}[A-Za-z0-9*•._-]*@[A-Za-z0-9.-]+/g;
          const frPhrase =
            /Nous\s+enverrons\s+un\s+code\s+à\s+([^<@]*[A-Za-z0-9]{1,4}[*•]{2,}[A-Za-z0-9*•._-]*@[A-Za-z0-9.-]+)[^.]{0,120}?Pour\s+vérifier/gi;
          const found = new Set<string>();
          let m: RegExpExecArray | null;
          while ((m = generic.exec(html)) !== null) found.add(m[0]);
          while ((m = frPhrase.exec(html)) !== null) {
            const raw = m[1]?.replace(/<[^>]+>/g, "").trim();
            if (raw) found.add(raw);
          }
          if (found.size > 0) masked = Array.from(found);
        } catch {
          /* HTML parsing may fail on malformed content */
        }
      }
      if (masked.length === 0) return;

      // Prefer one mentioning email/adresse
      const preferred =
        masked.find((t) => /email|courriel|adresse|mail/i.test(t)) ||
        masked[0]!;
      // Extract the masked email: Microsoft sometimes shows only first 1 char (k*****@domain) or 2 chars (ko*****@domain).
      // We ONLY compare (1 or 2) leading visible alphanumeric chars + full domain (case-insensitive).
      // This avoids false positives when the displayed mask hides the 2nd char.
      const maskRegex =
        /([a-zA-Z0-9]{1,2})[a-zA-Z0-9*•._-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
      const m = maskRegex.exec(preferred);
      // Fallback: try to salvage with looser pattern if first regex fails
      const loose = !m
        ? /([a-zA-Z0-9])[*•][a-zA-Z0-9*•._-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(
            preferred,
          )
        : null;
      const use = m || loose;
      const extracted = use ? use[0] : preferred;
      const extractedLower = extracted.toLowerCase();
      let observedPrefix = (use && use[1] ? use[1] : "").toLowerCase();
      let observedDomain = (use && use[2] ? use[2] : "").toLowerCase();
      if (!observedDomain && extractedLower.includes("@")) {
        const parts = extractedLower.split("@");
        observedDomain = parts[1] || "";
      }
      if (!observedPrefix && extractedLower.includes("@")) {
        const parts = extractedLower.split("@");
        observedPrefix = (parts[0] || "")
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 2);
      }

      // Determine if any reference (recoveryEmail or accountEmail) matches observed mask logic
      const matchRef = refs.find((r) => {
        if (r.domain !== observedDomain) return false;
        // If only one char visible, only enforce first char; if two, enforce both.
        if (observedPrefix.length === 1) {
          return r.prefix2.startsWith(observedPrefix);
        }
        return r.prefix2 === observedPrefix;
      });

      if (!matchRef) {
        const docsUrl = this.securityUtils.getDocsUrl(
          "recovery-email-mismatch",
        );
        const incident: SecurityIncident = {
          kind: "Recovery email mismatch",
          account: email,
          details: [
            `MaskedShown: ${preferred}`,
            `Extracted: ${extracted}`,
            `Observed => ${observedPrefix || "??"}**@${observedDomain || "??"}`,
            `Expected => ${refs.map((r) => `${r.prefix2}**@${r.domain}`).join(" OR ")}`,
          ],
          next: [
            "Automation halted globally (standby engaged).",
            "Verify account security & recovery email in Microsoft settings.",
            "Update accounts.json if the change was legitimate before restart.",
          ],
          docsUrl,
        };
        await this.securityUtils.sendIncidentAlert(incident, "critical");
        this.bot.compromisedModeActive = true;
        this.bot.compromisedReason = "recovery-mismatch";
        this.securityUtils.startCompromisedInterval();
        await this.bot
          .engageGlobalStandby("recovery-mismatch", email)
          .catch(
            logError(
              "LOGIN-RECOVERY",
              "Global standby failed",
              this.bot.isMobile,
            ),
          );
        await this.securityUtils
          .openDocsTab(page, docsUrl)
          .catch(
            logError(
              "LOGIN-RECOVERY",
              "Failed to open docs tab",
              this.bot.isMobile,
            ),
          );
      } else {
        const mode = observedPrefix.length === 1 ? "lenient" : "strict";
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-RECOVERY",
          `Recovery OK (${mode}): ${extracted} matches ${matchRef.prefix2}**@${matchRef.domain}`,
        );
      }
    } catch {
      /* Non-critical: Recovery email validation is best-effort */
    }
  }
}
