export interface Config {
  baseURL: string;
  sessionPath: string;
  browser?: ConfigBrowser; // Optional nested browser config
  fingerprinting?: ConfigFingerprinting; // Optional nested fingerprinting config
  parallel: boolean;
  runOnZeroPoints: boolean;
  clusters: number;
  saveFingerprint: ConfigSaveFingerprint;
  workers: ConfigWorkers;
  searchOnBingLocalQueries: boolean;
  globalTimeout: number | string;
  searchSettings: ConfigSearchSettings;
  humanization?: ConfigHumanization; // Anti-ban humanization controls
  retryPolicy?: ConfigRetryPolicy; // Global retry/backoff policy
  jobState?: ConfigJobState; // Persistence of per-activity checkpoints
  logExcludeFunc: string[];
  webhookLogExcludeFunc: string[];
  logging?: ConfigLogging; // Preserve original logging object (for live webhook settings)
  proxy: ConfigProxy;
  webhook: ConfigWebhook;
  summaryWebhook?: ConfigWebhook; // Summary webhook for final run reports (renamed from conclusionWebhook)
  /** @deprecated Use summaryWebhook instead */
  conclusionWebhook?: ConfigWebhook;
  stoat?: ConfigStoat; // Stoat/Revolt webhook (open-source Discord alternative)
  ntfy: ConfigNtfy;
  update?: ConfigUpdate;
  passesPerRun?: number;
  crashRecovery?: ConfigCrashRecovery; // Automatic restart / graceful shutdown
  riskManagement?: ConfigRiskManagement; // Risk-aware throttling and ban prediction
  dryRun?: boolean; // Dry-run mode (simulate without executing)
  queryDiversity?: ConfigQueryDiversity; // Multi-source query generation
  dashboard?: ConfigDashboard; // Local web dashboard for monitoring and control
  scheduling?: ConfigScheduling; // Automatic scheduler configuration (cron/Task Scheduler)
  errorReporting?: ConfigErrorReporting; // Automatic error reporting to community webhook
  antiDetection?: ConfigAntiDetection; // Advanced anti-detection configuration
}

export interface ConfigSaveFingerprint {
  mobile: boolean;
  desktop: boolean;
}

export interface ConfigBrowser {
  headless?: boolean;
  globalTimeout?: number | string;
}

export interface ConfigFingerprinting {
  saveFingerprint?: ConfigSaveFingerprint;
}

export interface ConfigSearchSettings {
  useGeoLocaleQueries: boolean;
  scrollRandomResults: boolean;
  clickRandomResults: boolean;
  searchDelay: ConfigSearchDelay;
  retryMobileSearchAmount: number;
  localFallbackCount?: number; // Number of local fallback queries to sample when trends fail
  extraFallbackRetries?: number; // Additional mini-retry loops with fallback terms
  semanticDedup?: boolean; // Filter queries with high semantic similarity (default: true)
  semanticDedupThreshold?: number; // Jaccard similarity threshold 0-1 (default: 0.65, lower = stricter)
}

export interface ConfigSearchDelay {
  min: number | string;
  max: number | string;
}

export interface ConfigWebhook {
  enabled: boolean;
  url: string;
}

export interface ConfigNtfy {
  enabled: boolean;
  url: string;
  topic: string;
  authToken?: string; // Optional authentication token
}

export interface ConfigProxy {
  proxyGoogleTrends: boolean;
  proxyBingTerms: boolean;
}

/** Stoat/Revolt webhook configuration (open-source Discord alternative) */
export interface ConfigStoat {
  enabled: boolean;
  url: string; // Full Stoat webhook URL: https://stoat.chat/api/webhooks/{id}/{token}
}

export interface ConfigUpdate {
  enabled?: boolean; // Master toggle for auto-updates (default: true)
  scriptPath?: string; // optional custom path to update script relative to repo root
  autoUpdateConfig?: boolean; // if true, allow auto-update of config.jsonc when remote changes it (default: false to preserve user settings)
  autoUpdateAccounts?: boolean; // if true, allow auto-update of accounts.json when remote changes it (default: false to preserve credentials)
}

export interface ConfigCrashRecovery {
  autoRestart?: boolean; // Restart the root process after fatal crash
  maxRestarts?: number; // Max restart attempts (default 2)
  backoffBaseMs?: number; // Base backoff before restart (default 2000)
  restartFailedWorker?: boolean; // (future) attempt to respawn crashed worker
  restartFailedWorkerAttempts?: number; // attempts per worker (default 1)
}

export interface ConfigWorkers {
  doDailySet: boolean;
  doMorePromotions: boolean;
  doPunchCards: boolean;
  doDesktopSearch: boolean;
  doMobileSearch: boolean;
  doDailyCheckIn: boolean;
  doReadToEarn: boolean;
  doFreeRewards: boolean; // Automatically redeem 0-point gift cards (requires phoneNumber in account config)
  bundleDailySetWithSearch?: boolean; // If true, run desktop search right after Daily Set
}

