/**
 * AccountHistory - Persistent account statistics and history tracking
 *
 * Stores historical data per account in sessions/account-history/
 * Auto-cleans removed accounts from configuration
 */

import fs from "fs";
import path from "path";
import { Account } from "../../interface/Account";

export interface AccountHistoryEntry {
  timestamp: string;
  date: string; // YYYY-MM-DD
  desktopPoints: number;
  mobilePoints: number;
  totalPoints: number;
  availablePoints: number;
  lifetimePoints: number;
  dailyGoalProgress: number;
  completedActivities: string[];
  failedActivities: string[];
  errors: string[];
  duration: number; // milliseconds
  success: boolean;
}

interface AccountHistoryData {
  email: string;
  createdAt: string;
  updatedAt: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalPointsEarned: number;
  averagePointsPerRun: number;
  lastRunDate?: string;
  history: AccountHistoryEntry[];
}

export class AccountHistory {
  private historyDir: string;
  private accounts: Account[];

  constructor(accounts: Account[]) {
    this.accounts = accounts;
    this.historyDir = path.join(process.cwd(), "sessions", "account-history");
    this.ensureHistoryDir();
    this.cleanupRemovedAccounts();
  }

  private ensureHistoryDir(): void {
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  private getHistoryFilePath(email: string): string {
    // Sanitize email for filename (replace @ and special chars)
    const sanitized = email.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.historyDir, `${sanitized}.json`);
  }

  private cleanupRemovedAccounts(): void {
    // Get all history files
    if (!fs.existsSync(this.historyDir)) return;

    const files = fs.readdirSync(this.historyDir);
    const activeEmails = this.accounts.map((acc) => acc.email);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(this.historyDir, file);
      try {
        const data = this.loadHistory(filePath);
        if (data && !activeEmails.includes(data.email)) {
          fs.unlinkSync(filePath);
          // Silent: Removed account cleanup is internal maintenance
        }
      } catch (error) {
        // Expected: Invalid history files may exist from previous versions
      }
    }
  }

  private loadHistory(filePath: string): AccountHistoryData | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content) as AccountHistoryData;
    } catch (error) {
      // Expected: File may be corrupted or from incompatible version
      return null;
    }
  }

  public getAccountHistory(email: string): AccountHistoryData {
    const filePath = this.getHistoryFilePath(email);
    const existing = this.loadHistory(filePath);

    if (existing) {
      return existing;
    }

    // Create new history
    const newHistory: AccountHistoryData = {
      email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalPointsEarned: 0,
      averagePointsPerRun: 0,
      history: [],
    };

    this.saveHistory(email, newHistory);
    return newHistory;
  }

  public addEntry(email: string, entry: AccountHistoryEntry): void {
    const history = this.getAccountHistory(email);

    // Add new entry
    history.history.push(entry);

    // Update aggregates
    history.totalRuns++;
    if (entry.success) {
      history.successfulRuns++;
    } else {
      history.failedRuns++;
    }

    history.totalPointsEarned += entry.desktopPoints + entry.mobilePoints;
    history.averagePointsPerRun = history.totalPointsEarned / history.totalRuns;
    history.lastRunDate = entry.date;
    history.updatedAt = new Date().toISOString();

    // Keep only last 90 days of history (to prevent file bloat)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    history.history = history.history.filter(
      (e) => new Date(e.timestamp) >= ninetyDaysAgo,
    );

    this.saveHistory(email, history);
  }

  private saveHistory(email: string, data: AccountHistoryData): void {
    const filePath = this.getHistoryFilePath(email);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      // Non-critical: History persistence failure doesn't affect bot operation
    }
  }

  public getAllHistories(): Record<string, AccountHistoryData> {
    const result: Record<string, AccountHistoryData> = {};

    for (const account of this.accounts) {
      result[account.email] = this.getAccountHistory(account.email);
    }

    return result;
  }

  public getStats(email: string): {
    totalRuns: number;
    successRate: number;
    avgPointsPerDay: number;
    totalPoints: number;
    last7Days: number;
    last30Days: number;
  } {
    const history = this.getAccountHistory(email);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const last7DaysEntries = history.history.filter(
      (e) => new Date(e.timestamp) >= sevenDaysAgo,
    );
    const last30DaysEntries = history.history.filter(
      (e) => new Date(e.timestamp) >= thirtyDaysAgo,
    );

    const last7DaysPoints = last7DaysEntries.reduce(
      (sum, e) => sum + e.desktopPoints + e.mobilePoints,
      0,
    );
    const last30DaysPoints = last30DaysEntries.reduce(
      (sum, e) => sum + e.desktopPoints + e.mobilePoints,
      0,
    );

    const successRate =
      history.totalRuns > 0
        ? (history.successfulRuns / history.totalRuns) * 100
        : 0;

    const avgPointsPerDay =
      history.history.length > 0
        ? history.totalPointsEarned / history.history.length
        : 0;

    return {
      totalRuns: history.totalRuns,
      successRate: Math.round(successRate * 100) / 100,
      avgPointsPerDay: Math.round(avgPointsPerDay),
      totalPoints: history.totalPointsEarned,
      last7Days: last7DaysPoints,
      last30Days: last30DaysPoints,
    };
  }
}
