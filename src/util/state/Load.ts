import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import fs from "fs";
import path from "path";
import { BrowserContext, Cookie } from "rebrowser-playwright";
import { Account } from "../../interface/Account";
import {
    Config,
    ConfigBrowser,
    ConfigSaveFingerprint,
    ConfigScheduling,
} from "../../interface/Config";
import { removeTrailingCommas, stripJsonComments } from "../core/JsoncParser";
import { getErrorMessage, Util } from "../core/Utils";

const utils = new Util();

let configCache: Config;
let configSourcePath = "";

// Normalize both legacy (flat) and new (nested) config schemas into the flat Config interface
function normalizeConfig(raw: unknown): Config {
  // TYPE SAFETY: Validate raw input before processing
  // Config files are untrusted JSON that could have any structure
  // We use explicit runtime checks for each property below
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a valid object");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = raw as Record<string, any>;

  // Browser settings
  const browserConfig = n.browser ?? {};
  const headless =
    process.env.FORCE_HEADLESS === "1"
      ? true
      : typeof browserConfig.headless === "boolean"
        ? browserConfig.headless
        : typeof n.headless === "boolean"
          ? n.headless
          : false; // COMPATIBILITY: Flat headless field (pre-v2.50)

  const globalTimeout = browserConfig.globalTimeout ?? n.globalTimeout ?? "30s";
  const browser: ConfigBrowser = {
    headless,
    globalTimeout: utils.stringToMs(globalTimeout),
  };

  // Execution
  const parallel = n.execution?.parallel ?? n.parallel ?? false;
  const runOnZeroPoints =
    n.execution?.runOnZeroPoints ?? n.runOnZeroPoints ?? false;
  const clusters = n.execution?.clusters ?? n.clusters ?? 1;
  const passesPerRun = n.execution?.passesPerRun ?? n.passesPerRun;

  // Search
  const useLocalQueries =
    n.search?.useLocalQueries ?? n.searchOnBingLocalQueries ?? false;
  const searchSettingsSrc = n.search?.settings ?? n.searchSettings ?? {};
  const delaySrc = searchSettingsSrc.delay ??
    searchSettingsSrc.searchDelay ?? { min: "3min", max: "5min" };
  const searchSettings = {
    useGeoLocaleQueries: !!(searchSettingsSrc.useGeoLocaleQueries ?? false),
    scrollRandomResults: !!(searchSettingsSrc.scrollRandomResults ?? false),
    clickRandomResults: !!(searchSettingsSrc.clickRandomResults ?? false),
    retryMobileSearchAmount: Number(
      searchSettingsSrc.retryMobileSearchAmount ?? 2,
    ),
    searchDelay: {
      min: delaySrc.min ?? "3min",
      max: delaySrc.max ?? "5min",
    },
    localFallbackCount: Number(searchSettingsSrc.localFallbackCount ?? 25),
    extraFallbackRetries: Number(searchSettingsSrc.extraFallbackRetries ?? 1),
  };

  // Workers
  const workers = n.workers ?? {
    doDailySet: true,
    doMorePromotions: true,
    doPunchCards: true,
    doDesktopSearch: true,
    doMobileSearch: true,
    doDailyCheckIn: true,
    doReadToEarn: true,
    bundleDailySetWithSearch: false,
  };
  // Ensure missing flag gets a default
  if (typeof workers.bundleDailySetWithSearch !== "boolean")
    workers.bundleDailySetWithSearch = false;

  // Logging
  const logging = n.logging ?? {};
  const logExcludeFunc = Array.isArray(logging.excludeFunc)
    ? logging.excludeFunc
    : (n.logExcludeFunc ?? []);
  const webhookLogExcludeFunc = Array.isArray(logging.webhookExcludeFunc)
    ? logging.webhookExcludeFunc
    : (n.webhookLogExcludeFunc ?? []);

  // Notifications
  const notifications = n.notifications ?? {};
  const webhook = notifications.webhook ??
    n.webhook ?? { enabled: false, url: "" };
  // Support both "summaryWebhook" (new) and "conclusionWebhook" (legacy)
  const summaryWebhook = notifications.summaryWebhook ??
    n.summaryWebhook ??
    notifications.conclusionWebhook ??
    n.conclusionWebhook ?? { enabled: false, url: "" };
  const stoat = notifications.stoat ?? n.stoat ?? { enabled: false, url: "" };
  const ntfy = notifications.ntfy ??
    n.ntfy ?? { enabled: false, url: "", topic: "", authToken: "" };

  // Fingerprinting
  const saveFingerprint = n.fingerprinting?.saveFingerprint ??
    n.saveFingerprint ?? { mobile: false, desktop: false };

  // Humanization defaults (single on/off)
  // FIXED: Always initialize humanization object first to prevent undefined access
  if (!n.humanization) n.humanization = {};
  if (typeof n.humanization.enabled !== "boolean")
    n.humanization.enabled = true;
  if (typeof n.humanization.stopOnBan !== "boolean")
    n.humanization.stopOnBan = false;
  if (typeof n.humanization.immediateBanAlert !== "boolean")
    n.humanization.immediateBanAlert = true;
  if (typeof n.humanization.randomOffDaysPerWeek !== "number") {
    n.humanization.randomOffDaysPerWeek = 1;
  }
  // Strong default gestures when enabled (explicit values still win)
  if (typeof n.humanization.gestureMoveProb !== "number") {
    n.humanization.gestureMoveProb = !n.humanization.enabled ? 0 : 0.5;
  }
  if (typeof n.humanization.gestureScrollProb !== "number") {
    n.humanization.gestureScrollProb = !n.humanization.enabled ? 0 : 0.25;
  }

  // Vacation mode (monthly contiguous off-days) - REMOVED (not implemented)

  const riskRaw = (n.riskManagement ?? {}) as Record<string, unknown>;
  const hasRiskCfg = Object.keys(riskRaw).length > 0;
  const riskManagement = hasRiskCfg
    ? {
        enabled: riskRaw.enabled === true,
        stopOnCritical: riskRaw.stopOnCritical === true,
      }
    : undefined;

  const queryDiversityRaw = (n.queryDiversity ?? {}) as Record<string, unknown>;
  const hasQueryCfg = Object.keys(queryDiversityRaw).length > 0;
  const queryDiversity = hasQueryCfg
    ? {
        enabled: queryDiversityRaw.enabled === true,
        sources:
          Array.isArray(queryDiversityRaw.sources) &&
          queryDiversityRaw.sources.length
            ? (queryDiversityRaw.sources.filter(
                (s: unknown) => typeof s === "string",
              ) as Array<
                | "google-trends"
                | "reddit"
                | "news"
                | "wikipedia"
                | "local-fallback"
              >)
            : undefined,
        maxQueriesPerSource:
          typeof queryDiversityRaw.maxQueriesPerSource === "number"
            ? queryDiversityRaw.maxQueriesPerSource
            : undefined,
        cacheMinutes:
          typeof queryDiversityRaw.cacheMinutes === "number"
            ? queryDiversityRaw.cacheMinutes
            : undefined,
      }
    : undefined;

  const dryRun = n.dryRun === true;

  const jobStateRaw = (n.jobState ?? {}) as Record<string, unknown>;
  const jobState = {
    enabled: jobStateRaw.enabled !== false,
    dir: typeof jobStateRaw.dir === "string" ? jobStateRaw.dir : undefined,
    skipCompletedAccounts: jobStateRaw.skipCompletedAccounts !== false,
  };

  const dashboardRaw = (n.dashboard ?? {}) as Record<string, unknown>;
  const dashboard = {
    enabled: dashboardRaw.enabled === true,
    port: typeof dashboardRaw.port === "number" ? dashboardRaw.port : 3000,
    host:
      typeof dashboardRaw.host === "string" ? dashboardRaw.host : "127.0.0.1",
  };

  const scheduling = buildSchedulingConfig(n.scheduling);

  const cfg: Config = {
    baseURL: n.baseURL ?? "https://lgtw.tf/Microsoft-Rewards-Bot-Legacy",
    sessionPath: n.sessionPath ?? "sessions",
    browser,
    parallel,
    runOnZeroPoints,
    clusters,
    saveFingerprint,
    workers,
    searchOnBingLocalQueries: !!useLocalQueries,
    globalTimeout,
    searchSettings,
    humanization: n.humanization,
    retryPolicy: n.retryPolicy,
    jobState,
    logExcludeFunc,
    webhookLogExcludeFunc,
    logging, // retain full logging object for live webhook usage
    proxy: n.proxy ?? { proxyGoogleTrends: true, proxyBingTerms: true },
    webhook,
    summaryWebhook,
    stoat,
    ntfy,
    update: n.update,
    passesPerRun: passesPerRun,
    crashRecovery: n.crashRecovery || {},
    riskManagement,
    dryRun,
    queryDiversity,
    dashboard,
    scheduling,
  };

  return cfg;
}

