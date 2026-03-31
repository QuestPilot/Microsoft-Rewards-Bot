import ms from "ms";
import { secureRandom, secureRandomShuffle } from "../security/SecureRandom";

/**
 * Extract error message from unknown error type
 * @param error - Error object or unknown value
 * @returns String representation of the error
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// DEAD CODE REMOVED: formatErrorMessage() was never used (only JSDoc examples existed)
// Use formatDetailedError() instead for error formatting with optional stack traces

/**
 * Utility class for common operations
 * IMPROVED: Added comprehensive documentation
 */
export class Util {
  /**
   * Wait for a specified number of milliseconds
   * @param ms - Milliseconds to wait (max 1 hour, min 0)
   * @throws {Error} If ms is not finite, is NaN/Infinity, or is negative
   * @example await utils.wait(1000) // Wait 1 second
   */
  wait(ms: number): Promise<void> {
    const MAX_WAIT_MS = 3600000; // 1 hour max to prevent infinite waits
    const MIN_WAIT_MS = 0;

    // FIXED: Comprehensive validation - check finite, NaN, Infinity, and negative values
    if (!Number.isFinite(ms)) {
      throw new Error(
        `Invalid wait time: ${ms}. Must be a finite number (not NaN or Infinity).`,
      );
    }

    if (ms < 0) {
      throw new Error(
        `Invalid wait time: ${ms}. Cannot wait negative milliseconds.`,
      );
    }

    const safeMs = Math.min(Math.max(MIN_WAIT_MS, ms), MAX_WAIT_MS);

    return new Promise<void>((resolve) => {
      setTimeout(resolve, safeMs);
    });
  }

  /**
   * Wait for a random duration within a range
   * @param minMs - Minimum wait time in milliseconds
   * @param maxMs - Maximum wait time in milliseconds
   * @throws {Error} If parameters are invalid
   * @example await utils.waitRandom(1000, 3000) // Wait 1-3 seconds
   */
  async waitRandom(minMs: number, maxMs: number): Promise<void> {
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
      throw new Error(
        `Invalid wait range: min=${minMs}, max=${maxMs}. Both must be finite numbers.`,
      );
    }

    if (minMs > maxMs) {
      throw new Error(
        `Invalid wait range: min (${minMs}) cannot be greater than max (${maxMs}).`,
      );
    }

    const delta = this.randomNumber(minMs, maxMs);
    return this.wait(delta);
  }

  /**
   * Format a timestamp as MM/DD/YYYY
   * @param ms - Unix timestamp in milliseconds (defaults to current time)
   * @returns Formatted date string
   * @example utils.getFormattedDate() // '01/15/2025'
   * @example utils.getFormattedDate(1704067200000) // '01/01/2024'
   */
  getFormattedDate(ms = Date.now()): string {
    const today = new Date(ms);
    const month = String(today.getMonth() + 1).padStart(2, "0"); // January is 0
    const day = String(today.getDate()).padStart(2, "0");
    const year = today.getFullYear();

    return `${month}/${day}/${year}`;
  }

  /**
   * Randomly shuffle an array using Fisher-Yates algorithm
   * @param array - Array to shuffle
   * @returns New shuffled array (original array is not modified)
   * @example utils.shuffleArray([1, 2, 3, 4]) // [3, 1, 4, 2]
   */
  shuffleArray<T>(array: T[]): T[] {
    return secureRandomShuffle([...array]);
  }

  /**
   * Generate a random integer between min and max (inclusive)
   * @param min - Minimum value
   * @param max - Maximum value
   * @returns Random integer in range [min, max]
   * @throws {Error} If parameters are invalid
   * @example utils.randomNumber(1, 10) // 7
   */
  randomNumber(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error(
        `Invalid range: min=${min}, max=${max}. Both must be finite numbers.`,
      );
    }

    if (min > max) {
      throw new Error(
        `Invalid range: min (${min}) cannot be greater than max (${max}).`,
      );
    }

    return Math.floor(secureRandom() * (max - min + 1)) + min;
  }

  /**
   * Split an array into approximately equal chunks
   * @param arr - Array to split
   * @param numChunks - Number of chunks to create (must be positive integer)
   * @returns Array of chunks (sub-arrays)
   * @throws {Error} If parameters are invalid
   * @example utils.chunkArray([1,2,3,4,5], 2) // [[1,2,3], [4,5]]
   */
  chunkArray<T>(arr: T[], numChunks: number): T[][] {
    // Validate input parameters
    if (!Array.isArray(arr)) {
      throw new Error("Invalid input: arr must be an array.");
    }

    if (arr.length === 0) {
      return [];
    }

    if (!Number.isFinite(numChunks) || numChunks <= 0) {
      throw new Error(
        `Invalid numChunks: ${numChunks}. Must be a positive finite number.`,
      );
    }

    if (!Number.isInteger(numChunks)) {
      throw new Error(`Invalid numChunks: ${numChunks}. Must be an integer.`);
    }

    const safeNumChunks = Math.max(1, Math.floor(numChunks));
    const chunkSize = Math.ceil(arr.length / safeNumChunks);
    const chunks: T[][] = [];

    for (let i = 0; i < arr.length; i += chunkSize) {
      const chunk = arr.slice(i, i + chunkSize);
      chunks.push(chunk);
    }

    return chunks;
  }

  /**
   * Convert time string or number to milliseconds
   * @param input - Time string (e.g., '1 min', '5s', '2h') or number
   * @returns Time in milliseconds
   * @throws {Error} If input cannot be parsed
   * @example utils.stringToMs('1 min') // 60000
   * @example utils.stringToMs('5s') // 5000
   * @example utils.stringToMs(1000) // 1000
   */
  stringToMs(input: string | number): number {
    if (typeof input !== "string" && typeof input !== "number") {
      throw new Error("Invalid input type. Expected string or number.");
    }

    const milisec = ms(input.toString());
    if (!milisec || !Number.isFinite(milisec)) {
      throw new Error(
        'The string provided cannot be parsed to a valid time! Use a format like "1 min", "1m" or "1 minutes"',
      );
    }
    return milisec;
  }
}

