import type { Page } from "rebrowser-playwright";
import { MicrosoftRewardsBot } from "../../index";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { logError } from "../../util/notifications/Logger";

export class PasskeyHandler {
  private bot: MicrosoftRewardsBot;
  private passkeyHandled = false;
  private noPromptIterations = 0;
  private lastNoPromptLog = 0;

  private static readonly SELECTORS = {
    passkeySecondary: 'button[data-testid="secondaryButton"]',
    passkeyPrimary: 'button[data-testid="primaryButton"]',
    passkeyTitle: '[data-testid="title"]',
    kmsiVideo: '[data-testid="kmsiVideo"]',
    biometricVideo: '[data-testid="biometricVideo"]',
    // QR Code Passkey dialog specific selectors
    qrCodeDialog: 'div[role="dialog"]',
    qrCodeImage: 'img[alt*="QR"], canvas[aria-label*="QR"], div[class*="qr"]',
    backButton: 'button:has-text("Back")',
    cancelButton: 'button:has-text("Cancel")',
  } as const;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  public async disableFido(page: Page) {
    await page
      .route("**/GetCredentialType.srf*", (route) => {
        try {
          const body = JSON.parse(route.request().postData() || "{}");
          body.isFidoSupported = false;
          route.continue({ postData: JSON.stringify(body) });
        } catch {
          /* Route continue on parse failure */ route.continue();
        }
      })
      .catch(
        logError(
          "LOGIN-FIDO",
          "Route interception setup failed",
          this.bot.isMobile,
        ),
      );
  }

  // NOTE: Automatic Escape sender removed - native OS dialogs should be handled
  // via safer server-side/workflow changes or Playwright Virtual Authenticator.