// IMPROVED: Generic helper to reduce duplication
function extractStringField(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function buildSchedulingConfig(raw: unknown): ConfigScheduling | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const source = raw as Record<string, unknown>;
  const scheduling: ConfigScheduling = {
    enabled: source.enabled === true,
  };

  // Priority 1: Simple time format (recommended)
  const timeField = extractStringField(source, "time");
  if (timeField) {
    scheduling.time = timeField;
  }

  // Priority 2: COMPATIBILITY format (cron.schedule field, pre-v2.58)
  const cronRaw = source.cron;
  if (cronRaw && typeof cronRaw === "object") {
    scheduling.cron = {
      schedule: extractStringField(cronRaw, "schedule"),
    };
  }

  return scheduling;
}

export function loadAccounts(): Account[] {
  try {
    // 1) CLI dev override
    let file = "accounts.json";
    if (process.argv.includes("-dev")) {
      file = "accounts.dev.json";
    }

    // 2) Docker-friendly env overrides
    const envJson = process.env.ACCOUNTS_JSON;
    const envFile = process.env.ACCOUNTS_FILE;

    let raw: string | undefined;
    if (envJson && envJson.trim().startsWith("[")) {
      raw = envJson;
    } else if (envFile && envFile.trim()) {
      const full = path.isAbsolute(envFile)
        ? envFile
        : path.join(process.cwd(), envFile);
      if (!fs.existsSync(full)) {
        throw new Error(`ACCOUNTS_FILE not found: ${full}`);
      }
      raw = fs.readFileSync(full, "utf-8");
    } else {
      // Try multiple locations to support both root mounts and dist mounts
      // Support both .json and .jsonc extensions
      const candidates = [
        path.join(__dirname, "../", file), // root/accounts.json (preferred)
        path.join(__dirname, "../", file + "c"), // root/accounts.jsonc
        path.join(__dirname, "../src", file), // fallback: file kept inside src/
        path.join(__dirname, "../src", file + "c"), // src/accounts.jsonc
        path.join(process.cwd(), file), // cwd override
        path.join(process.cwd(), file + "c"), // cwd/accounts.jsonc
        path.join(process.cwd(), "src", file), // cwd/src/accounts.json
        path.join(process.cwd(), "src", file + "c"), // cwd/src/accounts.jsonc
        path.join(__dirname, file), // dist/accounts.json (compiled output)
        path.join(__dirname, file + "c"), // dist/accounts.jsonc
      ];
      let chosen: string | null = null;
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            chosen = p;
            break;
          }
        } catch (e) {
          // Filesystem check failed for this path, try next
          continue;
        }
      }
      if (!chosen)
        throw new Error(
          `accounts file not found in: ${candidates.join(" | ")}`,
        );
      raw = fs.readFileSync(chosen, "utf-8");
    }

    // Support comments in accounts file (same as config)
    const cleaned = removeTrailingCommas(stripJsonComments(raw));
    const parsedUnknown = JSON.parse(cleaned);
    // Accept either a root array or an object with an `accounts` array, ignore `_note`
    const parsed = Array.isArray(parsedUnknown)
      ? parsedUnknown
      : parsedUnknown &&
          typeof parsedUnknown === "object" &&
          Array.isArray((parsedUnknown as { accounts?: unknown }).accounts)
        ? (parsedUnknown as { accounts: unknown[] }).accounts
        : null;
    if (!Array.isArray(parsed)) throw new Error("accounts must be an array");
    // TYPE SAFETY: Validate entries BEFORE processing
    for (const entry of parsed) {
      // Pre-validation: Check basic structure
      if (!entry || typeof entry !== "object") {
        throw new Error("each account entry must be an object");
      }

      // Use Record<string, unknown> to access dynamic properties from untrusted JSON
      // Runtime validation below ensures type safety
      const a = entry as Record<string, unknown>;

      // Validate required fields with proper type checking
      if (typeof a.email !== "string" || typeof a.password !== "string") {
        throw new Error("each account must have email and password strings");
      }
      a.email = String(a.email).trim();
      a.password = String(a.password);

      // Simplified recovery email logic: if present and non-empty, validate it
      if (typeof a.recoveryEmail === "string") {
        const trimmed = a.recoveryEmail.trim();
        if (trimmed !== "") {
          if (!/@/.test(trimmed)) {
            throw new Error(
              `account ${a.email} recoveryEmail must be a valid email address (got: "${trimmed}")`,
            );
          }
          a.recoveryEmail = trimmed;
        } else {
          a.recoveryEmail = undefined;
        }
      } else {
        a.recoveryEmail = undefined;
      }

      if (!a.proxy || typeof a.proxy !== "object") {
        a.proxy = {
          proxyAxios: false,
          url: "",
          port: 0,
          username: "",
          password: "",
        };
      } else {
        // Safe proxy property access with runtime validation
        const proxy = a.proxy as Record<string, unknown>;
        a.proxy = {
          proxyAxios: proxy.proxyAxios !== false,
          url: typeof proxy.url === "string" ? proxy.url : "",
          port: typeof proxy.port === "number" ? proxy.port : 0,
          username: typeof proxy.username === "string" ? proxy.username : "",
          password: typeof proxy.password === "string" ? proxy.password : "",
        };
      }
    }
    // Filter out disabled accounts (enabled: false)
    const allAccounts = parsed as Account[];
    const enabledAccounts = allAccounts.filter((acc) => acc.enabled !== false);
    return enabledAccounts;
  } catch (error) {
    throw new Error(`Failed to load accounts: ${getErrorMessage(error)}`);
  }
}