/**
 * Extract short error message from unknown error type (max 120 chars)
 * @param error - Error object or unknown value
 * @returns Truncated string representation of the error
 * @example shortErrorMessage(new Error('Something went wrong')) // 'Something went wrong'
 * @example shortErrorMessage(null) // 'unknown'
 */
export function shortErrorMessage(error: unknown): string {
  if (error == null) return "unknown";
  if (error instanceof Error) return error.message.substring(0, 120);
  const str = String(error);
  return str.substring(0, 120);
}

/**
 * Format detailed error message with optional stack trace
 * @param label - Error context label (e.g., 'desktop', 'mobile', 'login')
 * @param error - Error object or unknown value
 * @param includeStack - Whether to include stack trace (default: false)
 * @returns Formatted error string with label and optionally stack trace
 * @example formatDetailedError('desktop', new Error('Failed'), true) // 'desktop:Failed :: at line1 | at line2...'
 * @example formatDetailedError('mobile', 'timeout') // 'mobile:timeout'
 */
export function formatDetailedError(
  label: string,
  error: unknown,
  includeStack: boolean = false,
): string {
  const baseMessage = shortErrorMessage(error);
  if (includeStack && error instanceof Error && error.stack) {
    const stackLines = error.stack.split("\n").slice(0, 4).join(" | ");
    return `${label}:${baseMessage} :: ${stackLines}`;
  }
  return `${label}:${baseMessage}`;
}

/**
 * Validate and normalize recovery email
 * IMPROVEMENT: Extracted to eliminate duplication and provide consistent validation
 *
 * @param recoveryEmail - Raw recovery email value from account configuration
 * @returns Normalized recovery email string or undefined if invalid
 *
 * @example
 * normalizeRecoveryEmail('  test@example.com  ') // 'test@example.com'
 * normalizeRecoveryEmail('') // undefined
 * normalizeRecoveryEmail(undefined) // undefined
 */
export function normalizeRecoveryEmail(
  recoveryEmail: unknown,
): string | undefined {
  if (typeof recoveryEmail !== "string") {
    return undefined;
  }

  const trimmed = recoveryEmail.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Safely extract a balanced JavaScript/JSON object starting at the first '{' after an anchor.
 * Linear-time scan with brace depth counting and string handling to avoid catastrophic backtracking.
 *
 * @param text Full source text to scan
 * @param anchor String or RegExp indicating where the assignment occurs (scan starts at first '{' after anchor)
 * @param maxScan Maximum characters to scan from the first '{' (prevents excessive work on malformed inputs)
 * @returns Object text including outer braces, or null if not found/imbalanced/exceeded limits
 */
export function extractBalancedObject(
  text: string,
  anchor: string | RegExp,
  maxScan: number = 500000,
): string | null {
  try {
    let startIdx = -1;

    if (typeof anchor === "string") {
      const pos = text.indexOf(anchor);
      if (pos === -1) return null;
      startIdx = pos + anchor.length;
    } else {
      const match = anchor.exec(text);
      if (!match || match.index == null) return null;
      startIdx = match.index + match[0].length;
    }

    // Find the first '{' after the anchor
    const braceStart = text.indexOf("{", startIdx);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let stringQuote: '"' | "'" | "`" | null = null;
    let escaped = false;

    const endLimit = Math.min(text.length, braceStart + maxScan);

    for (let i = braceStart; i < endLimit; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === stringQuote) {
          inString = false;
          stringQuote = null;
        }
        continue;
      }

      // Not inside a string
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = true;
        stringQuote = ch as '"' | "'" | "`";
        escaped = false;
        continue;
      }

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(braceStart, i + 1);
        }
      }
    }

    // If we exit the loop without returning, either imbalanced or exceeded limit
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the configured Git branch for auto-updates and remote resources
 * Reads from .update-branch.json if available, otherwise defaults to 'main'
 * @returns Branch name to use for GitHub raw URLs
 */
export function getUpdateBranch(): string {
  try {
    const fs = require("fs");
    const path = require("path");
    const configPath = path.join(process.cwd(), ".update-branch.json");

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return config.branch || "main";
    }
  } catch {
    // Fallback to default
  }

  return "main"; // Default fallback for legacy installations
}
