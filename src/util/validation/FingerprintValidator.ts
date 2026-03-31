/**
 * Fingerprint Consistency Validator
 *
 * CRITICAL: Microsoft detects automation by checking for inconsistencies between:
 * - Timezone (browser reported vs. IP geolocation)
 * - Locale (browser language vs. IP country)
 * - Screen resolution (realistic vs. bot patterns)
 * - WebGL renderer (consistency check)
 *
 * This validator warns about potential detection risks BEFORE running automation.
 */

import type { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import type { Config } from "../../interface/Config";
import { log } from "../notifications/Logger";

interface FingerprintValidationResult {
  valid: boolean;
  warnings: string[];
  criticalIssues: string[];
}

/**
 * Validate fingerprint consistency to minimize detection risk
 * @param fingerprint Browser fingerprint data
 * @param config Bot configuration
 * @returns Validation result with warnings/errors
 */
export function validateFingerprintConsistency(
  fingerprint: BrowserFingerprintWithHeaders,
  config: Config,
): FingerprintValidationResult {
  const warnings: string[] = [];
  const criticalIssues: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION 1: Timezone consistency
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fingerprintTimezone =
      fingerprint.fingerprint.navigator?.userAgentData?.platform;

    // CRITICAL: Check if timezone makes sense for the platform
    if (fingerprintTimezone === "Windows") {
      // Windows users rarely use non-UTC timezones
      if (
        browserTimezone &&
        !browserTimezone.includes("UTC") &&
        !browserTimezone.includes("America") &&
        !browserTimezone.includes("Europe")
      ) {
        warnings.push(
          `Timezone '${browserTimezone}' is unusual for Windows platform (${fingerprintTimezone})`,
        );
      }
    }

    if (fingerprintTimezone === "Android") {
      // Mobile users should have timezone matching their location
      // If using proxy, timezone may not match IP location (detection risk)
      warnings.push(
        "Mobile timezone consistency cannot be validated without IP geolocation data",
      );
    }
  } catch {
    // Timezone validation failed (non-critical)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION 2: Screen resolution realism
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const screen = fingerprint.fingerprint.screen;
    if (screen) {
      const { width, height, availWidth, availHeight } = screen;

      // CRITICAL: Check for unrealistic screen dimensions
      if (width < 800 && height < 600) {
        criticalIssues.push(
          `Screen size too small: ${width}x${height} (likely bot pattern)`,
        );
      }

      if (width > 7680 || height > 4320) {
        warnings.push(`Screen size unusually large: ${width}x${height} (8K+)`);
      }

      // CRITICAL: Check for exact match between screen and available size (bot pattern)
      if (width === availWidth && height === availHeight) {
        warnings.push(
          "Screen size exactly matches available size (possible bot pattern - no taskbar/menubar)",
        );
      }

      // CRITICAL: Check devicePixelRatio realism
      const dpr = screen.devicePixelRatio;
      if (dpr && (dpr < 0.5 || dpr > 5)) {
        warnings.push(`Device pixel ratio unusual: ${dpr} (expected 0.5-5)`);
      }
    }
  } catch {
    // Screen validation failed (non-critical)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION 3: User agent consistency
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const ua = fingerprint.fingerprint.navigator.userAgent;
    const uaPlatform =
      fingerprint.fingerprint.navigator?.userAgentData?.platform;

    // CRITICAL: Check for mismatched platform indicators
    if (ua.includes("Windows") && uaPlatform !== "Windows") {
      criticalIssues.push(
        `User agent platform mismatch: UA says Windows, platform says ${uaPlatform}`,
      );
    }

    if (ua.includes("Android") && uaPlatform !== "Android") {
      criticalIssues.push(
        `User agent platform mismatch: UA says Android, platform says ${uaPlatform}`,
      );
    }

    // CRITICAL: Check for outdated browser versions (bot indicator)
    const chromeMatch = ua.match(/Chrome\/(\d+)/);
    if (chromeMatch) {
      const chromeVersion = parseInt(chromeMatch[1] || "0");
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Chrome releases ~6 versions per year (every 2 months)
      // Rough estimation: version 100 in 2022, +6 per year
      const expectedMinVersion =
        100 + (currentYear - 2022) * 6 + Math.floor(currentMonth / 2);

      if (chromeVersion < expectedMinVersion - 20) {
        warnings.push(
          `Chrome version ${chromeVersion} is outdated (expected ${expectedMinVersion - 20}+)`,
        );
      }
    }
  } catch {
    // UA validation failed (non-critical)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION 4: Header consistency
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const headers = fingerprint.headers;

    // CRITICAL: Check for missing critical headers (bot indicator)
    const requiredHeaders = [
      "user-agent",
      "accept",
      "accept-language",
      "sec-ch-ua",
    ];
    for (const header of requiredHeaders) {
      if (!headers[header]) {
        criticalIssues.push(`Missing critical header: ${header}`);
      }
    }

    // CRITICAL: Check sec-ch-ua consistency with user agent
    if (headers["sec-ch-ua"] && headers["user-agent"]) {
      const secChUa = headers["sec-ch-ua"];
      const ua = headers["user-agent"];

      // Extract Edge version from sec-ch-ua
      const edgeMatch = secChUa.match(/"Microsoft Edge";v="(\d+)"/);
      const uaEdgeMatch = ua.match(/Edg[A]?\/(\d+)/);

      if (edgeMatch && uaEdgeMatch) {
        const secChVersion = edgeMatch[1];
        const uaVersion = uaEdgeMatch[1];

        if (secChVersion !== uaVersion) {
          criticalIssues.push(
            `Edge version mismatch: sec-ch-ua=${secChVersion}, user-agent=${uaVersion}`,
          );
        }
      }
    }
  } catch {
    // Header validation failed (non-critical)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION 5: Fingerprint persistence check
  // ═══════════════════════════════════════════════════════════════════════

  if (!config.saveFingerprint?.desktop && !config.saveFingerprint?.mobile) {
    warnings.push(
      "Fingerprint persistence disabled - each run generates new fingerprint (high detection risk)",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Final verdict
  // ═══════════════════════════════════════════════════════════════════════

  const valid = criticalIssues.length === 0;

  return {
    valid,
    warnings,
    criticalIssues,
  };
}

/**
 * Log fingerprint validation results
 * @param result Validation result
 * @param email Account email for context
 */
export function logFingerprintValidation(
  result: FingerprintValidationResult,
  email: string,
): void {
  if (result.criticalIssues.length > 0) {
    log(
      "main",
      "FINGERPRINT",
      `⚠️ CRITICAL ISSUES detected for ${email}:`,
      "error",
    );
    result.criticalIssues.forEach((issue) => {
      log("main", "FINGERPRINT", `  ❌ ${issue}`, "error");
    });
    log(
      "main",
      "FINGERPRINT",
      "🚨 Account may be flagged as bot - high ban risk!",
      "error",
    );
  }

  if (result.warnings.length > 0 && result.criticalIssues.length === 0) {
    log("main", "FINGERPRINT", `⚠️ Warnings for ${email}:`, "warn");
    result.warnings.forEach((warning) => {
      log("main", "FINGERPRINT", `  ⚠️ ${warning}`, "warn");
    });
  }

  if (result.valid && result.warnings.length === 0) {
    log(
      "main",
      "FINGERPRINT",
      `✅ Fingerprint validation passed for ${email}`,
      "log",
    );
  }
}