export function getConfigPath(): string {
  return configSourcePath;
}

export function loadConfig(): Config {
  try {
    if (configCache) {
      return configCache;
    }

    // Resolve configuration file from common locations (supports .jsonc and .json)
    const names = ["config.jsonc", "config.json"];
    const bases = [
      path.join(__dirname, "../"), // dist root when compiled
      path.join(__dirname, "../src"), // fallback: running dist but config still in src
      process.cwd(), // repo root
      path.join(process.cwd(), "src"), // repo/src when running ts-node
      __dirname, // dist/util
    ];
    const candidates: string[] = [];
    for (const base of bases) {
      for (const name of names) {
        candidates.push(path.join(base, name));
      }
    }

    let cfgPath: string | null = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          cfgPath = p;
          break;
        }
      } catch (e) {
        // Filesystem check failed for this path, try next
        continue;
      }
    }
    if (!cfgPath)
      throw new Error(`config.json not found in: ${candidates.join(" | ")}`);
    const config = fs.readFileSync(cfgPath, "utf-8");
    const text = config.replace(/^\uFEFF/, "");
    const raw = JSON.parse(removeTrailingCommas(stripJsonComments(text)));
    const normalized = normalizeConfig(raw);
    configCache = normalized;
    configSourcePath = cfgPath;

    return normalized;
  } catch (error) {
    throw new Error(`Failed to load config: ${getErrorMessage(error)}`);
  }
}