  public async handlePasskeyPrompts(page: Page, context: "main" | "oauth") {
    let did = false;

    // Priority 0: Handle QR Code Passkey dialog (appears after TOTP)
    const qrCodeHandled = await this.handleQrCodePasskeyDialog(page);
    if (qrCodeHandled) {
      did = true;
      this.logPasskeyOnce("QR code passkey dialog");
    }

    // Early exit for passkey creation flows (common on mobile): hit cancel/skip if present
    const currentUrl = page.url();
    if (/fido\/create|passkey/i.test(currentUrl)) {
      const cancelled = await this.clickFirstVisible(
        page,
        [
          'button:has-text("Cancel")',
          'button:has-text("Not now")',
          'button:has-text("Skip")',
          'button:has-text("No thanks")',
          '[data-testid="secondaryButton"]',
          'button[class*="secondary"]',
        ],
        500,
      );

      if (cancelled) {
        did = true;
        this.logPasskeyOnce("fido/create cancel");
      }
    }

    // Priority 1: Direct detection of "Skip for now" button by data-testid
    const skipBtnResult = await waitForElementSmart(
      page,
      'button[data-testid="secondaryButton"]',
      {
        initialTimeoutMs: 300,
        extendedTimeoutMs: 500,
        state: "visible",
      },
    );

    if (skipBtnResult.found && skipBtnResult.element) {
      const text = ((await skipBtnResult.element.textContent()) || "").trim();
      // Check if it's actually a skip button (could be other secondary buttons)
      if (/skip|later|not now|non merci|pas maintenant/i.test(text)) {
        await skipBtnResult.element
          .click()
          .catch(
            logError(
              "LOGIN-PASSKEY",
              "Skip button click failed",
              this.bot.isMobile,
            ),
          );
        did = true;
        this.logPasskeyOnce("data-testid secondaryButton");
      }
    }

    // Priority 2: Video heuristic (biometric prompt)
    if (!did) {
      const biometricResult = await waitForElementSmart(
        page,
        PasskeyHandler.SELECTORS.biometricVideo,
        {
          initialTimeoutMs: 300,
          extendedTimeoutMs: 500,
          state: "visible",
        },
      );

      if (biometricResult.found) {
        const btnResult = await waitForElementSmart(
          page,
          PasskeyHandler.SELECTORS.passkeySecondary,
          {
            initialTimeoutMs: 200,
            extendedTimeoutMs: 300,
            state: "visible",
          },
        );
        if (btnResult.found && btnResult.element) {
          await btnResult.element
            .click()
            .catch(
              logError(
                "LOGIN-PASSKEY",
                "Video heuristic click failed",
                this.bot.isMobile,
              ),
            );
          did = true;
          this.logPasskeyOnce("video heuristic");
        }
      }
    }

    // Priority 3: Title + secondary button detection
    if (!did) {
      const titleResult = await waitForElementSmart(
        page,
        PasskeyHandler.SELECTORS.passkeyTitle,
        {
          initialTimeoutMs: 300,
          extendedTimeoutMs: 500,
          state: "attached",
        },
      );

      if (titleResult.found && titleResult.element) {
        const title = ((await titleResult.element.textContent()) || "").trim();
        const looksLike =
          /sign in faster|passkey|fingerprint|face|pin|empreinte|visage|windows hello|hello/i.test(
            title,
          );

        if (looksLike) {
          const secBtnResult = await waitForElementSmart(
            page,
            PasskeyHandler.SELECTORS.passkeySecondary,
            {
              initialTimeoutMs: 200,
              extendedTimeoutMs: 300,
              state: "visible",
            },
          );

          if (secBtnResult.found && secBtnResult.element) {
            await secBtnResult.element
              .click()
              .catch(
                logError(
                  "LOGIN-PASSKEY",
                  "Title heuristic click failed",
                  this.bot.isMobile,
                ),
              );
            did = true;
            this.logPasskeyOnce(`title heuristic ${title}`);
          }
        }
      }

      // Check secondary button text if title heuristic didn't work
      if (!did) {
        const secBtnResult = await waitForElementSmart(
          page,
          PasskeyHandler.SELECTORS.passkeySecondary,
          {
            initialTimeoutMs: 200,
            extendedTimeoutMs: 300,
            state: "visible",
          },
        );

        if (secBtnResult.found && secBtnResult.element) {
          const text = (
            (await secBtnResult.element.textContent()) || ""
          ).trim();
          if (/skip for now|not now|later|passer|plus tard/i.test(text)) {
            await secBtnResult.element
              .click()
              .catch(
                logError(
                  "LOGIN-PASSKEY",
                  "Secondary button text click failed",
                  this.bot.isMobile,
                ),
              );
            did = true;
            this.logPasskeyOnce("secondary button text");
          }
        }
      }
    }

    // Priority 4: XPath fallback (includes Windows Hello specific patterns)
    if (!did) {
      const textBtn = await page
        .locator(
          'xpath=//button[contains(normalize-space(.),"Skip for now") or contains(normalize-space(.),"Not now") or contains(normalize-space(.),"Passer") or contains(normalize-space(.),"No thanks")]',
        )
        .first();
      // FIXED: Add explicit timeout to isVisible
      if (await textBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await textBtn
          .click()
          .catch(
            logError(
              "LOGIN-PASSKEY",
              "XPath fallback click failed",
              this.bot.isMobile,
            ),
          );
        did = true;
        this.logPasskeyOnce("xpath fallback");
      }
    }

    // Priority 4.5: Windows Hello specific detection
    if (!did) {
      // FIXED: Add explicit timeout
      const windowsHelloTitle = await page
        .locator("text=/windows hello/i")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (windowsHelloTitle) {
        // Try common Windows Hello skip patterns
        const skipPatterns = [
          'button:has-text("Skip")',
          'button:has-text("No thanks")',
          'button:has-text("Maybe later")',
          'button:has-text("Cancel")',
          '[data-testid="secondaryButton"]',
          'button[class*="secondary"]',
        ];
        for (const pattern of skipPatterns) {
          const btn = await page.locator(pattern).first();
          // FIXED: Add explicit timeout
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn
              .click()
              .catch(
                logError(
                  "LOGIN-PASSKEY",
                  "Windows Hello skip failed",
                  this.bot.isMobile,
                ),
              );
            did = true;
            this.logPasskeyOnce("Windows Hello skip");
            break;
          }
        }
      }
    }

    // Priority 5: Close button fallback (FIXED: Add explicit timeout instead of using page.$)
    if (!did) {
      const closeResult = await waitForElementSmart(page, "#close-button", {
        initialTimeoutMs: 300,
        extendedTimeoutMs: 500,
        state: "visible",
      });

      if (closeResult.found && closeResult.element) {
        await closeResult.element
          .click()
          .catch(
            logError(
              "LOGIN-PASSKEY",
              "Close button fallback failed",
              this.bot.isMobile,
            ),
          );
        did = true;
        this.logPasskeyOnce("close button");
      }
    }

    // KMSI prompt
    const kmsi = await page
      .waitForSelector(PasskeyHandler.SELECTORS.kmsiVideo, { timeout: 400 })
      .catch(() => null);
    if (kmsi) {
      const yes = await page.$(PasskeyHandler.SELECTORS.passkeyPrimary);
      if (yes) {
        await yes
          .click()
          .catch(
            logError(
              "LOGIN-KMSI",
              "KMSI accept click failed",
              this.bot.isMobile,
            ),
          );
        did = true;
        this.bot.log(this.bot.isMobile, "LOGIN-KMSI", "Accepted KMSI prompt");
      }
    }