// Anti-ban humanization
export interface ConfigHumanization {
  // Master toggle for Human Mode. When false, humanization is minimized.
  enabled?: boolean;
  // If true, stop processing remaining accounts after a ban is detected
  stopOnBan?: boolean;
  // If true, send an immediate webhook/NTFY alert when a ban is detected
  immediateBanAlert?: boolean;
  // Additional random waits between actions
  actionDelay?: { min: number | string; max: number | string };
  // Probability [0..1] to perform micro mouse moves per step
  gestureMoveProb?: number;
  // Probability [0..1] to perform tiny scrolls per step
  gestureScrollProb?: number;
  // Allowed execution windows (local time). Each item is "HH:mm-HH:mm".
  // If provided, runs outside these windows will be delayed until the next allowed window.
  allowedWindows?: string[];
  // Randomly skip N days per week to look more human (0-7). Default 1.
  randomOffDaysPerWeek?: number;
}

// Retry/backoff policy
export interface ConfigRetryPolicy {
  maxAttempts?: number; // default 3
  baseDelay?: number | string; // default 1000ms
  maxDelay?: number | string; // default 30s
  multiplier?: number; // default 2
  jitter?: number; // 0..1; default 0.2
}

// Job state persistence
export interface ConfigJobState {
  enabled?: boolean; // default true
  dir?: string; // base directory; defaults to <sessionPath>/job-state
  skipCompletedAccounts?: boolean; // if true (default), skip accounts already completed for the day
  autoResetOnComplete?: boolean; // if true, automatically reset and rerun without prompting (useful for scheduled tasks)
}

// Live logging configuration
export interface ConfigLoggingLive {
  enabled?: boolean; // master switch for live webhook logs
  redactEmails?: boolean; // if true, redact emails in outbound logs
}

export interface ConfigLogging {
  excludeFunc?: string[];
  webhookExcludeFunc?: string[];
  live?: ConfigLoggingLive;
  liveWebhookUrl?: string; // legacy/dedicated live webhook override
  redactEmails?: boolean; // legacy top-level redaction flag
  // Optional nested live.url support (already handled dynamically in Logger)
  [key: string]: unknown; // forward compatibility
}

// CommunityHelp intentionally omitted (privacy-first policy)

// NEW FEATURES: Risk Management and Query Diversity
export interface ConfigRiskManagement {
  enabled?: boolean; // master toggle for risk-aware throttling
  stopOnCritical?: boolean; // halt execution if risk reaches critical level
}

export interface ConfigQueryDiversity {
  enabled?: boolean; // use multi-source query generation
  sources?: Array<
    "google-trends" | "reddit" | "news" | "wikipedia" | "local-fallback"
  >; // which sources to use
  maxQueriesPerSource?: number; // limit per source
  cacheMinutes?: number; // cache duration
}

export interface ConfigDashboard {
  enabled?: boolean; // auto-start dashboard with bot (default: false)
  port?: number; // dashboard server port (default: 3000)
  host?: string; // bind address (default: 127.0.0.1)
}

export interface ConfigErrorReporting {
  enabled?: boolean; // master toggle for error reporting
  apiUrl?: string; // Vercel API endpoint URL (default: official endpoint)
  secret?: string; // optional secret for bypassing rate limits
  webhooks?: string[]; // Optional array of webhook URLs (plain or base64-encoded)
}

export interface ConfigScheduling {
  enabled?: boolean; // Enable automatic daily scheduling
  time?: string; // Daily execution time in 24h format (HH:MM) - e.g., "09:00" for 9 AM (RECOMMENDED)
  cron?: {
    // LEGACY: Cron format for backwards compatibility (prefer 'time' field)
    schedule?: string; // Cron expression - e.g., "0 9 * * *" for 9 AM daily
  };
  jitter?: {
    enabled?: boolean; // If true, apply random +/- offset around scheduled time
    minMinutesBefore?: number; // How many minutes before the scheduled time we may start (default 20)
    maxMinutesAfter?: number; // How many minutes after the scheduled time we may start (default 30)
  };
}

/**
 * Advanced anti-detection configuration for browser fingerprint spoofing.
 * These values override fingerprint-generator defaults for consistency.
 */
export interface ConfigAntiDetection {
  /** Timezone override (e.g., "America/New_York", "Europe/Paris") */
  timezone?: string;
  /** Locale override (e.g., "en-US", "fr-FR") */
  locale?: string;
  /** Browser languages array (e.g., ["en-US", "en"]) */
  languages?: string[];
  /** WebGL vendor string override */
  webglVendor?: string;
  /** WebGL renderer string override */
  webglRenderer?: string;
  /** Enable canvas noise injection (default: true) */
  canvasNoise?: boolean;
  /** Enable WebGL parameter spoofing (default: true) */
  webglNoise?: boolean;
  /** Enable audio fingerprint protection (default: true) */
  audioNoise?: boolean;
  /** Enable WebRTC IP leak protection (default: true) */
  webrtcProtection?: boolean;
}
