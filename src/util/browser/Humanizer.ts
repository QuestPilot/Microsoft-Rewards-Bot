/**
 * Advanced Human Behavior Simulator
 *
 * CRITICAL: This module simulates realistic human behavior patterns
 * to prevent bot detection by Microsoft's security systems
 *
 * KEY IMPROVEMENTS:
 * 1. Bézier curve mouse movements (not linear)
 * 2. Crypto-secure randomness (not Math.random)
 * 3. Natural scroll with inertia
 * 4. Think time pauses
 * 5. Session-specific behavior personality
 * 6. Fatigue simulation
 */

import { Page } from "rebrowser-playwright";
import type { ConfigHumanization } from "../../interface/Config";
import { Util } from "../core/Utils";
import {
    generateMousePath,
    generateScrollPath,
    Point,
} from "../security/NaturalMouse";
import {
    humanVariance,
    secureRandomBool,
    secureRandomFloat,
    secureRandomInt,
} from "../security/SecureRandom";

/**
 * Session behavior personality
 * Generated once per session for consistent behavior patterns
 */
interface SessionPersonality {
  /** Base typing speed multiplier (0.7-1.3) */
  typingSpeed: number;
  /** Mouse movement precision (0.8-1.2) */
  mousePrecision: number;
  /** Tendency to pause (0.5-1.5) */
  pauseTendency: number;
  /** Scroll aggression (0.7-1.3) */
  scrollSpeed: number;
  /** Fatigue factor increases over time */
  fatigueLevel: number;
  /** Session start time */
  sessionStart: number;
}

export class Humanizer {
  private util: Util;
  private cfg: ConfigHumanization | undefined;
  private personality: SessionPersonality;
  private actionCount: number = 0;

  constructor(util: Util, cfg?: ConfigHumanization) {
    this.util = util;
    this.cfg = cfg;

    // Generate unique personality for this session
    this.personality = this.generatePersonality();
  }

  /**
   * Generate session-specific behavior personality
   * CRITICAL: Makes each session unique to prevent pattern detection
   */
  private generatePersonality(): SessionPersonality {
    return {
      typingSpeed: secureRandomFloat(0.7, 1.3),
      mousePrecision: secureRandomFloat(0.8, 1.2),
      pauseTendency: secureRandomFloat(0.5, 1.5),
      scrollSpeed: secureRandomFloat(0.7, 1.3),
      fatigueLevel: 0,
      sessionStart: Date.now(),
    };
  }

  /**
   * Update fatigue level based on session duration
   * Humans get tired and slower over time
   */
  private updateFatigue(): void {
    const sessionDuration = Date.now() - this.personality.sessionStart;
    const hoursActive = sessionDuration / (1000 * 60 * 60);

    // Fatigue increases gradually (0 at start, ~0.3 after 2 hours)
    this.personality.fatigueLevel = Math.min(0.5, hoursActive * 0.15);
  }

  /**
   * Get delay multiplier based on fatigue
   */
  private getFatigueMultiplier(): number {
    this.updateFatigue();
    return 1 + this.personality.fatigueLevel;
  }

