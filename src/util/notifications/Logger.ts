import axios from "axios";
import chalk from "chalk";
import { EventEmitter } from "events";
import { DISCORD, LOGGER_CLEANUP, STOAT } from "../../constants";
import { getErrorMessage } from "../core/Utils";
import { loadConfig } from "../state/Load";
import { sendErrorReport } from "./ErrorReportingWebhook";
import { Ntfy } from "./Ntfy";
import { sendStoatLogBatch } from "./StoatWebhook";

// Event emitter for dashboard log streaming (NO FUNCTION INTERCEPTION)
export const logEventEmitter = new EventEmitter();

/**
 * Safe error logger for catch blocks
 * Use in .catch() to log errors without breaking flow
 * @example await action().catch(logError('ACTION', 'Failed to do something'))
 */
export function logError(
  title: string,
  message: string,
  isMobile: boolean | "main" = "main",
) {
  return (error: unknown) => {
    const errMsg = getErrorMessage(error);
    log(isMobile, title, `${message}: ${errMsg}`, "warn");
  };
}

type WebhookBuffer = {
  lines: string[];
  sending: boolean;
  timer?: NodeJS.Timeout;
};

const webhookBuffers = new Map<string, WebhookBuffer>();

// Periodic cleanup of old/idle webhook buffers to prevent memory leaks
// IMPROVED: Using centralized constants from constants.ts
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  for (const [url, buf] of webhookBuffers.entries()) {
    if (!buf.sending && buf.lines.length === 0) {
      const lastActivity =
        (buf as unknown as { lastActivity?: number }).lastActivity || 0;
      if (now - lastActivity > LOGGER_CLEANUP.BUFFER_MAX_AGE_MS) {
        webhookBuffers.delete(url);
      }
    }
  }
}, LOGGER_CLEANUP.BUFFER_CLEANUP_INTERVAL_MS);

// FIXED: Allow cleanup to be stopped with proper fallback
// unref() prevents process from hanging but may not exist in all environments
if (typeof cleanupInterval.unref === "function") {
  cleanupInterval.unref();
}

/**
 * Stop the webhook buffer cleanup interval
 * Call this during graceful shutdown to prevent memory leaks
 */
export function stopWebhookCleanup(): void {
  clearInterval(cleanupInterval);
}

/**
 * Get or create a webhook buffer for the given URL
 * Buffers batch log messages to reduce Discord API calls
 */
function getBuffer(url: string): WebhookBuffer {
  let buf = webhookBuffers.get(url);
  if (!buf) {
    buf = { lines: [], sending: false };
    webhookBuffers.set(url, buf);
  }
  // Track last activity for cleanup
  (buf as unknown as { lastActivity: number }).lastActivity = Date.now();
  return buf;
}

/**
 * Send batched log messages to a Discord webhook
 * Handles rate limiting and message size constraints
 */
async function sendDiscordBatch(
  url: string,
  buf: WebhookBuffer,
): Promise<void> {
  if (buf.sending) return;
  buf.sending = true;
  while (buf.lines.length > 0) {
    const chunk: string[] = [];
    let currentLength = 0;
    while (buf.lines.length > 0) {
      const next = buf.lines[0]!;
      const projected =
        currentLength + next.length + (chunk.length > 0 ? 1 : 0);
      if (projected > DISCORD.MAX_EMBED_LENGTH && chunk.length > 0) break;
      buf.lines.shift();
      chunk.push(next);
      currentLength = projected;
    }

    const content = chunk.join("\n").slice(0, DISCORD.MAX_EMBED_LENGTH);
    if (!content) {
      continue;
    }

    const payload = {
      username: DISCORD.WEBHOOK_USERNAME,
      avatar_url: DISCORD.AVATAR_URL,
      embeds: [
        {
          description: `\`\`\`\n${content}\n\`\`\``,
          color: determineColorFromContent(content),
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: DISCORD.WEBHOOK_TIMEOUT,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, DISCORD.RATE_LIMIT_DELAY),
      );
    } catch (error) {
      buf.lines = chunk.concat(buf.lines);
      process.stderr.write(
        `[Webhook] Discord live log delivery failed: ${error}\n`,
      );
      break;
    }
  }
  buf.sending = false;
}

