import { Browser } from "../browser/Browser";
import { MicrosoftRewardsBot } from "../index";
import type { AccountProxy } from "../interface/Account";
import { getErrorMessage } from "../util/core/Utils";
import { log } from "../util/notifications/Logger";
import { secureRandom } from "../util/security/SecureRandom";
import { AccountCreator } from "./AccountCreator";

import * as readline from "readline";

function parseProxyArg(input?: string): AccountProxy | null {
  if (!input) return null;
  try {
    const candidate = input.match(/^[a-z]+:\/\//i) ? input : `http://${input}`;
    const parsed = new URL(candidate);
    const url = `${parsed.protocol}//${parsed.hostname}`;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    return {
      proxyAxios: true,
      url,
      port,
      username: decodeURIComponent(parsed.username || ""),
      password: decodeURIComponent(parsed.password || ""),
    };
  } catch (error) {
    const msg = getErrorMessage(error);
    log(
      false,
      "CREATOR-CLI",
      `Invalid proxy provided: ${msg}`,
      "warn",
      "yellow",
    );
    return null;
  }
}

async function askForUrl(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("   👉 Please paste the FULL URL here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  // Parse command line args
  const args = process.argv.slice(2);
  let referralUrl: string | undefined;
  let recoveryEmail: string | undefined;
  let autoAccept = false;
  let proxyConfig: AccountProxy | null = parseProxyArg(
    process.env.CREATOR_PROXY_URL,
  );

  // Parse arguments - ULTRA SIMPLE
  for (const arg of args) {
    if (!arg) continue;

    if (arg === "-y" || arg === "--yes" || arg === "y" || arg === "Y") {
      autoAccept = true;
    } else if (arg.startsWith("http")) {
      referralUrl = arg;
    } else if (arg.includes("@")) {
      // Auto-detect email addresses
      recoveryEmail = arg;
    } else if (arg.startsWith("--proxy=")) {
      proxyConfig = parseProxyArg(arg.substring("--proxy=".length));
    } else if (referralUrl && (arg.includes("=") || arg.startsWith("&"))) {
      // SMART FIX: Detect leftover URL fragments from CMD/PowerShell & splitting
      // When user forgets quotes, CMD splits at & and passes fragments as separate args
      // We append these fragments back to the URL to preserve the full link
      // Example: "https://...?rh=CODE&ref=X" becomes ["https://...?rh=CODE", "ref=X"]
      const fragment = arg.startsWith("&") ? arg.substring(1) : arg;
      referralUrl += "&" + fragment;
      log(
        false,
        "CREATOR-CLI",
        `🔗 Re-attached URL fragment: &${fragment}`,
        "log",
        "gray",
      );
    }
  }

  // AUTO-FIX: Ensure referral URL has &new=1 parameter (REQUIRED for referral to work)
  if (referralUrl) {
    // WARNING: Check for truncated URL (common issue with PowerShell/CMD)
    if (referralUrl.includes("rh=") && !referralUrl.includes("ref=")) {
      log(false, "CREATOR-CLI", "", "log");
      log(
        false,
        "CREATOR-CLI",
        "⚠️  POSSIBLE URL TRUNCATION DETECTED",
        "warn",
        "yellow",
      );
      log(
        false,
        "CREATOR-CLI",
        "   The referral URL seems to be missing parameters (ref=, form=, etc.)",
        "warn",
        "yellow",
      );
      log(
        false,
        "CREATOR-CLI",
        '   This usually happens because the "&" character cuts off the command.',
        "warn",
        "yellow",
      );

      // INTERACTIVE FIX: Ask user to paste the full URL
      log(
        false,
        "CREATOR-CLI",
        "   🛑 AUTOMATIC PAUSE: To prevent failure, please provide the full URL.",
        "warn",
        "yellow",
      );
      const newUrl = await askForUrl();
      if (newUrl && newUrl.startsWith("http")) {
        referralUrl = newUrl;
        log(
          false,
          "CREATOR-CLI",
          "✅ URL updated successfully!",
          "log",
          "green",
        );
      } else {
        log(
          false,
          "CREATOR-CLI",
          "⚠️  Invalid URL provided, continuing with truncated URL...",
          "warn",
          "yellow",
        );
      }
    }

    // Remove any existing &new=1 to avoid duplication
    referralUrl = referralUrl.replace(/&new=1/g, "");

    // Add &new=1 at the end (CRITICAL for referral linking)
    if (!referralUrl.includes("?")) {
      referralUrl += "?new=1";
    } else {
      referralUrl += "&new=1";
    }

    log(
      false,
      "CREATOR-CLI",
      "✅ Referral URL configured with &new=1 parameter",
      "log",
      "green",
    );
  }

  // Banner
  log(false, "CREATOR-CLI", "", "log"); // Empty line
  log(false, "CREATOR-CLI", "=".repeat(60), "log", "cyan");
  log(false, "CREATOR-CLI", "🚀 Microsoft Account Creator", "log", "cyan");
  log(false, "CREATOR-CLI", "=".repeat(60), "log", "cyan");
  log(
    false,
    "CREATOR-CLI",
    "⚠️  DO NOT INTERACT WITH THE BROWSER DURING AUTOMATION",
    "warn",
    "yellow",
  );
  log(
    false,
    "CREATOR-CLI",
    "   Everything is fully automated. Any interaction may break the process.",
    "warn",
    "yellow",
  );
  log(
    false,
    "CREATOR-CLI",
    "   Only interact when explicitly asked (e.g., CAPTCHA solving).",
    "warn",
    "yellow",
  );
  log(false, "CREATOR-CLI", "=".repeat(60), "log", "cyan");
  log(false, "CREATOR-CLI", "Recommended anti-detection flow:", "log", "cyan");
  log(
    false,
    "CREATOR-CLI",
    " 1) Use a residential/ISP proxy and keep region/timezone consistent.",
    "log",
    "gray",
  );
  log(
    false,
    "CREATOR-CLI",
    " 2) After creation, stay logged in 2–3 min, browse Outlook/Bing manually, then sign out.",
    "log",
    "gray",
  );
  log(
    false,
    "CREATOR-CLI",
    " 3) Wait 48–72h (ideally 5–7 days) before first Rewards run from the same IP/UA.",
    "log",
    "gray",
  );
  log(
    false,
    "CREATOR-CLI",
    " 4) Space creations: 5–10 min minimum between accounts; avoid bursts.",
    "log",
    "gray",
  );
  log(false, "CREATOR-CLI", "=".repeat(60), "log", "cyan");
  log(false, "CREATOR-CLI", "", "log"); // Empty line

  // Show usage help if no arguments passed
  if (args.length === 0) {
    log(false, "CREATOR-CLI", "📖 Usage Examples:", "log", "cyan");
    log(
      false,
      "CREATOR-CLI",
      "   npm run creator -- -y                                    # Auto mode",
      "log",
      "gray",
    );
    log(
      false,
      "CREATOR-CLI",
      "   npm run creator -- -y email@gmail.com                     # With recovery email",
      "log",
      "gray",
    );
    log(
      false,
      "CREATOR-CLI",
      '   npm run creator -- -y email@gmail.com "https://rewards..." # Full automation (QUOTES REQUIRED!)',
      "log",
      "gray",
    );
    log(
      false,
      "CREATOR-CLI",
      '   npm run creator -- --proxy=http://user:pass@host:port -y email@gmail.com "https://rewards..." # With proxy',
      "log",
      "gray",
    );
    log(
      false,
      "CREATOR-CLI",
      '   CREATOR_PROXY_URL=http://user:pass@host:port npm run creator -- -y email@gmail.com "https://rewards..."  # Proxy via env',
      "log",
      "gray",
    );
    log(false, "CREATOR-CLI", "", "log");
    log(
      false,
      "CREATOR-CLI",
      "⚠️  IMPORTANT: Put -y and email BEFORE the URL!",
      "warn",
      "yellow",
    );
    log(
      false,
      "CREATOR-CLI",
      '⚠️  IMPORTANT: Always put QUOTES around the URL if it contains "&"',
      "warn",
      "yellow",
    );
    log(false, "CREATOR-CLI", "", "log");
  }

  // Display detected arguments
  if (referralUrl) {
    log(
      false,
      "CREATOR-CLI",
      `✅ Referral URL: ${referralUrl}`,
      "log",
      "green",
    );
  } else {
    log(
      false,
      "CREATOR-CLI",
      "⚠️  No referral URL - account will NOT be linked to rewards",
      "warn",
      "yellow",
    );
  }

  if (recoveryEmail) {
    log(
      false,
      "CREATOR-CLI",
      `✅ Recovery email: ${recoveryEmail}`,
      "log",
      "green",
    );
  }

  if (proxyConfig) {
    log(
      false,
      "CREATOR-CLI",
      `🔒 Using proxy: ${proxyConfig.url}:${proxyConfig.port}`,
      "log",
      "green",
    );
  } else {
    log(
      false,
      "CREATOR-CLI",
      "⚠️  No proxy provided for account creation; IP reuse increases ban risk. Pass --proxy=host:port or set CREATOR_PROXY_URL.",
      "warn",
      "yellow",
    );
  }

  if (autoAccept) {
    log(
      false,
      "CREATOR-CLI",
      "⚡ Auto-accept mode ENABLED (-y flag detected)",
      "log",
      "green",
    );
    log(
      false,
      "CREATOR-CLI",
      "🤖 All prompts will be auto-accepted",
      "log",
      "cyan",
    );
  } else {
    log(
      false,
      "CREATOR-CLI",
      "🤖 Interactive mode: you will be asked for options",
      "log",
      "cyan",
    );
    log(
      false,
      "CREATOR-CLI",
      "💡 Tip: Use -y flag to auto-accept all prompts",
      "log",
      "gray",
    );
  }

  log(false, "CREATOR-CLI", "", "log"); // Empty line

  // Create a temporary bot instance to access browser creation
  const bot = new MicrosoftRewardsBot(false);
  // Disable fingerprint persistence for creator to avoid reusing same fingerprint across many accounts
  bot.config.saveFingerprint = { mobile: false, desktop: false };
  bot.config.fingerprinting = {
    ...bot.config.fingerprinting,
    saveFingerprint: { mobile: false, desktop: false },
  };
  const browserFactory = new Browser(bot);

  try {
    // Create browser (non-headless for user interaction with CAPTCHA)
    log(
      false,
      "CREATOR-CLI",
      "Opening browser (required for CAPTCHA solving)...",
      "log",
    );

    const effectiveProxy: AccountProxy = proxyConfig ?? {
      proxyAxios: false,
      url: "",
      port: 0,
      password: "",
      username: "",
    };

    // Use unique session id per creation to avoid fingerprint/cookie reuse between accounts
    const sessionId = `account-creator-${Date.now().toString(36)}-${secureRandom().toString(36).slice(2, 8)}`;
    const browserContext = await browserFactory.createBrowser(
      effectiveProxy,
      sessionId,
    );

    log(false, "CREATOR-CLI", "✅ Browser opened successfully", "log", "green");

    // Create account
    const creator = new AccountCreator(referralUrl, recoveryEmail, autoAccept);
    const result = await creator.create(browserContext);

    if (result) {
      // Success banner
      log(false, "CREATOR-CLI", "", "log"); // Empty line
      log(false, "CREATOR-CLI", "=".repeat(60), "log", "green");
      log(
        false,
        "CREATOR-CLI",
        "✅ ACCOUNT CREATED SUCCESSFULLY!",
        "log",
        "green",
      );
      log(false, "CREATOR-CLI", "=".repeat(60), "log", "green");

      // Display account details
      log(false, "CREATOR-CLI", `📧 Email: ${result.email}`, "log", "cyan");
      log(
        false,
        "CREATOR-CLI",
        `🔐 Password: ${result.password}`,
        "log",
        "cyan",
      );
      log(
        false,
        "CREATOR-CLI",
        `👤 Name: ${result.firstName} ${result.lastName}`,
        "log",
        "cyan",
      );
      log(
        false,
        "CREATOR-CLI",
        `🎂 Birthdate: ${result.birthdate.day}/${result.birthdate.month}/${result.birthdate.year}`,
        "log",
        "cyan",
      );

      if (result.referralUrl) {
        log(false, "CREATOR-CLI", "🔗 Referral: Linked", "log", "green");
      }

      log(false, "CREATOR-CLI", "=".repeat(60), "log", "green");
      log(
        false,
        "CREATOR-CLI",
        "💾 Account details saved to accounts-created/ directory",
        "log",
        "green",
      );
      log(false, "CREATOR-CLI", "=".repeat(60), "log", "green");
      log(false, "CREATOR-CLI", "", "log"); // Empty line

      // Keep browser open - don't close
      log(
        false,
        "CREATOR-CLI",
        "✅ Account creation complete! Browser will remain open.",
        "log",
        "green",
      );
      log(
        false,
        "CREATOR-CLI",
        "You can now use the account or close the browser manually.",
        "log",
        "cyan",
      );
      log(
        false,
        "CREATOR-CLI",
        "Press Ctrl+C to exit the script.",
        "log",
        "yellow",
      );
      log(false, "CREATOR-CLI", "", "log"); // Empty line
      log(
        false,
        "CREATOR-CLI",
        "⚠️  IMPORTANT: Wait 10-20 minutes before creating another account",
        "warn",
        "yellow",
      );
      log(
        false,
        "CREATOR-CLI",
        "📍 For multiple accounts: Wait longer between each (5-10 min minimum)",
        "warn",
        "yellow",
      );
      log(
        false,
        "CREATOR-CLI",
        "🚫 Creating too many too quickly = Rate limit (24-48 hours blocked)",
        "warn",
        "yellow",
      );

      // Keep process alive indefinitely
      await new Promise(() => {}); // Never resolves
    } else {
      // Failure
      log(false, "CREATOR-CLI", "", "log"); // Empty line
      log(false, "CREATOR-CLI", "=".repeat(60), "error");
      log(false, "CREATOR-CLI", "❌ ACCOUNT CREATION FAILED", "error");
      log(false, "CREATOR-CLI", "=".repeat(60), "error");
      log(false, "CREATOR-CLI", "", "log"); // Empty line

      await browserContext.close();
      process.exit(1);
    }
  } catch (error) {
    const msg = getErrorMessage(error);
    log(false, "CREATOR-CLI", "", "log"); // Empty line
    log(false, "CREATOR-CLI", "=".repeat(60), "error");
    log(false, "CREATOR-CLI", `❌ Fatal error: ${msg}`, "error");
    log(false, "CREATOR-CLI", "=".repeat(60), "error");
    log(false, "CREATOR-CLI", "", "log"); // Empty line
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    log(false, "CREATOR-CLI", `Unhandled error: ${error}`, "error");
    process.exit(1);
  });
}

export { main as createAccountCLI };