interface SessionData {
  cookies: Cookie[];
  fingerprint?: BrowserFingerprintWithHeaders;
}

export async function loadSessionData(
  sessionPath: string,
  email: string,
  isMobile: boolean,
  saveFingerprint: ConfigSaveFingerprint,
): Promise<SessionData> {
  try {
    // FIXED: Use process.cwd() instead of __dirname for sessions (consistent with JobState and SessionLoader)
    const cookieFile = path.join(
      process.cwd(),
      sessionPath,
      email,
      `${isMobile ? "mobile_cookies" : "desktop_cookies"}.json`,
    );

    let cookies: Cookie[] = [];
    if (fs.existsSync(cookieFile)) {
      const cookiesData = await fs.promises.readFile(cookieFile, "utf-8");
      cookies = JSON.parse(cookiesData);
    }

    // Fetch fingerprint file
    const baseDir = path.join(process.cwd(), sessionPath, email);
    const fingerprintFile = path.join(
      baseDir,
      `${isMobile ? "mobile_fingerprint" : "desktop_fingerprint"}.json`,
    );

    let fingerprint: BrowserFingerprintWithHeaders | undefined;
    const shouldLoad =
      (saveFingerprint.desktop && !isMobile) ||
      (saveFingerprint.mobile && isMobile);
    if (shouldLoad && fs.existsSync(fingerprintFile)) {
      const fingerprintData = await fs.promises.readFile(
        fingerprintFile,
        "utf-8",
      );
      fingerprint = JSON.parse(fingerprintData);

      // CRITICAL: Validate fingerprint age (regenerate if too old)
      // Old fingerprints become suspicious as browser versions update
      const fingerprintStat = await fs.promises.stat(fingerprintFile);
      const ageInDays =
        (Date.now() - fingerprintStat.mtimeMs) / (1000 * 60 * 60 * 24);

      // SECURITY: Regenerate fingerprint if older than 30 days
      if (ageInDays > 30) {
        // Mark as undefined to trigger regeneration
        fingerprint = undefined;
      }
    }

    return {
      cookies: cookies,
      fingerprint: fingerprint,
    };
  } catch (error) {
    throw new Error(
      `Failed to load session data for ${email}: ${getErrorMessage(error)}`,
    );
  }
}

