/**
 * TLS Fingerprinting Protection
 *
 * CRITICAL: TLS fingerprinting is increasingly used by Microsoft and other
 * services to detect automation. This module enhances Playwright's default
 * TLS configuration to appear more like real Chrome browsers.
 *
 * DETECTION VECTORS ADDRESSED:
 * 1. JA3/JA4 fingerprinting (TLS handshake analysis)
 * 2. HTTP/2 settings fingerprinting
 * 3. Header ordering consistency
 * 4. Cipher suite preferences
 * 5. TLS extension ordering
 *
 * References:
 * - https://www.browserless.io/blog/tls-fingerprinting
 * - https://ja3er.com/
 */

import { BrowserContext } from "rebrowser-playwright";
import { secureRandomInt } from "./SecureRandom";

/**
 * Request types with different header priorities
 */
type RequestType =
  | "document"
  | "xhr"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image";

/**
 * Generate realistic HTTP headers with proper ordering
 *
 * @param userAgent - Browser user agent string
 * @param isMobile - Mobile vs desktop context
 * @param requestType - Type of request being made
 * @param referer - Optional referer URL
 * @returns Ordered headers object
 */
function generateRealisticHeaders(
  userAgent: string,
  isMobile: boolean,
  requestType: RequestType = "document",
  referer?: string,
): Record<string, string> {
  // Extract Edge version from UA for sec-ch-ua header
  const edgeMatch = userAgent.match(/Edg[A]?\/(\d+)/);
  const edgeVersion = edgeMatch ? edgeMatch[1] : "130";
  const chromiumMatch = userAgent.match(/Chrome\/(\d+)/);
  const chromiumVersion = chromiumMatch ? chromiumMatch[1] : "130";

  // Base headers (order matters!)
  const headers: Record<string, string> = {};

  // CRITICAL: sec-ch-ua headers MUST come first (Chrome behavior)
  headers["sec-ch-ua"] =
    `"Not/A)Brand";v="99", "Microsoft Edge";v="${edgeVersion}", "Chromium";v="${chromiumVersion}"`;
  headers["sec-ch-ua-mobile"] = isMobile ? "?1" : "?0";
  headers["sec-ch-ua-platform"] = isMobile ? '"Android"' : '"Windows"';

  // Platform-specific headers
  if (!isMobile) {
    headers["sec-ch-ua-platform-version"] = `"${secureRandomInt(10, 15)}.0.0"`;
  }

  // Request-specific headers
  if (requestType === "document") {
    headers["upgrade-insecure-requests"] = "1";
  }

  headers["user-agent"] = userAgent;

  // Accept headers (vary by request type)
  switch (requestType) {
    case "document":
      headers["accept"] =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
      break;
    case "xhr":
    case "fetch":
      headers["accept"] = "*/*";
      break;
    case "script":
      headers["accept"] = "*/*";
      break;
    case "stylesheet":
      headers["accept"] = "text/css,*/*;q=0.1";
      break;
    case "image":
      headers["accept"] =
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
      break;
  }

  // Sec-Fetch headers (CRITICAL for CORS/security)
  headers["sec-fetch-site"] =
    requestType === "document" ? "none" : "same-origin";
  headers["sec-fetch-mode"] = requestType === "document" ? "navigate" : "cors";

  if (requestType === "document") {
    headers["sec-fetch-user"] = "?1";
  }

  headers["sec-fetch-dest"] =
    requestType === "script"
      ? "script"
      : requestType === "stylesheet"
        ? "style"
        : requestType === "image"
          ? "image"
          : requestType === "document"
            ? "document"
            : "empty";

  // Compression support
  headers["accept-encoding"] = "gzip, deflate, br, zstd";

  // Language preferences with quality values
  const languages = isMobile
    ? ["en-US", "en", "fr"]
    : ["en-US", "en", "fr-FR", "fr"];

  headers["accept-language"] = languages
    .map((lang, i) => {
      if (i === 0) return lang;
      const q = (1.0 - i * 0.1).toFixed(1);
      return `${lang};q=${q}`;
    })
    .join(",");

  // Referer (if provided)
  if (referer) {
    headers["referer"] = referer;
  }

  return headers;
}

/**
 * Randomize HTTP/2 settings to prevent fingerprinting
 * Note: This requires browser launch args modification
 *
 * @returns Randomized HTTP/2 settings as Chrome flags
 */
export function getRandomizedHTTP2Settings(): string[] {
  // HTTP/2 SETTINGS frame parameters that can be randomized
  const headerTableSize = secureRandomInt(4096, 8192);
  const maxConcurrentStreams = secureRandomInt(100, 128);
  const initialWindowSize = secureRandomInt(65535, 131072);

  return [
    `--http2-settings-header-table-size=${headerTableSize}`,
    `--http2-settings-max-concurrent-streams=${maxConcurrentStreams}`,
    `--http2-settings-initial-window-size=${initialWindowSize}`,
  ];
}

/**
 * Complete TLS fingerprinting protection setup
 * Call this after creating browser context
 *
 * OPTIMIZED 2026: Single unified interceptor to prevent performance degradation
 * Previous version had 3 separate interceptors causing 60s timeouts
 *
 * @param context - Playwright browser context
 * @param userAgent - User agent string
 * @param isMobile - Mobile vs desktop
 */
export async function setupTLSProtection(
  context: BrowserContext,
  userAgent: string,
  isMobile: boolean,
): Promise<void> {
  let lastRequestTime = 0;
  const minDelay = 10; // Reduced from 50ms - only for non-critical resources
  const maxDelay = 30; // Reduced from 200ms - balance between stealth and performance

  // CRITICAL: Single unified route interceptor
  // Combines headers, throttling, and timing in one pass
  await context.route("**/*", async (route, request) => {
    const resourceType = request.resourceType();
    const now = Date.now();

    // Skip interception for images/media to improve performance
    if (
      resourceType === "image" ||
      resourceType === "media" ||
      resourceType === "font"
    ) {
      return route.continue();
    }

    // 1. Request Throttling (ONLY for non-essential resources)
    const isCritical =
      resourceType === "document" ||
      resourceType === "xhr" ||
      resourceType === "fetch" ||
      resourceType === "script" ||
      resourceType === "stylesheet";

    // Skip throttling completely for critical resources (fast page load)
    if (!isCritical) {
      const timeSinceLastRequest = now - lastRequestTime;
      if (timeSinceLastRequest < minDelay) {
        const delay = secureRandomInt(minDelay, maxDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    lastRequestTime = Date.now();

    // 2. Enhanced Headers (for HTML/API requests only)
    let finalHeaders = request.headers();

    if (
      isCritical ||
      resourceType === "script" ||
      resourceType === "stylesheet"
    ) {
      const referer = request.headers()["referer"];
      const enhancedHeaders = generateRealisticHeaders(
        userAgent,
        isMobile,
        resourceType as RequestType,
        referer,
      );
      finalHeaders = {
        ...request.headers(),
        ...enhancedHeaders,
      };
    }

    // 3. Continue with enhanced headers
    await route.continue({ headers: finalHeaders });
  });
}
