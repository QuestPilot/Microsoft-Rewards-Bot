/**
 * Human Behavior Simulator for Account Creation
 *
 * CRITICAL: Microsoft detects bots by analyzing:
 * 1. Typing speed (instant .fill() = bot, gradual .type() = human)
 * 2. Mouse movements (linear = bot, Bézier curves = human)
 * 3. Pauses (fixed delays = bot, variable pauses = human)
 * 4. Click patterns (force clicks = bot, natural clicks = human)
 * 5. Session consistency (same patterns = bot farm)
 *
 * MAJOR IMPROVEMENTS (v3.5):
 * - Crypto-secure randomness (not Math.random)
 * - Bézier curve mouse movements
 * - Session personality (unique behavior per account)
 * - Fatigue simulation
 * - Natural scroll with inertia
 *
 * This module ensures account creation is INDISTINGUISHABLE from manual creation.
 */

import type { Page } from "rebrowser-playwright";
import { getErrorMessage } from "../util/core/Utils";
import { log } from "../util/notifications/Logger";
import {
    generateMousePath,
    generateScrollPath,
} from "../util/security/NaturalMouse";
import {
    humanVariance,
    secureGaussian,
    secureRandomBool,
    secureRandomFloat,
    secureRandomInt,
    typingDelay,
} from "../util/security/SecureRandom";

/**
 * Session personality - unique behavior patterns per account creation
 */
interface CreatorPersonality {
  typingSpeed: number; // 0.6-1.4
  mousePrecision: number; // 0.7-1.3
  pauseTendency: number; // 0.5-1.5
  errorRate: number; // 0-0.08 (typo probability)
  burstTyping: boolean; // Does this person type in bursts?
  readingSpeed: number; // WPM for reading
  confidenceLevel: number; // 0.7-1.3 (affects hesitation)
}

export class HumanBehavior {
  private page: Page;
  private personality: CreatorPersonality;
  private sessionStart: number;
  private actionCount: number = 0;

  constructor(page: Page) {
    this.page = page;
    this.sessionStart = Date.now();

    // Generate unique personality for this account creation
    this.personality = this.generatePersonality();

    log(
      false,
      "CREATOR",
      `🧠 Session personality: typing=${this.personality.typingSpeed.toFixed(2)}x, ` +
        `precision=${this.personality.mousePrecision.toFixed(2)}x, ` +
        `confidence=${this.personality.confidenceLevel.toFixed(2)}`,
      "log",
      "cyan",
    );
  }

  /**
   * Generate unique personality for this session
   */
  private generatePersonality(): CreatorPersonality {
    return {
      typingSpeed: secureRandomFloat(0.6, 1.4),
      mousePrecision: secureRandomFloat(0.7, 1.3),
      pauseTendency: secureRandomFloat(0.5, 1.5),
      errorRate: secureRandomFloat(0, 0.08),
      burstTyping: secureRandomBool(0.3),
      readingSpeed: secureRandomInt(180, 320),
      confidenceLevel: secureRandomFloat(0.7, 1.3),
    };
  }

  /**
   * Get fatigue multiplier based on session duration
   */
  private getFatigueMultiplier(): number {
    const sessionDuration = Date.now() - this.sessionStart;
    const minutesActive = sessionDuration / 60000;

    // Fatigue increases over 30+ minutes
    return 1 + Math.min(0.4, Math.max(0, (minutesActive - 30) * 0.01));
  }

  /**
   * Human-like delay with natural variance
   * Unlike fixed delays, humans vary greatly in timing
   *
   * @param minMs Minimum delay
   * @param maxMs Maximum delay
   * @param context Description for logging (optional)
   */
  async humanDelay(
    minMs: number,
    maxMs: number,
    context?: string,
  ): Promise<void> {
    // Use Gaussian distribution centered on mean
    const mean = (minMs + maxMs) / 2;
    const stdDev = (maxMs - minMs) / 4;

    let delay = secureGaussian(mean, stdDev);

    // Apply personality and fatigue
    delay *= this.personality.pauseTendency * this.getFatigueMultiplier();

    // 10% chance of "thinking" pause (2x delay)
    if (secureRandomBool(0.1)) {
      delay *= 2;
      if (context) {
        log(
          false,
          "CREATOR",
          `[${context}] 🤔 Thinking pause (${Math.floor(delay)}ms)`,
          "log",
          "cyan",
        );
      }
    }

    // Clamp to reasonable bounds
    delay = Math.max(minMs * 0.5, Math.min(maxMs * 2, delay));

    await this.page.waitForTimeout(Math.floor(delay));
    this.actionCount++;
  }