/**
 * Send batched log messages to a Stoat/Revolt webhook
 * Handles rate limiting and message size constraints
 */
async function sendStoatBatch(url: string, buf: WebhookBuffer): Promise<void> {
  if (buf.sending) return;
  buf.sending = true;
  while (buf.lines.length > 0) {
    const chunk: string[] = [];
    let currentLength = 0;
    while (buf.lines.length > 0) {
      const next = buf.lines[0]!;
      const projected =
        currentLength + next.length + (chunk.length > 0 ? 1 : 0);
      if (projected > STOAT.MAX_EMBED_LENGTH && chunk.length > 0) break;
      buf.lines.shift();
      chunk.push(next);
      currentLength = projected;
    }

    const content = chunk.join("\n").slice(0, STOAT.MAX_EMBED_LENGTH);
    if (!content) {
      continue;
    }

    try {
      await sendStoatLogBatch(url, content, determineColorFromContent(content));
      await new Promise((resolve) =>
        setTimeout(resolve, STOAT.RATE_LIMIT_DELAY),
      );
    } catch (error) {
      buf.lines = chunk.concat(buf.lines);
      process.stderr.write(
        `[Webhook] Stoat live log delivery failed: ${error}\n`,
      );
      break;
    }
  }
  buf.sending = false;
}

// IMPROVED: Extracted color determination logic for better maintainability
type ColorRule = { pattern: RegExp | string; color: number };
const COLOR_RULES: ColorRule[] = [
  {
    pattern: /\[banned\]|\[security\]|suspended|compromised/i,
    color: DISCORD.COLOR_RED,
  },
  { pattern: /\[error\]|✗/i, color: DISCORD.COLOR_CRIMSON },
  { pattern: /\[warn\]|⚠/i, color: DISCORD.COLOR_ORANGE },
  { pattern: /\[ok\]|✓|complet/i, color: DISCORD.COLOR_GREEN },
  { pattern: /\[main\]/i, color: DISCORD.COLOR_BLUE },
];

function determineColorFromContent(content: string): number {
  const lower = content.toLowerCase();

  // Check rules in priority order
  for (const rule of COLOR_RULES) {
    if (typeof rule.pattern === "string") {
      if (lower.includes(rule.pattern)) return rule.color;
    } else {
      if (rule.pattern.test(lower)) return rule.color;
    }
  }

  return DISCORD.COLOR_GRAY;
}

/**
 * Type guard to check if config has valid logging configuration
 * IMPROVED: Enhanced edge case handling and null checks
 */
function hasValidLogging(config: unknown): config is {
  logging: {
    excludeFunc?: string[];
    webhookExcludeFunc?: string[];
    redactEmails?: boolean;
    liveWebhookUrl?: string;
  };
} {
  if (typeof config !== "object" || config === null) {
    return false;
  }

  if (!("logging" in config)) {
    return false;
  }

  const cfg = config as Record<string, unknown>;
  const logging = cfg.logging;

  if (typeof logging !== "object" || logging === null) {
    return false;
  }

  // Validate optional fields have correct types if present
  const loggingObj = logging as Record<string, unknown>;

  if ("excludeFunc" in loggingObj && !Array.isArray(loggingObj.excludeFunc)) {
    return false;
  }

  if (
    "webhookExcludeFunc" in loggingObj &&
    !Array.isArray(loggingObj.webhookExcludeFunc)
  ) {
    return false;
  }

  if (
    "redactEmails" in loggingObj &&
    typeof loggingObj.redactEmails !== "boolean"
  ) {
    return false;
  }

  if (
    "liveWebhookUrl" in loggingObj &&
    typeof loggingObj.liveWebhookUrl !== "string"
  ) {
    return false;
  }

  return true;
}

function enqueueDiscordLog(url: string, line: string) {
  const buf = getBuffer(url);
  buf.lines.push(line);
  if (!buf.timer) {
    buf.timer = setTimeout(() => {
      buf.timer = undefined;
      void sendDiscordBatch(url, buf);
    }, DISCORD.DEBOUNCE_DELAY);
  }
}