  /**
   * Perform natural mouse movement using Bézier curves
   *
   * IMPROVED 2026: Enhanced with multiple behavioral patterns
   * - Jitter movements (micro-corrections)
   * - Occasional pauses mid-movement
   * - Speed variation based on distance
   * - Fatigue-affected precision
   *
   * @param page - Playwright page
   * @param targetX - Target X coordinate
   * @param targetY - Target Y coordinate
   * @param options - Movement options
   */
  async naturalMouseMove(
    page: Page,
    targetX: number,
    targetY: number,
    options: { speed?: number; overshoot?: boolean; jitter?: boolean } = {},
  ): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    try {
      // Get current mouse position (approximate from last known)
      const viewportSize = page.viewportSize();
      const startX = viewportSize
        ? secureRandomInt(0, viewportSize.width / 2)
        : 100;
      const startY = viewportSize
        ? secureRandomInt(0, viewportSize.height / 2)
        : 100;

      const start: Point = { x: startX, y: startY };
      const end: Point = { x: targetX, y: targetY };

      // Calculate distance for speed adjustment
      const distance = Math.sqrt(
        (end.x - start.x) ** 2 + (end.y - start.y) ** 2,
      );

      // Longer movements are faster (human efficiency)
      const distanceSpeedMultiplier =
        distance > 500 ? 1.3 : distance > 200 ? 1.1 : 1.0;

      // Generate natural path with Bézier curves
      const path = generateMousePath(start, end, {
        speed:
          (options.speed ?? 1.0) *
          this.personality.mousePrecision *
          distanceSpeedMultiplier,
        overshoot: options.overshoot ?? secureRandomBool(0.25),
        tremor: 0.2 + this.personality.fatigueLevel, // More tremor when fatigued
      });

      // Execute path with occasional pauses
      for (let i = 0; i < path.points.length; i++) {
        const point = path.points[i];
        const duration = path.durations[i];

        if (point) {
          await page.mouse.move(point.x, point.y).catch(() => {});
        }

        // Occasional mid-movement pause (hesitation)
        if (i > 0 && i < path.points.length - 2 && secureRandomBool(0.05)) {
          await page.waitForTimeout(secureRandomInt(50, 150)).catch(() => {});
        }

        if (duration && duration > 0) {
          await page.waitForTimeout(duration).catch(() => {});
        }
      }

      // Add micro-jitter after landing (optional)
      if (options.jitter !== false && secureRandomBool(0.4)) {
        const jitterX = targetX + secureRandomFloat(-2, 2);
        const jitterY = targetY + secureRandomFloat(-2, 2);
        await page.mouse.move(jitterX, jitterY).catch(() => {});
        await page.waitForTimeout(secureRandomInt(20, 50)).catch(() => {});
      }

      this.actionCount++;
    } catch {
      // Mouse movement failed - not critical
    }
  }

  /**
   * Perform natural scroll with inertia
   *
   * @param page - Playwright page
   * @param deltaY - Scroll amount (positive = down)
   * @param options - Scroll options
   */
  async naturalScroll(
    page: Page,
    deltaY: number,
    options: { smooth?: boolean; speed?: number } = {},
  ): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    try {
      const scrollPath = generateScrollPath(
        deltaY * this.personality.scrollSpeed,
        {
          speed: options.speed ?? 1.0,
          smooth: options.smooth ?? true,
        },
      );

      for (let i = 0; i < scrollPath.deltas.length; i++) {
        const delta = scrollPath.deltas[i];
        const duration = scrollPath.durations[i];

        if (delta) {
          await page.mouse.wheel(0, delta).catch(() => {});
        }

        if (duration && duration > 0) {
          await page.waitForTimeout(duration).catch(() => {});
        }
      }
    } catch {
      // Scroll failed - not critical
    }
  }

  /**
   * Simulate micro-gestures (small movements and scrolls)
   * IMPROVED: Uses Bézier curves and crypto randomness
   */
  async microGestures(page: Page): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    const moveProb = this.cfg?.gestureMoveProb ?? 0.4;
    const scrollProb = this.cfg?.gestureScrollProb ?? 0.2;

    try {
      // Random mouse movement (with Bézier curve)
      if (secureRandomBool(moveProb)) {
        const viewport = page.viewportSize();
        if (viewport) {
          const targetX = secureRandomInt(50, viewport.width - 50);
          const targetY = secureRandomInt(50, viewport.height - 50);
          await this.naturalMouseMove(page, targetX, targetY, { speed: 1.5 });
        }
      }

      // Random scroll (with inertia)
      if (secureRandomBool(scrollProb)) {
        const direction = secureRandomBool(0.65) ? 1 : -1; // 65% down
        const distance = secureRandomInt(50, 200) * direction;
        await this.naturalScroll(page, distance);
      }
    } catch {
      // Gesture execution failed - not critical
    }
  }

  /**
   * Action pause with human-like variance
   * IMPROVED: Uses crypto randomness and fatigue simulation
   */
  async actionPause(): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    const defMin = 150;
    const defMax = 450;
    let min = defMin;
    let max = defMax;

    if (this.cfg?.actionDelay) {
      const parse = (v: number | string) => {
        if (typeof v === "number") return v;
        try {
          const n = this.util.stringToMs(String(v));
          return Math.max(0, Math.min(n, 10_000));
        } catch {
          return defMin;
        }
      };
      min = parse(this.cfg.actionDelay.min);
      max = parse(this.cfg.actionDelay.max);
      if (min > max) [min, max] = [max, min];
      max = Math.min(max, 5_000);
    }

    // Apply personality and fatigue
    const baseDelay = humanVariance((min + max) / 2, 0.4);
    const adjustedDelay =
      baseDelay * this.personality.pauseTendency * this.getFatigueMultiplier();

    await this.util.wait(Math.floor(adjustedDelay));
    this.actionCount++;
  }

  /**
   * Think time - longer pause simulating human reading/thinking
   * CRITICAL: Prevents rapid automated actions that trigger detection
   *
   * @param context - What the user is "thinking" about (for logging)
   * @param intensity - How complex the decision is (1-3)
   */
  async thinkTime(
    _context: string = "decision",
    intensity: number = 1,
  ): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    // Base think time based on intensity
    const baseTime = {
      1: { min: 500, max: 1500 }, // Simple decision
      2: { min: 1000, max: 3000 }, // Medium decision
      3: { min: 2000, max: 5000 }, // Complex decision
    }[Math.min(3, Math.max(1, intensity))] || { min: 500, max: 1500 };

    // Apply variance and personality
    const thinkDuration =
      humanVariance(
        (baseTime.min + baseTime.max) / 2,
        0.5,
        0.1, // 10% chance of "distracted" longer pause
      ) *
      this.personality.pauseTendency *
      this.getFatigueMultiplier();

    await this.util.wait(Math.floor(thinkDuration));
  }

  /**
   * Reading time - simulates human reading content
   * Duration based on estimated word count
   *
   * @param wordCount - Estimated words on page
   * @param skim - Whether to skim (faster) or read carefully
   */
  async readingTime(
    wordCount: number = 50,
    skim: boolean = false,
  ): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    // Average reading speed: 200-300 WPM
    // Skimming: 400-600 WPM
    const wpm = skim ? secureRandomInt(400, 600) : secureRandomInt(200, 300);

    const baseTime = (wordCount / wpm) * 60 * 1000; // Convert to ms
    const adjustedTime =
      humanVariance(baseTime, 0.3) * this.getFatigueMultiplier();

    // Minimum reading time
    const minTime = skim ? 500 : 1500;
    await this.util.wait(Math.max(minTime, Math.floor(adjustedTime)));
  }

  /**
   * Click preparation - micro-pause before clicking
   * Humans don't instantly click after finding target
   */
  async preClickPause(): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    const pause = humanVariance(150, 0.5) * this.personality.pauseTendency;
    await this.util.wait(Math.floor(pause));
  }

  /**
   * Post-click reaction - pause after clicking
   * Humans wait to see result before next action
   */
  async postClickPause(): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) return;

    const pause =
      humanVariance(300, 0.4) *
      this.personality.pauseTendency *
      this.getFatigueMultiplier();
    await this.util.wait(Math.floor(pause));
  }

  /**
   * Simulate human idle behavior (waiting for page load, etc.)
   * Small movements and scrolls while waiting
   *
   * @param page - Playwright page
   * @param durationMs - How long to idle
   */
  async idle(page: Page, durationMs: number): Promise<void> {
    if (this.cfg && this.cfg.enabled === false) {
      await this.util.wait(durationMs);
      return;
    }

    const startTime = Date.now();
    const endTime = startTime + durationMs;

    while (Date.now() < endTime) {
      // Random chance of micro-gesture
      if (secureRandomBool(0.3)) {
        await this.microGestures(page);
      }

      // Wait a bit before next potential gesture
      const waitTime = secureRandomInt(500, 2000);
      const remainingTime = endTime - Date.now();
      await this.util.wait(Math.min(waitTime, Math.max(0, remainingTime)));
    }
  }

  /**
   * Get current session stats (for debugging/logging)
   */
  getSessionStats(): {
    actionCount: number;
    fatigueLevel: number;
    sessionDurationMs: number;
  } {
    this.updateFatigue();
    return {
      actionCount: this.actionCount,
      fatigueLevel: this.personality.fatigueLevel,
      sessionDurationMs: Date.now() - this.personality.sessionStart,
    };
  }

  /**
   * Reset session (for new account)
   */
  resetSession(): void {
    this.personality = this.generatePersonality();
    this.actionCount = 0;
  }
}