  /**
   * CRITICAL: Type text naturally like a human
   * NEVER use .fill() - it's instant and detectable
   *
   * @param locator Playwright locator (input field)
   * @param text Text to type
   * @param context Description for logging
   */
  async humanType(
    locator: import("rebrowser-playwright").Locator,
    text: string,
    context: string,
  ): Promise<void> {
    // CRITICAL: Clear field first (human would select all + delete)
    await locator.clear();
    await this.humanDelay(200, 600, context);

    log(
      false,
      "CREATOR",
      `[${context}] ⌨️ Typing: "${text.substring(0, 20)}${text.length > 20 ? "..." : ""}"`,
      "log",
      "cyan",
    );

    // Track if we should simulate a typo
    let typoMade = false;
    const shouldMakeTypo = secureRandomBool(this.personality.errorRate * 3); // Once per field max

    for (let i = 0; i < text.length; i++) {
      const char: string = text[i] as string;
      if (!char) continue;

      // Determine character delay based on type
      let charDelay: number;
      const isFastKey = /[eatinos]/i.test(char);
      const isSlowKey = /[^a-z0-9@.]/i.test(char); // Symbols, uppercase
      const isBurst = this.personality.burstTyping && secureRandomBool(0.3);

      if (isBurst && i > 0) {
        // Burst typing: very fast sequence
        charDelay = typingDelay(30) * this.personality.typingSpeed;
      } else if (isFastKey) {
        charDelay = typingDelay(60) * this.personality.typingSpeed;
      } else if (isSlowKey) {
        charDelay = typingDelay(150) * this.personality.typingSpeed;
      } else {
        charDelay = typingDelay(80) * this.personality.typingSpeed;
      }

      // Simulate typo (once per field, if enabled)
      if (
        !typoMade &&
        shouldMakeTypo &&
        i > 2 &&
        i < text.length - 2 &&
        secureRandomBool(0.15)
      ) {
        typoMade = true;

        // Type wrong character
        const wrongChar = String.fromCharCode(
          char.charCodeAt(0) + secureRandomInt(-1, 1),
        );
        await locator.type(wrongChar, { delay: 0 });
        await this.page.waitForTimeout(secureRandomInt(200, 500));

        // Pause (realize mistake)
        await this.page.waitForTimeout(secureRandomInt(300, 800));

        // Backspace
        await this.page.keyboard.press("Backspace");
        await this.page.waitForTimeout(secureRandomInt(100, 300));

        log(false, "CREATOR", `[${context}] 🔄 Typo correction`, "log", "gray");
      }

      // Type the character
      await locator.type(char, { delay: 0 });
      await this.page.waitForTimeout(Math.floor(charDelay));

      // Occasional micro-pause (human thinking)
      if (secureRandomBool(0.05) && i > 0) {
        await this.page.waitForTimeout(secureRandomInt(300, 800));
      }

      // Burst typing: type next 2-3 chars rapidly
      if (isBurst && i < text.length - 2) {
        const burstLen = secureRandomInt(2, 3);
        for (let j = 0; j < burstLen && i + 1 < text.length; j++) {
          i++;
          const nextChar = text[i];
          if (nextChar) {
            await locator.type(nextChar, { delay: 0 });
            await this.page.waitForTimeout(secureRandomInt(15, 40));
          }
        }
      }
    }

    log(false, "CREATOR", `[${context}] ✅ Typing completed`, "log", "green");

    // Random pause after typing (human reviewing input)
    await this.humanDelay(400, 1200, context);
  }

