import { FingerprintGenerator } from "fingerprint-generator";
import { newInjectedContext } from "fingerprint-injector";
import playwright, { BrowserContext } from "rebrowser-playwright";

import { MicrosoftRewardsBot } from "../index";
import { AccountProxy } from "../interface/Account";
import { updateFingerprintUserAgent } from "../util/browser/UserAgent";
import { getErrorMessage } from "../util/core/Utils";
import {
  getAntiDetectionScript,
  getMediumAntiDetectionScript,
  getTimezoneScript,
} from "../util/security/AntiDetectionScripts";
import {
  getRandomizedHTTP2Settings,
  setupTLSProtection,
} from "../util/security/TLSFingerprint";
import {
  generateRealisticScreen,
  generateRealisticViewport,
  getViewportOverrideScript,
} from "../util/security/ViewportRandomizer";
import { loadSessionData, saveFingerprintData } from "../util/state/Load";
import {
  logFingerprintValidation,
  validateFingerprintConsistency,
} from "../util/validation/FingerprintValidator";

export class Browser {
  private bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  async createBrowser(
    proxy: AccountProxy,
    email: string,
  ): Promise<BrowserContext> {
    if (process.env.AUTO_INSTALL_BROWSERS === "1") {
      try {
        const { execSync } = await import("child_process");
        // FIXED: Add timeout to prevent indefinite blocking
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          "Auto-installing Chromium...",
          "log",
        );
        execSync("npx playwright install chromium", {
          stdio: "ignore",
          timeout: 120000,
        });
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          "Chromium installed successfully",
          "log",
        );
      } catch (e) {
        // FIXED: Improved error logging (no longer silent)
        const errorMsg = getErrorMessage(e);
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          `Auto-install failed: ${errorMsg}`,
          "warn",
        );
      }
    }

    let browser: import("rebrowser-playwright").Browser;
    try {
      const envForceHeadless = process.env.FORCE_HEADLESS === "1";
      const headless = envForceHeadless
        ? true
        : (this.bot.config.browser?.headless ?? false);

      const engineName = "chromium";
      this.bot.log(
        this.bot.isMobile,
        "BROWSER",
        `Launching ${engineName} (headless=${headless})`,
      );
      const proxyConfig = this.buildPlaywrightProxy(proxy);

      const isLinux = process.platform === "linux";

      // CRITICAL: Anti-detection Chromium arguments
      // These arguments minimize bot detection fingerprints
      const baseArgs = [
        "--no-sandbox",
        "--mute-audio",
        "--disable-setuid-sandbox",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
        "--ignore-ssl-errors",
        // ANTI-DETECTION: Core automation hiding
        "--disable-blink-features=AutomationControlled",
        "--disable-automation",
        "--disable-extensions",
        // ANTI-DETECTION: Window behavior
        "--start-maximized",
        "--window-position=0,0",
        // ANTI-DETECTION: Disable telemetry and tracking features
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=TranslateUI",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        // ANTI-DETECTION: WebRTC hardening
        "--disable-webrtc-hw-encoding",
        "--disable-webrtc-hw-decoding",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        // ANTI-DETECTION: Disable GPU features that leak info
        "--disable-gpu-sandbox",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu-compositing",
        // ANTI-DETECTION: Disable features that identify headless mode
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-save-password-bubble",
        "--disable-infobars",
        // ANTI-DETECTION: Navigator properties
        "--disable-features=site-per-process",
        "--disable-features=IsolateOrigins",
        // ANTI-DETECTION: Timing attack prevention
        "--disable-features=ReduceUserAgent",
        "--disable-features=ScriptStreaming",
        // PERFORMANCE: Stability
        "--disable-breakpad",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-zygote",
        // ANTI-DETECTION: Make WebDriver undetectable
        "--enable-features=NetworkService,NetworkServiceInProcess",
        // NEW 2026: TLS fingerprinting protection
        ...getRandomizedHTTP2Settings(),
      ];

      // Platform-specific stability fixes
      // CRITICAL: --single-process is unstable on Windows and causes context closure
      const platformStabilityArgs = isLinux
        ? [
            "--single-process", // Safe on Linux with proper memory management
            "--disable-dev-shm-usage",
            "--disable-software-rasterizer",
            "--disable-http-cache",
            "--disk-cache-size=1",
          ]
        : [
            // Windows-specific stability (avoid --single-process which crashes Chromium context)
            "--disable-background-networking",
            "--disable-preconnect",
            "--disable-web-resources",
            "--disable-component-extensions-with-background-pages",
            "--disable-translate",
            "--disable-sync-on-cellular",
            "--disable-device-discovery-notifications",
            "--disable-default-language",
            "--disable-print-preview",
          ];

      // CRITICAL: Windows needs longer timeout (120s) due to slower context initialization
      const launchTimeout = isLinux ? 90000 : 120000;

      browser = await playwright.chromium.launch({
        headless,
        ...(proxyConfig && { proxy: proxyConfig }),
        args: [...baseArgs, ...platformStabilityArgs],
        timeout: launchTimeout,
      });
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      if (/Executable doesn't exist/i.test(msg)) {
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          'Chromium not installed. Run "npm run pre-build" or set AUTO_INSTALL_BROWSERS=1',
          "error",
        );
      } else {
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          "Failed to launch browser: " + msg,
          "error",
        );
      }
      throw e;
    }

    const legacyFp = (
      this.bot.config as {
        saveFingerprint?: { mobile: boolean; desktop: boolean };
      }
    ).saveFingerprint;
    const nestedFp = (
      this.bot.config.fingerprinting as
        | { saveFingerprint?: { mobile: boolean; desktop: boolean } }
        | undefined
    )?.saveFingerprint;
    const saveFingerprint = legacyFp ||
      nestedFp || { mobile: false, desktop: false };

    const sessionData = await loadSessionData(
      this.bot.config.sessionPath,
      email,
      this.bot.isMobile,
      saveFingerprint,
    );
    const fingerprint = sessionData.fingerprint
      ? sessionData.fingerprint
      : await this.generateFingerprint();

    // CRITICAL: Validate fingerprint consistency before using it
    const validationResult = validateFingerprintConsistency(
      fingerprint,
      this.bot.config,
    );
    logFingerprintValidation(validationResult, email);

    // SECURITY: Abort if critical issues detected (optional, can be disabled)
    if (
      !validationResult.valid &&
      this.bot.config.riskManagement?.stopOnCritical
    ) {
      throw new Error(
        `Fingerprint validation failed for ${email}: ${validationResult.criticalIssues.join(", ")}`,
      );
    }

    const context = await newInjectedContext(
      browser as unknown as import("playwright").Browser,
      { fingerprint: fingerprint },
    );

    const globalTimeout = this.bot.config.browser?.globalTimeout ?? 30000;
    context.setDefaultTimeout(
      typeof globalTimeout === "number"
        ? globalTimeout
        : this.bot.utils.stringToMs(globalTimeout),
    );

    // CRITICAL: Get anti-detection configuration
    const antiDetectConfig = this.bot.config.antiDetection || {};
    const timezone =
      antiDetectConfig.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const locale = antiDetectConfig.locale || "en-US";
    const languages = antiDetectConfig.languages || ["en-US", "en"];

    // Generate BOTH medium and comprehensive anti-detection scripts
    const mediumScript = getMediumAntiDetectionScript({
      platform: this.bot.isMobile ? "Android" : "Win32",
      vendor: "Google Inc.",
      locale,
    });

    const comprehensiveScript = getAntiDetectionScript({
      timezone,
      locale,
      languages,
      platform: this.bot.isMobile ? "Android" : "Win32",
      vendor: "Google Inc.",
      webglVendor: antiDetectConfig.webglVendor || "Intel Inc.",
      webglRenderer:
        antiDetectConfig.webglRenderer || "Intel Iris OpenGL Engine",
    });

    // Generate timezone consistency script
    const timezoneScript = getTimezoneScript(timezone, locale);

    try {
      context.on("page", async (page) => {
        try {
          // SMART DETECTION: Use medium scripts for tracking/non-critical pages
          // and comprehensive protection for Microsoft domains
          const smartAntiDetectScript = `
(function() {
    const url = window.location.href;
    const isTrackingSite = url.includes('lgtw.tf') || 
                          url.includes('about:blank') ||
                          url === '' ||
                          url === 'about:blank';
    const isMicrosoftSite = url.includes('microsoft.com') || 
                           url.includes('bing.com') || 
                           url.includes('live.com') ||
                           url.includes('login.microsoftonline.com');
    
    // For tracking sites, use MEDIUM protection (defeats disable-devtool, fast load)
    if (isTrackingSite && !isMicrosoftSite) {
        ${mediumScript}
    } else {
        // For Microsoft sites, use comprehensive 23-layer protection
        ${comprehensiveScript}
    }
})();
          `.trim();

          // CRITICAL: Inject smart anti-detection script BEFORE any page load
          await page.addInitScript(smartAntiDetectScript);
          await page.addInitScript(timezoneScript);

          // CRITICAL: Block disable-devtool ONLY on tracking site
          // This script detects automation and blocks JS execution, preventing redirect
          // We keep it active for normal users (protects webhook) but disable for bot
          await page.route("**/*", (route) => {
            const url = route.request().url();
            const pageUrl = page.url();

            // Block disable-devtool ONLY when loading tracking site
            if (
              pageUrl.includes("lgtw.tf") &&
              (url.includes("disable-devtool") ||
                url.includes("jsdelivr.net/npm/disable-devtool"))
            ) {
              route.abort("blockedbyclient");
              return;
            }

            // Allow all other requests
            route.continue();
          });

          // NEW 2026: Enhanced viewport randomization
          const viewportConfig = generateRealisticViewport(
            this.bot.isMobile,
            true,
          );
          const screenConfig = generateRealisticScreen(viewportConfig);
          const viewportScript = getViewportOverrideScript(
            viewportConfig,
            screenConfig,
          );
          await page.addInitScript(viewportScript);
          await page.setViewportSize({
            width: viewportConfig.width,
            height: viewportConfig.height,
          });

          this.bot.log(
            this.bot.isMobile,
            "BROWSER",
            `Viewport: ${viewportConfig.width}x${viewportConfig.height} (DPR: ${viewportConfig.deviceScaleFactor})`,
          );

          // CRITICAL: Block WebAuthn API calls to prevent passkey dialogs
          await page.addInitScript(() => {
            // Override navigator.credentials to block passkey requests
            if (window.navigator.credentials) {
              // Block credential creation (passkey enrollment)
              window.navigator.credentials.create = async function (
                ..._args: unknown[]
              ) {
                console.log("[MRS] Blocked WebAuthn credential.create() call");
                // Reject with NotAllowedError (user cancelled)
                throw new DOMException(
                  "The operation either timed out or was not allowed.",
                  "NotAllowedError",
                );
              };

              // Block credential retrieval (passkey authentication)
              window.navigator.credentials.get = async function (
                ..._args: unknown[]
              ) {
                console.log("[MRS] Blocked WebAuthn credential.get() call");
                // Reject with NotAllowedError (user cancelled)
                throw new DOMException(
                  "The operation either timed out or was not allowed.",
                  "NotAllowedError",
                );
              };
            }

            // Also remove PublicKeyCredential if it exists
            if (window.PublicKeyCredential) {
              window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
                async () => false;
              window.PublicKeyCredential.isConditionalMediationAvailable =
                async () => false;
            }
          });

          // CRITICAL: Disable WebAuthn popups using Virtual Authenticator
          // This prevents native "Choose where to save your passkey" dialogs
          try {
            const client = await page.context().newCDPSession(page);

            // Enable WebAuthn and add a virtual authenticator that auto-rejects
            await client.send("WebAuthn.enable");

            // Add virtual authenticator with settings that prevent UI prompts
            await client.send("WebAuthn.addVirtualAuthenticator", {
              options: {
                protocol: "ctap2",
                transport: "internal",
                hasResidentKey: false, // No resident keys = no passkey storage
                hasUserVerification: false, // No biometric/PIN verification
                isUserVerified: false, // Always fail verification
                automaticPresenceSimulation: false, // No automatic approval
              },
            });

            this.bot.log(
              this.bot.isMobile,
              "BROWSER",
              "WebAuthn Virtual Authenticator enabled (passkey dialogs disabled)",
            );
          } catch (cdpError) {
            // Non-critical: CDP might not be available on all browsers
            this.bot.log(
              this.bot.isMobile,
              "BROWSER",
              `WebAuthn setup skipped: ${getErrorMessage(cdpError)}`,
              "warn",
            );
          }

          // NEW 2026: Setup TLS fingerprinting protection
          // This applies enhanced HTTP headers and request timing
          const userAgent = fingerprint.fingerprint.navigator.userAgent;
          await setupTLSProtection(
            page.context(),
            userAgent,
            this.bot.isMobile,
          );

          // Add custom CSS for page fitting
          await page.addInitScript(() => {
            try {
              const style = document.createElement("style");
              style.id = "__mrs_fit_style";
              style.textContent = `
                              html, body { overscroll-behavior: contain; }
                              @media (min-width: 1000px) {
                                html { zoom: 0.9 !important; }
                              }
                            `;
              document.documentElement.appendChild(style);
            } catch {
              /* Non-critical: Style injection may fail if DOM not ready */
            }
          });

          this.bot.log(
            this.bot.isMobile,
            "BROWSER",
            `Page configured with smart anti-detection (12-layer medium for tracking sites, 23-layer for Microsoft) + TLS/HTTP2 protection`,
          );
        } catch (e) {
          this.bot.log(
            this.bot.isMobile,
            "BROWSER",
            `Page setup warning: ${getErrorMessage(e)}`,
            "warn",
          );
        }
      });
    } catch (e) {
      this.bot.log(
        this.bot.isMobile,
        "BROWSER",
        `Context event handler warning: ${getErrorMessage(e)}`,
        "warn",
      );
    }

    await context.addCookies(sessionData.cookies);

    if (saveFingerprint.mobile || saveFingerprint.desktop) {
      await saveFingerprintData(
        this.bot.config.sessionPath,
        email,
        this.bot.isMobile,
        fingerprint,
      );
    }

    this.bot.log(
      this.bot.isMobile,
      "BROWSER",
      `Browser ready with UA: "${fingerprint.fingerprint.navigator.userAgent}"`,
    );

    return context as BrowserContext;
  }

  private buildPlaywrightProxy(
    proxy: AccountProxy,
  ): { server: string; username?: string; password?: string } | undefined {
    const { url, port, username, password } = proxy;
    if (!url) return undefined;

    const trimmed = url.trim();
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
    const candidate = hasScheme ? trimmed : `http://${trimmed}`;

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch (err) {
      this.bot.log(
        this.bot.isMobile,
        "BROWSER",
        `Invalid proxy URL "${url}": ${getErrorMessage(err)}`,
        "error",
      );
      return undefined;
    }

    if (!parsed.port) {
      if (port) {
        parsed.port = String(port);
      } else {
        this.bot.log(
          this.bot.isMobile,
          "BROWSER",
          `Proxy port missing for "${url}"`,
          "error",
        );
        return undefined;
      }
    }

    const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;

    const auth: { username?: string; password?: string } = {};
    if (username) auth.username = username;
    if (password) auth.password = password;

    return { server, ...auth };
  }

  async generateFingerprint() {
    const fingerPrintData = new FingerprintGenerator().getFingerprint();

    const updatedFingerPrintData = await updateFingerprintUserAgent(
      fingerPrintData,
      this.bot.isMobile,
    );

    return updatedFingerPrintData;
  }
}
