/**
 * Summary Reporter Module
 * Extracted from index.ts to improve maintainability and testability
 *
 * Handles reporting and notifications:
 * - Points collection summaries
 * - Webhook notifications
 * - Ntfy push notifications
 * - Job state updates
 * - Account history tracking (all-time stats)
 */

import { DISCORD } from "../constants";
import { Account } from "../interface/Account";
import type { Config } from "../interface/Config";
import { getErrorMessage } from "../util/core/Utils";
import { sendSummaryWebhook } from "../util/notifications/ConclusionWebhook";
import { log } from "../util/notifications/Logger";
import { Ntfy } from "../util/notifications/Ntfy";
import {
    AccountHistory,
    AccountHistoryEntry,
} from "../util/state/AccountHistory";
import {
    getActivityStatsTracker,
    resetActivityStatsTracker,
} from "../util/state/ActivityStatsTracker";
import { JobState } from "../util/state/JobState";

export interface AccountResult {
  email: string;
  pointsEarned: number;
  runDuration: number;
  initialPoints: number; // Points before execution
  finalPoints: number; // Points after execution
  desktopPoints: number; // Points earned on desktop
  mobilePoints: number; // Points earned on mobile
  errors?: string[];
  banned?: boolean;
}

export interface SummaryData {
  accounts: AccountResult[];
  startTime: Date;
  endTime: Date;
  totalPoints: number;
  successCount: number;
  failureCount: number;
}

export class SummaryReporter {
  private config: Config;
  private jobState?: JobState;
  private accountHistory: AccountHistory;

  constructor(config: Config, accounts: Account[]) {
    this.config = config;
    if (config.jobState?.enabled !== false) {
      this.jobState = new JobState(config);
    }
    this.accountHistory = new AccountHistory(accounts);
  }