  /**
   * CRITICAL: Simulate micro mouse movements and scrolls
   * Real humans constantly move mouse and scroll while reading/thinking
   *
   * IMPROVED: Uses Bézier curves for natural movement
   *
   * @param context Description for logging
   */
  async microGestures(context: string): Promise<void> {
    try {
      const gestureNotes: string[] = [];

      // Mouse movement probability varies by personality
      const mouseMoveProb = 0.35 + this.personality.mousePrecision * 0.3;

      if (secureRandomBool(mouseMoveProb)) {
        const viewport = this.page.viewportSize();
        if (viewport) {
          // Get random target
          const targetX = secureRandomInt(50, viewport.width - 50);
          const targetY = secureRandomInt(50, viewport.height - 50);

          // Generate Bézier curve path
          const startX = secureRandomInt(100, viewport.width / 2);
          const startY = secureRandomInt(100, viewport.height / 2);

          const path = generateMousePath(
            { x: startX, y: startY },
            { x: targetX, y: targetY },
            {
              speed: this.personality.mousePrecision,
              overshoot: secureRandomBool(0.2),
            },
          );

          // Execute path
          for (let i = 0; i < path.points.length; i++) {
            const point = path.points[i];
            if (point) {
              await this.page.mouse.move(point.x, point.y).catch(() => {});
            }
            const duration = path.durations[i];
            if (duration && duration > 0) {
              await this.page.waitForTimeout(duration).catch(() => {});
            }
          }

          gestureNotes.push(`mouse→(${targetX},${targetY})`);
        }
      }

      // Scroll probability
      const scrollProb = 0.2 + this.personality.pauseTendency * 0.15;

      if (secureRandomBool(scrollProb)) {
        const direction = secureRandomBool(0.65) ? 1 : -1;
        const distance = secureRandomInt(40, 250) * direction;

        // Natural scroll with inertia
        const scrollPath = generateScrollPath(distance, { smooth: true });

        for (let i = 0; i < scrollPath.deltas.length; i++) {
          const delta = scrollPath.deltas[i];
          if (delta) {
            await this.page.mouse.wheel(0, delta).catch(() => {});
          }
          const duration = scrollPath.durations[i];
          if (duration && duration > 0) {
            await this.page.waitForTimeout(duration).catch(() => {});
          }
        }

        gestureNotes.push(
          `scroll ${direction > 0 ? "↓" : "↑"} ${Math.abs(distance)}px`,
        );
      }

      if (gestureNotes.length > 0) {
        log(
          false,
          "CREATOR",
          `[${context}] ${gestureNotes.join(", ")}`,
          "log",
          "gray",
        );
      }
    } catch {
      // Gesture execution failed - not critical for operation
    }
  }

