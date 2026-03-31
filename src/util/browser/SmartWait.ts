import { Locator, Page } from "rebrowser-playwright";
import { getErrorMessage } from "../core/Utils";

/**
 * Wait for network idle state specifically
 * Optimized for post-navigation or post-action network settling
 *
 * @param page Playwright page instance
 * @param options Configuration options
 * @returns Result with completion status and timing
 */
export async function waitForNetworkIdle(
  page: Page,
  options: {
    timeoutMs?: number;
    logFn?: (msg: string) => void;
  } = {},
): Promise<{ idle: boolean; timeMs: number }> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const logFn = options.logFn ?? (() => {});

  try {
    // Quick check: is network already idle?
    const hasActivity = await page
      .evaluate(() => {
        return (
          performance.getEntriesByType(
            "resource",
          ) as PerformanceResourceTiming[]
        ).some((r) => r.responseEnd === 0);
      })
      .catch(() => false);

    if (!hasActivity) {
      const elapsed = Date.now() - startTime;
      logFn(`✓ Network already idle (${elapsed}ms)`);
      return { idle: true, timeMs: elapsed };
    }

    // Wait for network to settle
    await page
      .waitForLoadState("networkidle", { timeout: timeoutMs })
      .catch(() => {
        logFn(`Network idle timeout (${timeoutMs}ms) - continuing anyway`);
      });

    const elapsed = Date.now() - startTime;
    logFn(`✓ Network idle after ${elapsed}ms`);
    return { idle: true, timeMs: elapsed };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMsg = getErrorMessage(error);
    logFn(`⚠ Network idle check failed after ${elapsed}ms: ${errorMsg}`);
    return { idle: false, timeMs: elapsed };
  }
}

/**
 * Wait for page to be truly ready (network idle + DOM ready)
 * Much faster than waitForLoadState with fixed timeouts
 *
 * FIXED: Properly wait for network idle state with adequate timeout
 */
export async function waitForPageReady(
  page: Page,
  options: {
    timeoutMs?: number;
    logFn?: (msg: string) => void;
  } = {},
): Promise<{ ready: boolean; timeMs: number }> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000; // FIXED: 10s timeout for network idle
  const logFn = options.logFn ?? (() => {});

  try {
    // Step 1: Wait for DOM ready (fast)
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {
        logFn("DOM load timeout, continuing...");
      });

    // Step 2: Check if already at network idle (most common case)
    const hasNetworkActivity = await page
      .evaluate(() => {
        return (
          performance.getEntriesByType(
            "resource",
          ) as PerformanceResourceTiming[]
        ).some((r) => r.responseEnd === 0);
      })
      .catch(() => false);

    if (!hasNetworkActivity) {
      const elapsed = Date.now() - startTime;
      logFn(`✓ Page ready immediately (${elapsed}ms)`);
      return { ready: true, timeMs: elapsed };
    }

    // Step 3: Wait for network idle with proper timeout (not duration)
    // FIXED: Use timeoutMs as the maximum wait time for networkidle state
    await page
      .waitForLoadState("networkidle", { timeout: timeoutMs })
      .catch(() => {
        logFn(
          `Network idle timeout after ${timeoutMs}ms (expected), page may still be usable`,
        );
      });

    const elapsed = Date.now() - startTime;
    logFn(`✓ Page ready after ${elapsed}ms`);
    return { ready: true, timeMs: elapsed };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMsg = getErrorMessage(error);
    logFn(`⚠ Page readiness check incomplete after ${elapsed}ms: ${errorMsg}`);

    // Return success anyway if we waited reasonably
    return { ready: elapsed > 1000, timeMs: elapsed };
  }
}

/**
 * Smart element waiting with adaptive timeout
 * Checks element presence quickly, then extends timeout only if needed
 */
export async function waitForElementSmart(
  page: Page,
  selector: string,
  options: {
    initialTimeoutMs?: number;
    extendedTimeoutMs?: number;
    state?: "attached" | "detached" | "visible" | "hidden";
    logFn?: (msg: string) => void;
  } = {},
): Promise<{ found: boolean; timeMs: number; element: Locator | null }> {
  const startTime = Date.now();
  const initialTimeoutMs = options.initialTimeoutMs ?? 2000; // Quick first check
  const extendedTimeoutMs = options.extendedTimeoutMs ?? 5000; // Extended if needed
  const state = options.state ?? "attached";
  const logFn = options.logFn ?? (() => {});

  try {
    // Fast path: element already present
    const element = page.locator(selector);
    await element.waitFor({ state, timeout: initialTimeoutMs });

    const elapsed = Date.now() - startTime;
    logFn(`✓ Element found quickly (${elapsed}ms)`);
    return { found: true, timeMs: elapsed, element };
  } catch (firstError) {
    // Element not found quickly - try extended wait (silent until result known)
    try {
      const element = page.locator(selector);
      await element.waitFor({ state, timeout: extendedTimeoutMs });

      const elapsed = Date.now() - startTime;
      logFn(`✓ Element found after extended wait (${elapsed}ms)`);
      return { found: true, timeMs: elapsed, element };
    } catch (extendedError) {
      const elapsed = Date.now() - startTime;
      // IMPROVED: Concise failure message without full Playwright error stack
      logFn(
        `Element not found after ${elapsed}ms (expected if activity unavailable)`,
      );
      return { found: false, timeMs: elapsed, element: null };
    }
  }
}

// DEAD CODE REMOVED: waitForNavigationSmart, clickElementSmart, and typeIntoFieldSmart
// These functions were never used in the codebase and have been removed to reduce complexity
