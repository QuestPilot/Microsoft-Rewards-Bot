/**
 * Human-Like Typing Module for Login & Bot Operations
 *
 * CRITICAL: Microsoft detects .fill() as instant bot signature
 * This module provides gradual character-by-character typing with natural variance
 *
 * DIFFERENCES from account-creation/HumanBehavior:
 * - Login typing is FASTER (humans type passwords quickly from muscle memory)
 * - No typo simulation (users rarely make typos in saved credentials)
 * - Shorter delays (login is familiar action, not form-filling)
 *
 * IMPORTANT: Keep separate from account-creation to avoid coupling
 */

import type { Locator } from "rebrowser-playwright";
import { log } from "../notifications/Logger";
import {
    secureRandom,
    secureRandomBool,
    secureRandomInt,
} from "../security/SecureRandom";

export class HumanTyping {
  /**
   * Type text naturally into field (FAST login typing)
   *
   * CRITICAL: Use this instead of .fill() for ALL text inputs
   *
   * @param locator Playwright locator (input field)
   * @param text Text to type
   * @param speed Typing speed multiplier (1.0 = normal, 0.5 = slow, 2.0 = fast)
   * @returns Promise<void>
   *
   * @example
   * await HumanTyping.type(page.locator('#email'), 'user@example.com', 1.2) // Fast typing
   */
  static async type(
    locator: Locator,
    text: string,
    speed: number = 1.0,
  ): Promise<void> {
    // SECURITY: Ensure field is visible before typing (avoid bot detection)
    try {
      await locator.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      // Field not visible - continue anyway (page may be slow)
    }

    // IMPROVEMENT: Focus field naturally (humans click before typing)
    await locator.focus().catch(() => {
      // Focus failed - not critical
    });

    // CRITICAL: Clear existing text first (simulate Ctrl+A + Delete)
    await locator.clear().catch(async () => {
      // .clear() failed - use keyboard fallback
      await locator.press("Control+a").catch(() => {});
      await locator.press("Backspace").catch(() => {});
    });

    // IMPROVEMENT: Short pause after clearing (human reaction time)
    await this.delay(50, 150);

    // Type each character with variable timing
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!char) continue; // Skip undefined characters

      // SECURITY: Natural typing speed variance (login = fast, familiar action)
      // Base speed: 40-80ms per character (fast typing)
      // Speed multiplier: adjustable per context
      const baseDelay = 40 + secureRandom() * 40; // 40-80ms
      const charDelay = Math.floor(baseDelay / speed);

      // IMPROVEMENT: Slower on special characters (humans need to find keys)
      const isSpecialChar = /[^a-zA-Z0-9@.]/.test(char);
      const finalDelay = isSpecialChar ? charDelay * 1.5 : charDelay;

      await locator.pressSequentially(char, { delay: finalDelay }).catch(() => {
        // Typing failed - continue (character may have been typed)
      });

      // IMPROVEMENT: Occasional micro-pauses (10% chance)
      if (secureRandomBool(0.1) && i > 0) {
        await this.delay(100, 300);
      }