  /**
   * Send comprehensive summary via webhook with complete statistics
   */
  async sendWebhookSummary(summary: SummaryData): Promise<void> {
    if (
      !this.config.webhook?.enabled &&
      !this.config.summaryWebhook?.enabled &&
      !this.config.conclusionWebhook?.enabled &&
      !this.config.stoat?.enabled
    ) {
      return;
    }

    try {
      const duration = Math.round(
        (summary.endTime.getTime() - summary.startTime.getTime()) / 1000,
      );
      const hours = Math.floor(duration / 3600);
      const minutes = Math.floor((duration % 3600) / 60);
      const seconds = duration % 60;

      const durationText =
        hours > 0
          ? `${hours}h ${minutes}m ${seconds}s`
          : minutes > 0
            ? `${minutes}m ${seconds}s`
            : `${seconds}s`;

      // Calculate global statistics
      const totalDesktop = summary.accounts.reduce(
        (sum, acc) => sum + acc.desktopPoints,
        0,
      );
      const totalMobile = summary.accounts.reduce(
        (sum, acc) => sum + acc.mobilePoints,
        0,
      );
      const totalInitial = summary.accounts.reduce(
        (sum, acc) => sum + acc.initialPoints,
        0,
      );
      const totalFinal = summary.accounts.reduce(
        (sum, acc) => sum + acc.finalPoints,
        0,
      );
      const bannedCount = summary.accounts.filter((acc) => acc.banned).length;

      // Build clean, Discord-optimized description
      let description = `**⏱️ Duration:** ${durationText}\n`;
      description += `**💰 Total Earned:** ${summary.totalPoints} points\n`;
      description += `**🖥️ Desktop:** ${totalDesktop} pts | **📱 Mobile:** ${totalMobile} pts\n`;
      description += `**✅ Success:** ${summary.successCount}/${summary.accounts.length}`;

      if (summary.failureCount > 0) {
        description += ` | **❌ Failed:** ${summary.failureCount}`;
      }
      if (bannedCount > 0) {
        description += ` | **🚫 Banned:** ${bannedCount}`;
      }

      description += "\n\n**📊 Account Details**\n";

      const accountsWithErrors: AccountResult[] = [];

      for (const account of summary.accounts) {
        const status = account.banned
          ? "🚫"
          : account.errors?.length
            ? "❌"
            : "✅";
        const emailShort =
          account.email.length > 35
            ? account.email.substring(0, 32) + "..."
            : account.email;
        const durationSec = Math.round(account.runDuration / 1000);

        description += `\n${status} **${emailShort}**\n`;
        description += `• Points: **+${account.pointsEarned}** (🖥️ ${account.desktopPoints} | 📱 ${account.mobilePoints})\n`;
        description += `• Balance: ${account.initialPoints} → **${account.finalPoints}** pts\n`;
        description += `• Duration: ${durationSec}s\n`;

        // Collect accounts with errors for separate webhook
        if (this.hasAccountFailure(account)) {
          accountsWithErrors.push(account);
        }
      }

      // Footer summary
      description += "\n**🌐 Total Balance**\n";
      description += `${totalInitial} → **${totalFinal}** pts (+${summary.totalPoints})`;

      const color =
        bannedCount > 0
          ? DISCORD.COLOR_RED
          : summary.failureCount > 0
            ? DISCORD.COLOR_ORANGE
            : DISCORD.COLOR_GREEN;

      // Send main summary webhook
      await sendSummaryWebhook(
        this.config,
        "🎉 Daily Rewards Collection Complete",
        description,
        undefined,
        color,
      );

      // Send separate error report if there are accounts with issues
      if (accountsWithErrors.length > 0) {
        await this.sendErrorReport(accountsWithErrors);
      }
    } catch (error) {
      log(
        "main",
        "SUMMARY",
        `Failed to send webhook: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Send separate webhook for accounts with errors or bans
   */
  private async sendErrorReport(accounts: AccountResult[]): Promise<void> {
    try {
      let errorDescription = `**${accounts.length} account(s) encountered issues:**\n\n`;

      for (const account of accounts) {
        const status = account.banned ? "🚫 BANNED" : "❌ ERROR";
        const emailShort =
          account.email.length > 40
            ? account.email.substring(0, 37) + "..."
            : account.email;

        errorDescription += `${status} **${emailShort}**\n`;
        errorDescription += `• Progress: ${account.pointsEarned} pts (🖥️ ${account.desktopPoints} | 📱 ${account.mobilePoints})\n`;

        // Error details
        if (account.banned) {
          errorDescription += "• Status: Account Banned/Suspended\n";
          if (account.errors?.length && account.errors[0]) {
            errorDescription += `• Reason: ${account.errors[0]}\n`;
          }
        } else if (account.errors?.length && account.errors[0]) {
          errorDescription += `• Error: ${account.errors[0]}\n`;
        }

        errorDescription += "\n";
      }

      errorDescription += "**📋 Recommended Actions:**\n";
      errorDescription += "• Check account status manually\n";
      errorDescription += "• Review error messages above\n";
      errorDescription += "• Verify credentials if login failed\n";
      errorDescription += "• Consider proxy rotation if rate-limited";

      await sendSummaryWebhook(
        this.config,
        "⚠️ Execution Errors & Warnings",
        errorDescription,
        undefined,
        DISCORD.COLOR_RED,
      );
    } catch (error) {
      log(
        "main",
        "SUMMARY",
        `Failed to send error report webhook: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Send push notification via Ntfy
   */
  async sendPushNotification(summary: SummaryData): Promise<void> {
    if (!this.config.ntfy?.enabled) {
      return;
    }

    try {
      const message = `Collected ${summary.totalPoints} points across ${summary.accounts.length} account(s). Success: ${summary.successCount}, Failed: ${summary.failureCount}`;

      await Ntfy(message, summary.failureCount > 0 ? "warn" : "log");
    } catch (error) {
      log(
        "main",
        "SUMMARY",
        `Failed to send Ntfy notification: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Update job state with completion status
   */
  async updateJobState(summary: SummaryData): Promise<void> {
    if (!this.jobState) {
      return;
    }

    try {
      const day = summary.endTime.toISOString().split("T")?.[0];
      if (!day) return;

      for (const account of summary.accounts) {
        this.jobState.markAccountComplete(account.email, day, {
          totalCollected: account.pointsEarned,
          banned: account.banned ?? false,
          errors: account.errors?.length ?? 0,
        });
      }
    } catch (error) {
      log(
        "main",
        "SUMMARY",
        `Failed to update job state: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Generate and send comprehensive summary
   */
  async generateReport(summary: SummaryData): Promise<void> {
    log("main", "SUMMARY", "═".repeat(80));
    log("main", "SUMMARY", "📊 EXECUTION SUMMARY");
    log("main", "SUMMARY", "═".repeat(80));

    const duration = Math.round(
      (summary.endTime.getTime() - summary.startTime.getTime()) / 1000,
    );
    log(
      "main",
      "SUMMARY",
      `⏱️  Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`,
    );
    log("main", "SUMMARY", `📈 Total Points Collected: ${summary.totalPoints}`);
    log(
      "main",
      "SUMMARY",
      `✅ Successful Accounts: ${summary.successCount}/${summary.accounts.length}`,
    );

    if (summary.failureCount > 0) {
      log(
        "main",
        "SUMMARY",
        `❌ Failed Accounts: ${summary.failureCount}`,
        "warn",
      );
    }

    log("main", "SUMMARY", "─".repeat(80));
    log("main", "SUMMARY", "Account Breakdown:");
    log("main", "SUMMARY", "─".repeat(80));

    for (const account of summary.accounts) {
      const status = this.hasAccountFailure(account)
        ? account.banned
          ? "🚫 BANNED"
          : "❌ FAILED"
        : "✅ SUCCESS";
      const duration = Math.round(account.runDuration / 1000);

      log("main", "SUMMARY", `${status} | ${account.email}`);
      log(
        "main",
        "SUMMARY",
        `   Points: ${account.pointsEarned} | Duration: ${duration}s`,
      );

      if (account.banned) {
        log(
          "main",
          "SUMMARY",
          "   Status: Account flagged as banned/suspended",
          "error",
        );
      } else if (account.errors?.length) {
        log("main", "SUMMARY", `   Error: ${account.errors[0]}`, "error");
      }
    }

    log("main", "SUMMARY", "═".repeat(80));

    // Log activity statistics
    this.logActivityStats();

    // Save to account history (all-time tracking)
    this.saveToHistory(summary);

    // Send notifications
    await Promise.all([
      this.sendWebhookSummary(summary),
      this.sendPushNotification(summary),
      this.updateJobState(summary),
    ]);

    // Reset activity stats for next run
    resetActivityStatsTracker();
  }

  /**
   * Save account results to history for all-time tracking
   */
  private saveToHistory(summary: SummaryData): void {
    try {
      const today = new Date().toISOString().slice(0, 10);

      for (const account of summary.accounts) {
        // Get activity stats for this account
        const tracker = getActivityStatsTracker();
        const completedActivities: string[] = [];
        const failedActivities: string[] = [];

        // Extract activity completion status from tracker
        tracker.getSummary().byActivity.forEach((activity) => {
          if (activity.successes > 0) {
            completedActivities.push(activity.type);
          }
          if (activity.failures > 0) {
            failedActivities.push(activity.type);
          }
        });

        const entry: AccountHistoryEntry = {
          timestamp: new Date().toISOString(),
          date: today,
          desktopPoints: account.desktopPoints,
          mobilePoints: account.mobilePoints,
          totalPoints: account.pointsEarned,
          availablePoints: account.finalPoints,
          lifetimePoints: account.finalPoints, // Approximation
          dailyGoalProgress: 0, // Could extract from dashboard data
          completedActivities,
          failedActivities,
          errors: account.errors || [],
          duration: account.runDuration,
          success: !this.hasAccountFailure(account),
        };

        this.accountHistory.addEntry(account.email, entry);
      }

      log(
        "main",
        "SUMMARY",
        `✓ Saved history for ${summary.accounts.length} account(s)`,
      );
    } catch (error) {
      log(
        "main",
        "SUMMARY",
        `Failed to save account history: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Log activity success/failure statistics
   */
  private logActivityStats(): void {
    const tracker = getActivityStatsTracker();
    const summary = tracker.getSummary();

    if (summary.totalAttempts === 0) {
      return;
    }

    log("main", "SUMMARY", "─".repeat(80));
    log("main", "SUMMARY", "📈 Activity Statistics:");
    log(
      "main",
      "SUMMARY",
      `   Total: ${summary.totalSuccesses}/${summary.totalAttempts} succeeded (${(summary.overallSuccessRate * 100).toFixed(1)}%)`,
    );

    // Show per-activity breakdown if there are multiple activity types
    if (summary.byActivity.length > 1) {
      for (const activity of summary.byActivity) {
        const rate = (activity.successRate * 100).toFixed(0);
        const avgTime = (activity.avgDurationMs / 1000).toFixed(1);
        log(
          "main",
          "SUMMARY",
          `   ${activity.type}: ${activity.successes}/${activity.attempts} (${rate}%) avg ${avgTime}s`,
        );
      }
    }

    // Warn about problematic activities
    const problematic = tracker.getProblematicActivities();
    if (problematic.length > 0) {
      log("main", "SUMMARY", "⚠️ High Failure Activities:", "warn");
      for (const p of problematic) {
        log(
          "main",
          "SUMMARY",
          `   ${p.type}: ${(p.failureRate * 100).toFixed(0)}% failure rate (${p.attempts} attempts)`,
          "warn",
        );
      }
    }
  }

  /**
   * Create summary data structure from account results
   */
  createSummary(
    accounts: AccountResult[],
    startTime: Date,
    endTime: Date,
  ): SummaryData {
    const totalPoints = accounts.reduce(
      (sum, acc) => sum + acc.pointsEarned,
      0,
    );
    const failureCount = accounts.filter((acc) =>
      this.hasAccountFailure(acc),
    ).length;
    const successCount = accounts.length - failureCount;

    return {
      accounts,
      startTime,
      endTime,
      totalPoints,
      successCount,
      failureCount,
    };
  }

  private hasAccountFailure(account: AccountResult): boolean {
    return Boolean(account.errors?.length) || account.banned === true;
  }
}