function enqueueStoatLog(url: string, line: string) {
  const buf = getBuffer(url);
  buf.lines.push(line);
  if (!buf.timer) {
    buf.timer = setTimeout(() => {
      buf.timer = undefined;
      void sendStoatBatch(url, buf);
    }, STOAT.DEBOUNCE_DELAY);
  }
}

/**
 * Centralized logging function with console, Discord webhook, and NTFY support
 * @param isMobile - Platform identifier ('main', true for mobile, false for desktop)
 * @param title - Log title/category (e.g., 'LOGIN', 'SEARCH')
 * @param message - Log message content
 * @param type - Log level (log, warn, error)
 * @param color - Optional chalk color override
 * @returns Error object if type is 'error' (allows `throw log(...)`)
 * @example log('main', 'STARTUP', 'Bot started', 'log')
 * @example throw log(false, 'LOGIN', 'Auth failed', 'error')
 */
export function log(
  isMobile: boolean | "main",
  title: string,
  message: string,
  type: "log" | "warn" | "error" = "log",
  color?: keyof typeof chalk,
): Error | void {
  const configData = loadConfig();

  // Access logging config with type guard for safer access
  const logging = hasValidLogging(configData) ? configData.logging : undefined;
  const logExcludeFunc =
    logging?.excludeFunc ??
    (configData as { logExcludeFunc?: string[] }).logExcludeFunc ??
    [];

  if (
    logExcludeFunc.some((x: string) => x.toLowerCase() === title.toLowerCase())
  ) {
    return;
  }

  const currentTime = new Date().toLocaleString();
  const platformText =
    isMobile === "main" ? "MAIN" : isMobile ? "MOBILE" : "DESKTOP";

  // Clean string for notifications (no chalk, structured)
  type LoggingCfg = {
    excludeFunc?: string[];
    webhookExcludeFunc?: string[];
    redactEmails?: boolean;
  };
  const loggingCfg: LoggingCfg = logging || {};
  const shouldRedact = !!loggingCfg.redactEmails;
  const redactSensitive = (s: string) => {
    const scrubbed = s
      .replace(/:\/\/[A-Z0-9._%+-]+:[^@\s]+@/gi, "://***:***@")
      .replace(/(token=|apikey=|auth=)[^\s&]+/gi, "$1***");

    if (!shouldRedact) return scrubbed;

    return scrubbed.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => {
      const [u, d] = m.split("@");
      return `${(u || "").slice(0, 2)}***@${d || ""}`;
    });
  };

  const cleanStr = redactSensitive(
    `[${currentTime}] [PID: ${process.pid}] [${type.toUpperCase()}] ${platformText} [${title}] ${message}`,
  );

  // Define conditions for sending to NTFY
  const ntfyConditions = {
    log: [
      message.toLowerCase().includes("started tasks for account"),
      message.toLowerCase().includes("press the number"),
      message.toLowerCase().includes("no points to earn"),
    ],
    error: [],
    warn: [
      message.toLowerCase().includes("aborting"),
      message.toLowerCase().includes("didn't gain"),
    ],
  };

  // Check if the current log type and message meet the NTFY conditions
  try {
    if (
      type in ntfyConditions &&
      ntfyConditions[type as keyof typeof ntfyConditions].some(
        (condition) => condition,
      )
    ) {
      // Fire-and-forget
      Promise.resolve(Ntfy(cleanStr, type)).catch(() => {
        /* Non-critical: NTFY notification errors are ignored */
      });
    }
  } catch {
    /* Non-critical: Webhook buffer cleanup can fail safely */
  }

  // Console output with better formatting and contextual icons
  const typeIndicator = type === "error" ? "✗" : type === "warn" ? "⚠" : "✓";
  const platformColor =
    isMobile === "main" ? chalk.cyan : isMobile ? chalk.blue : chalk.magenta;
  const typeColor =
    type === "error" ? chalk.red : type === "warn" ? chalk.yellow : chalk.green;

  // Add contextual icon based on title/message (ASCII-safe for Windows PowerShell)
  const titleLower = title.toLowerCase();
  const msgLower = message.toLowerCase();

  // ASCII-safe icons for Windows PowerShell compatibility
  const iconMap: Array<[RegExp, string]> = [
    [/security|compromised/i, "[SECURITY]"],
    [/ban|suspend/i, "[BANNED]"],
    [/error/i, "[ERROR]"],
    [/warn/i, "[WARN]"],
    [/success|complet/i, "[OK]"],
    [/login/i, "[LOGIN]"],
    [/point/i, "[POINTS]"],
    [/search/i, "[SEARCH]"],
    [/activity|quiz|poll/i, "[ACTIVITY]"],
    [/browser/i, "[BROWSER]"],
    [/main/i, "[MAIN]"],
  ];

  let icon = "";
  for (const [pattern, symbol] of iconMap) {
    if (pattern.test(titleLower) || pattern.test(msgLower)) {
      icon = chalk.dim(symbol);
      break;
    }
  }

  const iconPart = icon ? icon + " " : "";

  const formattedStr = [
    chalk.gray(`[${currentTime}]`),
    chalk.gray(`[${process.pid}]`),
    typeColor(`${typeIndicator}`),
    platformColor(`[${platformText}]`),
    chalk.bold(`[${title}]`),
    iconPart + redactSensitive(message),
  ].join(" ");

  const applyChalk =
    color && typeof chalk[color] === "function"
      ? (chalk[color] as (msg: string) => string)
      : null;

  // Log based on the type
  switch (type) {
    case "warn":
      applyChalk
        ? console.warn(applyChalk(formattedStr))
        : console.warn(formattedStr);
      break;

    case "error":
      applyChalk
        ? console.error(applyChalk(formattedStr))
        : console.error(formattedStr);
      break;

    default:
      applyChalk
        ? console.log(applyChalk(formattedStr))
        : console.log(formattedStr);
      break;
  }

  // Emit log event for dashboard (CLEAN - no function interception)
  logEventEmitter.emit("log", {
    timestamp: new Date().toISOString(),
    level: type,
    platform: platformText,
    title,
    message: redactSensitive(message),
  });

  // Webhook streaming (live logs) - Discord and Stoat
  try {
    const loggingCfg: Record<string, unknown> = (logging || {}) as Record<
      string,
      unknown
    >;
    const webhookCfg = configData.webhook;
    const liveUrlRaw =
      typeof loggingCfg.liveWebhookUrl === "string"
        ? loggingCfg.liveWebhookUrl.trim()
        : "";
    const liveUrl =
      liveUrlRaw ||
      (webhookCfg?.enabled && webhookCfg.url ? webhookCfg.url : "");
    const webhookExclude = Array.isArray(loggingCfg.webhookExcludeFunc)
      ? loggingCfg.webhookExcludeFunc
      : configData.webhookLogExcludeFunc || [];
    const webhookExcluded =
      Array.isArray(webhookExclude) &&
      webhookExclude.some(
        (x: string) => x.toLowerCase() === title.toLowerCase(),
      );

    if (!webhookExcluded) {
      // Discord live logs
      if (liveUrl) {
        enqueueDiscordLog(liveUrl, cleanStr);
      }
      // Stoat live logs
      const stoatCfg = configData.stoat;
      if (stoatCfg?.enabled && stoatCfg.url) {
        enqueueStoatLog(stoatCfg.url, cleanStr);
      }
    }
  } catch (error) {
    // Note: Using stderr directly to avoid recursion - this is an internal logger error
    process.stderr.write(`[Logger] Failed to enqueue webhook log: ${error}\n`);
  }

  // Automatic error reporting to community webhook (fire and forget)
  if (type === "error") {
    const errorObj = new Error(cleanStr);

    // FIXED: Single try-catch with proper error visibility
    // Fire-and-forget but log failures to stderr for debugging
    void (async () => {
      try {
        await sendErrorReport(configData, errorObj, {
          title,
          platform: platformText,
        });
      } catch (reportError) {
        // Log to stderr but don't break application
        const msg = getErrorMessage(reportError);
        process.stderr.write(`[Logger] Error reporting failed: ${msg}\n`);
      }
    })();

    return errorObj;
  }
}