  /**
   * CRITICAL: Natural click with human behavior
   * NEVER use { force: true } - it bypasses visibility checks (bot pattern)
   *
   * IMPROVED: Uses Bézier curve to move to element
   *
   * @param locator Playwright locator (button/link)
   * @param context Description for logging
   * @param maxRetries Max click attempts (default: 3)
   * @returns true if click succeeded, false otherwise
   */
  async humanClick(
    locator: import("rebrowser-playwright").Locator,
    context: string,
    maxRetries: number = 3,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get element bounding box
        const box = await locator.boundingBox().catch(() => null);

        if (box) {
          // Calculate click position (not always center)
          const clickX = box.x + box.width * secureRandomFloat(0.25, 0.75);
          const clickY = box.y + box.height * secureRandomFloat(0.25, 0.75);

          // Move to element with Bézier curve
          const viewport = this.page.viewportSize();
          const startX = viewport
            ? secureRandomInt(0, viewport.width / 2)
            : 100;
          const startY = viewport
            ? secureRandomInt(0, viewport.height / 2)
            : 100;

          const path = generateMousePath(
            { x: startX, y: startY },
            { x: clickX, y: clickY },
            {
              speed: this.personality.mousePrecision,
              overshoot: secureRandomBool(0.15), // Less overshoot for clicks
            },
          );

          // Execute path
          for (let i = 0; i < path.points.length; i++) {
            const point = path.points[i];
            if (point) {
              await this.page.mouse.move(point.x, point.y).catch(() => {});
            }
            const duration = path.durations[i];
            if (duration && duration > 0) {
              await this.page.waitForTimeout(duration).catch(() => {});
            }
          }

          // Pre-click pause (human aims before clicking)
          await this.humanDelay(50, 200, context);
        }

        // Perform click
        await locator.click({ force: false, timeout: 5000 });

        log(
          false,
          "CREATOR",
          `[${context}] ✅ Clicked successfully`,
          "log",
          "green",
        );

        // Post-click pause (human waits for response)
        await this.humanDelay(250, 700, context);
        return true;
      } catch (error) {
        if (attempt < maxRetries) {
          log(
            false,
            "CREATOR",
            `[${context}] ⚠️ Click failed (attempt ${attempt}/${maxRetries}), retrying...`,
            "warn",
            "yellow",
          );
          await this.humanDelay(800, 1800, context);
        } else {
          const msg = getErrorMessage(error);
          log(
            false,
            "CREATOR",
            `[${context}] ❌ Click failed after ${maxRetries} attempts: ${msg}`,
            "error",
          );
          return false;
        }
      }
    }

    return false;
  }

  /**
   * CRITICAL: Simulate human "reading" the page
   * Real humans pause to read content before interacting
   *
   * @param context Description for logging
   */
  async readPage(context: string): Promise<void> {
    log(false, "CREATOR", `[${context}] 👀 Reading page...`, "log", "cyan");

    // Random scroll movements while reading
    const scrollCount = secureRandomInt(1, 3);
    for (let i = 0; i < scrollCount; i++) {
      await this.microGestures(context);
      await this.humanDelay(600, 1800, context);
    }

    // Final reading pause (based on personality reading speed)
    const readTime = (50 / this.personality.readingSpeed) * 60000; // ~50 words
    await this.humanDelay(readTime * 0.5, readTime * 1.5, context);
  }

  /**
   * CRITICAL: Simulate dropdown interaction (more complex than simple clicks)
   * Real humans: move mouse → hover → click → wait → select option
   *
   * @param buttonLocator Dropdown button locator
   * @param optionLocator Option to select locator
   * @param context Description for logging
   * @returns true if interaction succeeded, false otherwise
   */
  async humanDropdownSelect(
    buttonLocator: import("rebrowser-playwright").Locator,
    optionLocator: import("rebrowser-playwright").Locator,
    context: string,
  ): Promise<boolean> {
    // STEP 1: Click dropdown button
    const openSuccess = await this.humanClick(buttonLocator, `${context}_OPEN`);
    if (!openSuccess) return false;

    // STEP 2: Wait for dropdown animation
    await this.humanDelay(400, 1000, context);

    // STEP 3: Move mouse around (reading options)
    await this.microGestures(context);
    await this.humanDelay(200, 600, context);

    // STEP 4: Click selected option
    const selectSuccess = await this.humanClick(
      optionLocator,
      `${context}_SELECT`,
    );
    if (!selectSuccess) return false;

    // STEP 5: Wait for dropdown to close
    await this.humanDelay(400, 1000, context);

    return true;
  }

  /**
   * Hesitation pause - simulates uncertainty
   * Used before important actions where user might reconsider
   *
   * @param context Description for logging
   */
  async hesitate(context: string): Promise<void> {
    if (secureRandomBool(0.4 / this.personality.confidenceLevel)) {
      const hesitationTime =
        humanVariance(1500, 0.5) / this.personality.confidenceLevel;
      log(false, "CREATOR", `[${context}] 🤔 Hesitating...`, "log", "cyan");
      await this.page.waitForTimeout(Math.floor(hesitationTime));
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    actionCount: number;
    sessionDurationMs: number;
    personality: CreatorPersonality;
  } {
    return {
      actionCount: this.actionCount,
      sessionDurationMs: Date.now() - this.sessionStart,
      personality: this.personality,
    };
  }
}