export async function saveSessionData(
  sessionPath: string,
  browser: BrowserContext,
  email: string,
  isMobile: boolean,
): Promise<string> {
  try {
    const cookies = await browser.cookies();

    // FIXED: Use process.cwd() instead of __dirname for sessions
    const sessionDir = path.join(process.cwd(), sessionPath, email);

    // Create session dir
    if (!fs.existsSync(sessionDir)) {
      await fs.promises.mkdir(sessionDir, { recursive: true });
    }

    // Save cookies to a file
    await fs.promises.writeFile(
      path.join(
        sessionDir,
        `${isMobile ? "mobile_cookies" : "desktop_cookies"}.json`,
      ),
      JSON.stringify(cookies, null, 2),
    );

    return sessionDir;
  } catch (error) {
    throw new Error(
      `Failed to save session data for ${email}: ${getErrorMessage(error)}`,
    );
  }
}

export async function saveFingerprintData(
  sessionPath: string,
  email: string,
  isMobile: boolean,
  fingerprint: BrowserFingerprintWithHeaders,
): Promise<string> {
  try {
    // FIXED: Use process.cwd() instead of __dirname for sessions
    const sessionDir = path.join(process.cwd(), sessionPath, email);

    // Create session dir
    if (!fs.existsSync(sessionDir)) {
      await fs.promises.mkdir(sessionDir, { recursive: true });
    }

    // Save fingerprint to file
    const fingerprintPath = path.join(
      sessionDir,
      `${isMobile ? "mobile_fingerprint" : "desktop_fingerprint"}.json`,
    );
    const payload = JSON.stringify(fingerprint);
    await fs.promises.writeFile(fingerprintPath, payload);

    return sessionDir;
  } catch (error) {
    throw new Error(
      `Failed to save fingerprint for ${email}: ${getErrorMessage(error)}`,
    );
  }
}
