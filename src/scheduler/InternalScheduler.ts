import cron from "node-cron";
import type { Config } from "../interface/Config";
import { getErrorMessage } from "../util/core/Utils";
import { log } from "../util/notifications/Logger";
import { secureRandomInt } from "../util/security/SecureRandom";

/**
 * Internal Scheduler for automatic bot execution
 * Uses node-cron internally but provides simple time-based scheduling
 *
 * Features:
 * - Simple time-based scheduling (e.g., "09:00" = daily at 9 AM)
 * - Automatic timezone detection (uses your computer/server timezone)
 * - Overlap protection (prevents concurrent runs)
 * - Error recovery with retries
 * - Clean shutdown handling
 * - Cross-platform (Windows, Linux, Mac)
 */
export class InternalScheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private config: Config;
  private taskCallback: () => Promise<void>;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastCronExpression: string | null = null;

  constructor(config: Config, taskCallback: () => Promise<void>) {
    this.config = config;
    this.taskCallback = taskCallback;
  }

  /**
   * Start the scheduler if enabled in config
   * @returns true if scheduler started successfully, false otherwise
   */
  public start(): boolean {
    const scheduleConfig = this.config.scheduling;

    // Validation checks
    if (!scheduleConfig?.enabled) {
      log(
        "main",
        "SCHEDULER",
        "Internal scheduler disabled (scheduling.enabled = false)",
      );
      return false;
    }

    // Get schedule from simple time format (e.g., "09:00") or fallback to cron format (supports jitter)
    const { cronExpr, displayTime, jitterApplied } =
      this.buildSchedule(scheduleConfig);

    if (!cronExpr) {
      log(
        "main",
        "SCHEDULER",
        'Invalid schedule format. Use time in HH:MM format (e.g., "09:00" for 9 AM)',
        "error",
      );
      return false;
    }

    // Validate cron expression
    if (!cron.validate(cronExpr)) {
      log("main", "SCHEDULER", `Invalid schedule: "${cronExpr}"`, "error");
      return false;
    }

    try {
      const timezone = this.detectTimezone();

      this.cronJob = cron.schedule(
        cronExpr,
        async () => {
          await this.runScheduledTask();
        },
        {
          scheduled: true,
          timezone,
        },
      );

      this.lastCronExpression = cronExpr;
      const timeLabel = displayTime || this.extractTimeFromCron(cronExpr);
      const jitterLabel = jitterApplied
        ? ` (jitter applied: ${jitterApplied} min)`
        : "";

      log("main", "SCHEDULER", "✓ Internal scheduler started", "log", "green");
      log(
        "main",
        "SCHEDULER",
        `  Daily run time: ${timeLabel}${jitterLabel}`,
        "log",
        "cyan",
      );
      log("main", "SCHEDULER", `  Timezone: ${timezone}`, "log", "cyan");
      log(
        "main",
        "SCHEDULER",
        `  Next run: ${this.getNextRunTime()}`,
        "log",
        "cyan",
      );

      return true;
    } catch (error) {
      log(
        "main",
        "SCHEDULER",
        `Failed to start scheduler: ${getErrorMessage(error)}`,
        "error",
      );
      return false;
    }
  }

  /**
   * Parse schedule from config - supports simple time format (HH:MM) or cron expression
   * @returns Cron expression string
   */
  private buildSchedule(scheduleConfig: {
    time?: string;
    cron?: { schedule?: string };
    jitter?: {
      enabled?: boolean;
      minMinutesBefore?: number;
      maxMinutesAfter?: number;
    };
  }): { cronExpr: string | null; displayTime: string; jitterApplied: number } {
    // Priority 1: Simple time format (e.g., "09:00")
    if (scheduleConfig.time) {
      const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(scheduleConfig.time.trim());
      if (timeMatch) {
        const hours = parseInt(timeMatch[1]!, 10);
        const minutes = parseInt(timeMatch[2]!, 10);

        if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
          const jitter = this.applyJitter(
            hours,
            minutes,
            scheduleConfig.jitter,
          );
          const cronExpr = `${jitter.minute} ${jitter.hour} * * *`;
          const display = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
          return {
            cronExpr,
            displayTime: display,
            jitterApplied: jitter.offsetMinutes,
          };
        }
      }
      return { cronExpr: null, displayTime: "", jitterApplied: 0 };
    }

    // Priority 2: COMPATIBILITY format (cron.schedule field, pre-v2.58)
    if (scheduleConfig.cron?.schedule) {
      return {
        cronExpr: scheduleConfig.cron.schedule,
        displayTime: this.extractTimeFromCron(scheduleConfig.cron.schedule),
        jitterApplied: 0,
      };
    }

    // Default: 9 AM daily
    const jitter = this.applyJitter(9, 0, scheduleConfig.jitter);
    return {
      cronExpr: `${jitter.minute} ${jitter.hour} * * *`,
      displayTime: "09:00",
      jitterApplied: jitter.offsetMinutes,
    };
  }

  private applyJitter(
    hour: number,
    minute: number,
    jitter?: {
      enabled?: boolean;
      minMinutesBefore?: number;
      maxMinutesAfter?: number;
    },
  ) {
    const enabled = jitter?.enabled === true;
    const before = Number.isFinite(jitter?.minMinutesBefore)
      ? Number(jitter!.minMinutesBefore)
      : 20;
    const after = Number.isFinite(jitter?.maxMinutesAfter)
      ? Number(jitter!.maxMinutesAfter)
      : 30;

    if (!enabled || (before === 0 && after === 0)) {
      return { hour, minute, offsetMinutes: 0 };
    }

    const minOffset = -Math.abs(before);
    const maxOffset = Math.abs(after);
    const offset = this.getRandomInt(minOffset, maxOffset);

    let totalMinutes = hour * 60 + minute + offset;
    const minutesInDay = 24 * 60;
    while (totalMinutes < 0) totalMinutes += minutesInDay;
    while (totalMinutes >= minutesInDay) totalMinutes -= minutesInDay;

    const jitteredHour = Math.floor(totalMinutes / 60);
    const jitteredMinute = totalMinutes % 60;

    return {
      hour: jitteredHour,
      minute: jitteredMinute,
      offsetMinutes: offset,
    };
  }

  private getRandomInt(minInclusive: number, maxInclusive: number): number {
    return secureRandomInt(minInclusive, maxInclusive);
  }

  /**
   * Extract readable time from cron expression (for display purposes)
   */
  private extractTimeFromCron(cronExpr: string): string {
    const parts = cronExpr.split(" ");
    if (parts.length >= 2) {
      const minute = parts[0];
      const hour = parts[1];
      if (minute && hour && minute !== "*" && hour !== "*") {
        return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
      }
    }
    return cronExpr;
  }

  /**
   * Execute the scheduled task with overlap protection and retry logic
   */
  private async runScheduledTask(): Promise<void> {
    // Overlap protection
    if (this.isRunning) {
      log(
        "main",
        "SCHEDULER",
        "Skipping scheduled run: previous task still running",
        "warn",
      );
      return;
    }

    const maxRetries = this.config.crashRecovery?.maxRestarts ?? 1;
    let attempts = 0;

    while (attempts <= maxRetries) {
      try {
        this.isRunning = true;
        this.lastRunTime = new Date();

        log("main", "SCHEDULER", "⏰ Scheduled run triggered", "log", "cyan");

        await this.taskCallback();

        log(
          "main",
          "SCHEDULER",
          "✓ Scheduled run completed successfully",
          "log",
          "green",
        );
        log(
          "main",
          "SCHEDULER",
          `  Next run: ${this.getNextRunTime()}`,
          "log",
          "cyan",
        );

        this.rescheduleWithJitter();
        return; // Success - exit retry loop
      } catch (error) {
        attempts++;
        const errorMsg = getErrorMessage(error);
        log(
          "main",
          "SCHEDULER",
          `Scheduled run failed (attempt ${attempts}/${maxRetries + 1}): ${errorMsg}`,
          "error",
        );

        if (attempts <= maxRetries) {
          const backoff =
            (this.config.crashRecovery?.backoffBaseMs ?? 2000) * attempts;
          log("main", "SCHEDULER", `Retrying in ${backoff}ms...`, "warn");
          await new Promise((resolve) => setTimeout(resolve, backoff));
        } else {
          log(
            "main",
            "SCHEDULER",
            `Max retries (${maxRetries + 1}) exceeded. Waiting for next scheduled run.`,
            "error",
          );
        }
      } finally {
        this.isRunning = false;
      }
    }

    // If we exit the loop without success, still reschedule jitter for the next day
    this.rescheduleWithJitter();
  }

  /**
   * Stop the scheduler gracefully
   */
  public stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      log("main", "SCHEDULER", "Scheduler stopped", "warn");
      this.cronJob = null;
    }
  }

  private rescheduleWithJitter(): void {
    const scheduleConfig = this.config.scheduling;
    // Only apply jitter for simple time-based schedules
    if (!scheduleConfig?.enabled || !scheduleConfig.time) return;

    const { cronExpr, displayTime, jitterApplied } =
      this.buildSchedule(scheduleConfig);
    if (!cronExpr || !cron.validate(cronExpr)) {
      log(
        "main",
        "SCHEDULER",
        "Jitter reschedule skipped due to invalid schedule",
        "warn",
      );
      return;
    }

    if (this.cronJob) {
      this.cronJob.stop();
    }

    const timezone = this.detectTimezone();
    this.cronJob = cron.schedule(
      cronExpr,
      async () => {
        await this.runScheduledTask();
      },
      {
        scheduled: true,
        timezone,
      },
    );

    this.lastCronExpression = cronExpr;
    const timeLabel = displayTime || this.extractTimeFromCron(cronExpr);
    const jitterLabel = jitterApplied
      ? ` (jitter applied: ${jitterApplied} min)`
      : "";

    log(
      "main",
      "SCHEDULER",
      `Jitter rescheduled next run at ${timeLabel}${jitterLabel}. Next run: ${this.getNextRunTime()}`,
      "log",
      "cyan",
    );
  }

  /**
   * Get the next scheduled run time
   */
  private getNextRunTime(): string {
    if (!this.cronJob) return "unknown";

    try {
      const scheduleConfig = this.config.scheduling;
      const timezone = this.detectTimezone();

      // Get the cron schedule being used
      const cronSchedule =
        this.lastCronExpression ??
        (scheduleConfig?.time
          ? this.buildSchedule(scheduleConfig).cronExpr
          : undefined) ??
        scheduleConfig?.cron?.schedule ??
        "0 9 * * *";

      // Calculate next run based on cron expression
      const now = new Date();
      const parts = cronSchedule.split(" ");

      if (parts.length !== 5) {
        return "invalid schedule format";
      }

      // Simple next-run calculation for daily schedules
      const [minute, hour] = parts;

      if (!minute || !hour || minute === "*" || hour === "*") {
        return "varies (see schedule configuration)";
      }

      const targetHour = parseInt(hour, 10);
      const targetMinute = parseInt(minute, 10);

      if (isNaN(targetHour) || isNaN(targetMinute)) {
        return "complex schedule";
      }

      const next = new Date(now);
      next.setHours(targetHour, targetMinute, 0, 0);

      // If time already passed today, move to tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      return next.toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      });
    } catch {
      return "unable to calculate";
    }
  }

  /**
   * Detect system timezone
   */
  private detectTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  /**
   * Check if scheduler is active
   */
  public isActive(): boolean {
    return this.cronJob !== null;
  }

  /**
   * Get scheduler status for monitoring
   */
  public getStatus(): {
    active: boolean;
    isRunning: boolean;
    lastRun: string | null;
    nextRun: string;
  } {
    return {
      active: this.isActive(),
      isRunning: this.isRunning,
      lastRun: this.lastRunTime ? this.lastRunTime.toLocaleString() : null,
      nextRun: this.getNextRunTime(),
    };
  }

  /**
   * Trigger an immediate run (useful for manual triggers or dashboard)
   */
  public async triggerNow(): Promise<void> {
    log("main", "SCHEDULER", "Manual trigger requested", "log", "cyan");
    await this.runScheduledTask();
  }
}