    if (!did && context === "main") {
      this.noPromptIterations++;
      const now = Date.now();
      if (this.noPromptIterations === 1 || now - this.lastNoPromptLog > 10000) {
        this.lastNoPromptLog = now;
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-NO-PROMPT",
          `No dialogs (x${this.noPromptIterations})`,
        );
        if (this.noPromptIterations > 50) this.noPromptIterations = 0;
      }
    } else if (did) {
      this.noPromptIterations = 0;
    }
  }

  private async clickFirstVisible(
    page: Page,
    selectors: string[],
    timeoutMs = 300,
  ): Promise<boolean> {
    for (const selector of selectors) {
      const el = page.locator(selector).first();
      const visible = await el
        .isVisible({ timeout: timeoutMs })
        .catch(() => false);
      if (!visible) continue;

      await el
        .click()
        .catch(
          logError(
            "LOGIN-PASSKEY",
            `Click failed for ${selector}`,
            this.bot.isMobile,
          ),
        );
      return true;
    }
    return false;
  }

  private logPasskeyOnce(reason: string) {
    if (this.passkeyHandled) return;
    this.passkeyHandled = true;
    this.bot.log(
      this.bot.isMobile,
      "LOGIN-PASSKEY",
      `Dismissed passkey prompt (${reason})`,
    );
  }

  /**
   * Handle QR Code Passkey dialog that appears after TOTP authentication
   * This dialog is a modal that blocks interaction with the page
   */
  private async handleQrCodePasskeyDialog(page: Page): Promise<boolean> {
    try {
      // Method 1: Check for specific text content indicating QR code dialog
      const qrCodeTextVisible = await page
        .locator("text=/use your phone or tablet|scan this QR code|passkeys/i")
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);

      if (!qrCodeTextVisible) return false;

      this.bot.log(
        this.bot.isMobile,
        "LOGIN-PASSKEY",
        "Detected QR code passkey dialog, attempting dismissal",
      );

      // Method 2: Try keyboard ESC first (works for many dialogs)
      await page.keyboard.press("Escape").catch(() => {});
      await this.bot.utils.wait(300);

      // Method 3: Check if dialog still visible after ESC
      const stillVisible = await page
        .locator("text=/use your phone or tablet|scan this QR code/i")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (!stillVisible) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-PASSKEY",
          "QR code dialog dismissed via ESC",
        );
        return true;
      }

      // Method 4: Try clicking Back or Cancel buttons
      const dismissed = await this.clickFirstVisible(
        page,
        [
          PasskeyHandler.SELECTORS.backButton,
          PasskeyHandler.SELECTORS.cancelButton,
          'button:has-text("Retour")', // French
          'button:has-text("Annuler")', // French
          'button:has-text("No thanks")',
          'button:has-text("Maybe later")',
          '[data-testid="secondaryButton"]',
          'button[class*="secondary"]',
        ],
        500,
      );

      if (dismissed) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-PASSKEY",
          "QR code dialog dismissed via button click",
        );
        return true;
      }

      // Method 5: JavaScript injection to close dialog
      const jsResult = await page
        .evaluate(() => {
          // Find dialog by role
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const text = dialog.textContent || "";
            if (/passkey|qr code|phone or tablet/i.test(text)) {
              // Try to find and click cancel/back button
              const buttons = dialog.querySelectorAll("button");
              for (const btn of buttons) {
                const btnText = (btn.textContent || "").toLowerCase();
                if (
                  /back|cancel|retour|annuler|no thanks|maybe later|skip/i.test(
                    btnText,
                  )
                ) {
                  btn.click();
                  return true;
                }
              }
              // If no button found, try to remove dialog from DOM
              dialog.remove();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);

      if (jsResult) {
        this.bot.log(
          this.bot.isMobile,
          "LOGIN-PASSKEY",
          "QR code dialog dismissed via JavaScript injection",
        );
        return true;
      }

      this.bot.log(
        this.bot.isMobile,
        "LOGIN-PASSKEY",
        "Failed to dismiss QR code dialog with all methods",
        "warn",
      );
      return false;
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "LOGIN-PASSKEY",
        `QR code dialog handler error: ${error}`,
        "error",
      );
      return false;
    }
  }
}
