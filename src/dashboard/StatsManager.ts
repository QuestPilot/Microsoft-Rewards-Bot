/**
 * StatsManager - Persistent dashboard statistics system
 * Saves all metrics to JSON files for persistence across restarts
 */

import fs from "fs";
import path from "path";
import { getErrorMessage } from "../util/core/Utils";
import { log } from "../util/notifications/Logger";

interface DailyStats {
  date: string; // ISO date (YYYY-MM-DD)
  totalPoints: number;
  accountsCompleted: number;
  accountsWithErrors: number;
  totalSearches: number;
  totalActivities: number;
  runDuration: number; // milliseconds
}

interface AccountDailyStats {
  email: string;
  date: string;
  pointsEarned: number;
  desktopSearches: number;
  mobileSearches: number;
  activitiesCompleted: number;
  errors: string[];
  completedAt?: string; // ISO timestamp
}

interface GlobalStats {
  totalRunsAllTime: number;
  totalPointsAllTime: number;
  averagePointsPerDay: number;
  lastRunDate?: string;
  firstRunDate?: string;
}

class StatsManager {
  private statsDir: string;
  private dailyStatsPath: string;
  private globalStatsPath: string;

  constructor() {
    this.statsDir = path.join(process.cwd(), "sessions", "dashboard-stats");
    this.dailyStatsPath = path.join(this.statsDir, "daily");
    this.globalStatsPath = path.join(this.statsDir, "global.json");

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.statsDir)) {
      fs.mkdirSync(this.statsDir, { recursive: true });
    }
    if (!fs.existsSync(this.dailyStatsPath)) {
      fs.mkdirSync(this.dailyStatsPath, { recursive: true });
    }
    if (!fs.existsSync(this.globalStatsPath)) {
      this.saveGlobalStats({
        totalRunsAllTime: 0,
        totalPointsAllTime: 0,
        averagePointsPerDay: 0,
      });
    }
  }

  /**
   * Save daily stats (one file per day)
   */
  saveDailyStats(stats: DailyStats): void {
    try {
      const filePath = path.join(this.dailyStatsPath, `${stats.date}.json`);
      fs.writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf-8");
    } catch (error) {
      log(
        "main",
        "STATS",
        `Failed to save daily stats: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Load daily stats for specific date
   */
  loadDailyStats(date: string): DailyStats | null {
    try {
      const filePath = path.join(this.dailyStatsPath, `${date}.json`);
      if (!fs.existsSync(filePath)) return null;

      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as DailyStats;
    } catch {
      return null;
    }
  }

  /**
   * Get stats for last N days
   */
  getLastNDays(days: number): DailyStats[] {
    const result: DailyStats[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);

      const stats = this.loadDailyStats(dateStr);
      if (stats) {
        result.push(stats);
      } else {
        // Create empty stats for missing days
        result.push({
          date: dateStr,
          totalPoints: 0,
          accountsCompleted: 0,
          accountsWithErrors: 0,
          totalSearches: 0,
          totalActivities: 0,
          runDuration: 0,
        });
      }
    }

    return result.reverse(); // Chronological order
  }

  /**
   * Save account-specific daily stats
   */
  saveAccountDailyStats(stats: AccountDailyStats): void {
    try {
      const accountDir = path.join(this.dailyStatsPath, "accounts");
      if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
      }

      const maskedEmail = stats.email.replace(/@.*/, "@***");
      const filePath = path.join(
        accountDir,
        `${maskedEmail}_${stats.date}.json`,
      );
      fs.writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf-8");
    } catch (error) {
      log(
        "main",
        "STATS",
        `Failed to save account stats: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Get all account stats for a specific date
   */
  getAccountStatsForDate(date: string): AccountDailyStats[] {
    try {
      const accountDir = path.join(this.dailyStatsPath, "accounts");
      if (!fs.existsSync(accountDir)) return [];

      const files = fs
        .readdirSync(accountDir)
        .filter((f) => f.endsWith(`_${date}.json`));

      return files.map((file) => {
        const data = fs.readFileSync(path.join(accountDir, file), "utf-8");
        return JSON.parse(data) as AccountDailyStats;
      });
    } catch {
      return [];
    }
  }

  /**
   * Save global (all-time) statistics
   */
  saveGlobalStats(stats: GlobalStats): void {
    try {
      fs.writeFileSync(
        this.globalStatsPath,
        JSON.stringify(stats, null, 2),
        "utf-8",
      );
    } catch (error) {
      log(
        "main",
        "STATS",
        `Failed to save global stats: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Load global statistics
   */
  loadGlobalStats(): GlobalStats {
    try {
      if (!fs.existsSync(this.globalStatsPath)) {
        return {
          totalRunsAllTime: 0,
          totalPointsAllTime: 0,
          averagePointsPerDay: 0,
        };
      }

      const data = fs.readFileSync(this.globalStatsPath, "utf-8");
      return JSON.parse(data) as GlobalStats;
    } catch {
      return {
        totalRunsAllTime: 0,
        totalPointsAllTime: 0,
        averagePointsPerDay: 0,
      };
    }
  }

  /**
   * Increment global stats after a run
   */
  incrementGlobalStats(pointsEarned: number): void {
    const stats = this.loadGlobalStats();
    const today = new Date().toISOString().slice(0, 10);

    stats.totalRunsAllTime++;
    stats.totalPointsAllTime += pointsEarned;
    stats.lastRunDate = today;

    if (!stats.firstRunDate) {
      stats.firstRunDate = today;
    }

    // Calculate average (last 30 days)
    const last30Days = this.getLastNDays(30);
    const totalPoints30Days = last30Days.reduce(
      (sum, day) => sum + day.totalPoints,
      0,
    );
    stats.averagePointsPerDay = Math.round(totalPoints30Days / 30);

    this.saveGlobalStats(stats);
  }

  /**
   * Get all available stat dates
   */
  getAllStatDates(): string[] {
    try {
      const files = fs
        .readdirSync(this.dailyStatsPath)
        .filter((f) => f.endsWith(".json") && f !== "global.json")
        .map((f) => f.replace(".json", ""))
        .sort()
        .reverse();

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Delete old stats (keep last N days)
   */
  pruneOldStats(keepDays: number = 90): void {
    try {
      const allDates = this.getAllStatDates();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - keepDays);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);

      for (const date of allDates) {
        if (date < cutoffStr) {
          const filePath = path.join(this.dailyStatsPath, `${date}.json`);
          fs.unlinkSync(filePath);
        }
      }
    } catch (error) {
      log(
        "main",
        "STATS",
        `Failed to prune old stats: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }

  /**
   * Get historical stats for charts (last N days)
   */
  getHistoricalStats(days: number = 30): Record<string, number> {
    const result: Record<string, number> = {};
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);

      const stats = this.loadDailyStats(dateStr);
      result[dateStr] = stats?.totalPoints || 0;
    }

    return result;
  }

  /**
   * Get activity breakdown for last N days
   */
  getActivityBreakdown(days: number = 7): Record<string, number> {
    const breakdown: Record<string, number> = {
      "Desktop Search": 0,
      "Mobile Search": 0,
      "Daily Set": 0,
      Quizzes: 0,
      "Punch Cards": 0,
      Other: 0,
    };

    const today = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);

      const accountStats = this.getAccountStatsForDate(dateStr);

      for (const account of accountStats) {
        if (!account.desktopSearches) account.desktopSearches = 0;
        if (!account.mobileSearches) account.mobileSearches = 0;
        if (!account.activitiesCompleted) account.activitiesCompleted = 0;

        breakdown["Desktop Search"]! += account.desktopSearches;
        breakdown["Mobile Search"]! += account.mobileSearches;
        breakdown["Daily Set"]! += Math.min(1, account.activitiesCompleted);
        breakdown["Other"]! += Math.max(0, account.activitiesCompleted - 3);
      }
    }

    return breakdown;
  }

  /**
   * Get global stats
   */
  getGlobalStats(): GlobalStats {
    return this.loadGlobalStats();
  }
}

// Singleton instance
export const statsManager = new StatsManager();