      // IMPROVEMENT: Burst typing pattern (humans type groups of characters quickly)
      // 30% chance to type next 2-3 characters rapidly
      if (secureRandomBool(0.3) && i < text.length - 2) {
        const burstLength = secureRandomInt(2, 3); // 2-3 chars
        for (let j = 0; j < burstLength && i + 1 < text.length; j++) {
          i++;
          const nextChar = text[i];
          if (nextChar) {
            await locator
              .pressSequentially(nextChar, { delay: 10 })
              .catch(() => {});
          }
        }
      }
    }

    // IMPROVEMENT: Short pause after typing (human verification)
    await this.delay(100, 300);
  }

  /**
   * Type email address (optimized for email format)
   *
   * PATTERN: Humans type emails in 3 parts: [name] @ [domain]
   *
   * CRITICAL FIX: Previous version called type() for domain which cleared the field,
   * erasing the localPart. Now we use typeAppend() to preserve existing content.
   *
   * @param locator Playwright locator (email input)
   * @param email Email address
   * @returns Promise<void>
   */
  static async typeEmail(locator: Locator, email: string): Promise<void> {
    const [localPart, domain] = email.split("@");

    if (!localPart || !domain) {
      // Invalid email format - fallback to regular typing
      await this.type(locator, email, 1.2);
      return;
    }

    // IMPROVEMENT: Type local part (fast) - this clears and types
    await this.type(locator, localPart, 1.3);

    // IMPROVEMENT: Slight pause before @ (humans verify username)
    await this.delay(50, 200);

    // Type @ symbol (slightly slower - special key)
    // CRITICAL: Use pressSequentially, NOT type() which would clear the field
    await locator.pressSequentially("@", { delay: 100 }).catch(() => {});

    // IMPROVEMENT: Slight pause after @ (humans verify domain)
    await this.delay(50, 150);

    // CRITICAL FIX: Use typeAppend() to NOT clear the field (preserve localPart + @)
    await this.typeAppend(locator, domain, 1.4);

    // VERIFICATION: Check that input contains the full email
    await this.delay(100, 200);
    const actualValue = await locator.inputValue().catch(() => "");
    if (
      !actualValue.includes(localPart) ||
      !actualValue.includes("@") ||
      !actualValue.includes(domain)
    ) {
      log(
        false,
        "HUMAN-TYPING",
        `Email may not have been typed correctly. Expected: ${email}, Got: ${actualValue}`,
        "warn",
      );
    }
  }

  /**
   * Type text without clearing the field first (append to existing content)
   *
   * CRITICAL: Use this when you want to ADD to existing text, not replace it
   *
   * @param locator Playwright locator (input field)
   * @param text Text to append
   * @param speed Typing speed multiplier (1.0 = normal, 0.5 = slow, 2.0 = fast)
   * @returns Promise<void>
   */
  private static async typeAppend(
    locator: Locator,
    text: string,
    speed: number = 1.0,
  ): Promise<void> {
    // Type each character with variable timing (no clearing)
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!char) continue; // Skip undefined characters

      // Natural typing speed variance
      const baseDelay = 40 + secureRandom() * 40; // 40-80ms
      const charDelay = Math.floor(baseDelay / speed);

      // Slower on special characters
      const isSpecialChar = /[^a-zA-Z0-9@.]/.test(char);
      const finalDelay = isSpecialChar ? charDelay * 1.5 : charDelay;

      await locator.pressSequentially(char, { delay: finalDelay }).catch(() => {
        // Typing failed - continue (character may have been typed)
      });

      // Occasional micro-pauses (10% chance)
      if (secureRandomBool(0.1) && i > 0) {
        await this.delay(100, 300);
      }

      // Burst typing pattern (30% chance)
      if (secureRandomBool(0.3) && i < text.length - 2) {
        const burstLength = secureRandomInt(2, 3); // 2-3 chars
        for (let j = 0; j < burstLength && i + 1 < text.length; j++) {
          i++;
          const nextChar = text[i];
          if (nextChar) {
            await locator
              .pressSequentially(nextChar, { delay: 10 })
              .catch(() => {});
          }
        }
      }
    }

    // Short pause after typing
    await this.delay(100, 300);
  }

  /**
   * Type password (FAST - humans type passwords from muscle memory)
   *
   * PATTERN: Password typing is FASTEST (no reading, pure muscle memory)
   *
   * @param locator Playwright locator (password input)
   * @param password Password string
   * @returns Promise<void>
   */
  static async typePassword(locator: Locator, password: string): Promise<void> {
    // CRITICAL: Passwords typed 2x faster than regular text
    await this.type(locator, password, 2.0);
  }

  /**
   * Type TOTP code (6-digit code from authenticator)
   *
   * PATTERN: TOTP typed VERY FAST (user reading from phone, focus)
   *
   * @param locator Playwright locator (TOTP input)
   * @param code 6-digit TOTP code
   * @returns Promise<void>
   */
  static async typeTotp(locator: Locator, code: string): Promise<void> {
    // CRITICAL: TOTP codes typed EXTREMELY fast (user focused, limited time)
    // Speed: 3.0x faster (15-25ms per character)
    await this.type(locator, code, 3.0);
  }

  /**
   * Human-like delay with natural variance
   *
   * @param minMs Minimum delay (ms)
   * @param maxMs Maximum delay (ms)
   * @returns Promise<void>
   */
  private static async delay(minMs: number, maxMs: number): Promise<void> {
    const delay = secureRandomInt(minMs, maxMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
