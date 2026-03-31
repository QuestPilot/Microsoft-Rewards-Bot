/**
 * Activity Statistics Tracker
 * Collects and reports statistics on activity success/failure rates
 * Useful for identifying problematic activities and improving bot reliability
 */

import { getErrorMessage } from "../core/Utils";
import { log } from "../notifications/Logger";

interface ActivityStat {
  attempts: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastError?: string;
  lastAttemptTime: number;
}

interface ActivityStatsConfig {
  /** Whether to log periodic summaries (default: true) */
  logSummaries?: boolean;
  /** Minimum failure rate (0-1) to trigger warnings (default: 0.5) */
  warningFailureRate?: number;
}

const DEFAULT_CONFIG: Required<ActivityStatsConfig> = {
  logSummaries: true,
  warningFailureRate: 0.5,
};

export class ActivityStatsTracker {
  private stats: Map<string, ActivityStat> = new Map();
  private config: Required<ActivityStatsConfig>;
  private sessionStartTime: number = Date.now();

  constructor(config?: ActivityStatsConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record the start of an activity attempt
   * @param activityType Activity type identifier (e.g., 'SEARCH', 'QUIZ', 'POLL')
   * @returns Start timestamp for duration calculation
   */
  startActivity(activityType: string): number {
    const normalizedType = activityType.toUpperCase();
    const startTime = Date.now();

    let stat = this.stats.get(normalizedType);
    if (!stat) {
      stat = {
        attempts: 0,
        successes: 0,
        failures: 0,
        totalDurationMs: 0,
        lastAttemptTime: startTime,
      };
      this.stats.set(normalizedType, stat);
    }

    stat.attempts++;
    stat.lastAttemptTime = startTime;

    return startTime;
  }

  /**
   * Record a successful activity completion
   * @param activityType Activity type identifier
   * @param startTime Start timestamp from startActivity()
   */
  recordSuccess(activityType: string, startTime: number): void {
    const normalizedType = activityType.toUpperCase();
    const duration = Date.now() - startTime;

    const stat = this.stats.get(normalizedType);
    if (stat) {
      stat.successes++;
      stat.totalDurationMs += duration;
    }
  }

  /**
   * Record a failed activity attempt
   * @param activityType Activity type identifier
   * @param startTime Start timestamp from startActivity()
   * @param error Error that caused the failure
   */
  recordFailure(
    activityType: string,
    startTime: number,
    error?: Error | string,
  ): void {
    const normalizedType = activityType.toUpperCase();
    const duration = Date.now() - startTime;

    const stat = this.stats.get(normalizedType);
    if (stat) {
      stat.failures++;
      stat.totalDurationMs += duration;
      if (error) {
        stat.lastError = getErrorMessage(error);
      }
    }
  }

  /**
   * Get statistics for a specific activity type
   */
  getActivityStats(activityType: string): ActivityStat | undefined {
    return this.stats.get(activityType.toUpperCase());
  }

  /**
   * Get failure rate for a specific activity type (0-1)
   */
  getFailureRate(activityType: string): number {
    const stat = this.stats.get(activityType.toUpperCase());
    if (!stat || stat.attempts === 0) {
      return 0;
    }
    return stat.failures / stat.attempts;
  }

  /**
   * Get average duration for a specific activity type in milliseconds
   */
  getAverageDuration(activityType: string): number {
    const stat = this.stats.get(activityType.toUpperCase());
    if (!stat || stat.attempts === 0) {
      return 0;
    }
    return stat.totalDurationMs / stat.attempts;
  }

  /**
   * Get all activity types that exceed the warning failure rate
   */
  getProblematicActivities(): Array<{
    type: string;
    failureRate: number;
    attempts: number;
    lastError?: string;
  }> {
    const problematic: Array<{
      type: string;
      failureRate: number;
      attempts: number;
      lastError?: string;
    }> = [];

    for (const [type, stat] of this.stats) {
      const failureRate = stat.attempts > 0 ? stat.failures / stat.attempts : 0;
      if (failureRate >= this.config.warningFailureRate && stat.attempts >= 2) {
        problematic.push({
          type,
          failureRate,
          attempts: stat.attempts,
          lastError: stat.lastError,
        });
      }
    }

    return problematic.sort((a, b) => b.failureRate - a.failureRate);
  }

  /**
   * Get comprehensive summary of all activity statistics
   */
  getSummary(): {
    totalAttempts: number;
    totalSuccesses: number;
    totalFailures: number;
    overallSuccessRate: number;
    sessionDurationHours: number;
    byActivity: Array<{
      type: string;
      attempts: number;
      successes: number;
      failures: number;
      successRate: number;
      avgDurationMs: number;
    }>;
  } {
    let totalAttempts = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    const byActivity: Array<{
      type: string;
      attempts: number;
      successes: number;
      failures: number;
      successRate: number;
      avgDurationMs: number;
    }> = [];

    for (const [type, stat] of this.stats) {
      totalAttempts += stat.attempts;
      totalSuccesses += stat.successes;
      totalFailures += stat.failures;

      byActivity.push({
        type,
        attempts: stat.attempts,
        successes: stat.successes,
        failures: stat.failures,
        successRate: stat.attempts > 0 ? stat.successes / stat.attempts : 0,
        avgDurationMs:
          stat.attempts > 0 ? stat.totalDurationMs / stat.attempts : 0,
      });
    }

    return {
      totalAttempts,
      totalSuccesses,
      totalFailures,
      overallSuccessRate:
        totalAttempts > 0 ? totalSuccesses / totalAttempts : 0,
      sessionDurationHours: (Date.now() - this.sessionStartTime) / 3600000,
      byActivity: byActivity.sort((a, b) => b.attempts - a.attempts),
    };
  }

  /**
   * Log summary to console/webhook
   */
  logSummary(): void {
    if (!this.config.logSummaries) {
      return;
    }

    const summary = this.getSummary();

    if (summary.totalAttempts === 0) {
      return;
    }

    log(
      "main",
      "ACTIVITY-STATS",
      `Session summary: ${summary.totalSuccesses}/${summary.totalAttempts} activities succeeded (${(summary.overallSuccessRate * 100).toFixed(1)}%)`,
    );

    // Log problematic activities
    const problematic = this.getProblematicActivities();
    if (problematic.length > 0) {
      for (const activity of problematic) {
        log(
          "main",
          "ACTIVITY-STATS",
          `High failure rate: ${activity.type} (${(activity.failureRate * 100).toFixed(0)}% failed, ${activity.attempts} attempts)${activity.lastError ? ` - Last error: ${activity.lastError.substring(0, 80)}` : ""}`,
          "warn",
        );
      }
    }
  }

  /**
   * Reset all statistics (call between bot runs)
   */
  reset(): void {
    this.stats.clear();
    this.sessionStartTime = Date.now();
  }
}

// Singleton instance for global access
let globalTracker: ActivityStatsTracker | null = null;

/**
 * Get or create the global activity stats tracker instance
 */
export function getActivityStatsTracker(
  config?: ActivityStatsConfig,
): ActivityStatsTracker {
  if (!globalTracker) {
    globalTracker = new ActivityStatsTracker(config);
  }
  return globalTracker;
}

/**
 * Reset and release the global tracker
 */
export function resetActivityStatsTracker(): void {
  if (globalTracker) {
    globalTracker.logSummary();
    globalTracker.reset();
  }
}
