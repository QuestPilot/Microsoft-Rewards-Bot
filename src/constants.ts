/**
 * Central constants for the Microsoft Rewards Script
 * All timeouts, retry limits, delays, selectors, and other magic numbers are defined here
 */

export const TIMEOUTS = {
  SHORT: 500,
  ONE_SECOND: 1000,
  MEDIUM: 1500,
  MEDIUM_LONG: 2000,
  LONG: 3000,
  VERY_LONG: 5000,
  EXTRA_LONG: 10000,
  ACTIVITY_PAGE_LOAD: 4000, // Standard wait after activity interactions (LONG + 1s buffer)
  SMART_WAIT_EXTENDED: 8000, // Extended smart-wait timeout for page transitions
  DASHBOARD_WAIT: 10000,
  ONE_MINUTE: 60000,
  TEN_MINUTES: 600000,
  ONE_HOUR: 3600000,
} as const;

export const RETRY_LIMITS = {
  ABC_MAX: 15,
  QUIZ_ANSWER_TIMEOUT: 10000,
  GO_HOME_MAX: 5,
} as const;

export const DELAYS = {
  SEARCH_ON_BING_WAIT: 5000,
  SEARCH_ON_BING_COMPLETE: 3000,
  SEARCH_ON_BING_FOCUS: 200,
  SEARCH_BAR_TIMEOUT: 15000,
  QUIZ_ANSWER_WAIT: 2000,
  THIS_OR_THAT_START: 2000,
} as const;

export const SELECTORS = {
  // FIXED: Use more specific selector to avoid strict mode violation (2 elements with id='more-activities')
  // Target the mee-card-group element specifically, not the div wrapper
  MORE_ACTIVITIES: 'mee-card-group#more-activities[role="list"]',
  // IMPROVED: Expanded fallback selectors to handle Microsoft's frequent HTML structure changes
  MORE_ACTIVITIES_FALLBACKS: [
    "mee-card-group#more-activities", // Without role attribute
    "#more-activities", // ID only (most permissive)
    '[id="more-activities"]', // Attribute selector
    'mee-card-group[role="list"]', // Element type with role (catches any list-type card group)
    "mee-card-group", // Ultra-permissive: any mee-card-group element
    ".daily-sets", // Class-based fallback
    '[data-bi-name="daily-set"]', // Data attribute fallback
    "main#daily-sets", // Main content area
    'main[data-bi-name="dashboard"]', // Dashboard root element
    ".mee-card", // Individual card element
    '[class*="rewards"]', // Any element with rewards in class name
  ],
  SUSPENDED_ACCOUNT: "#suspendedAccountHeader",
  QUIZ_COMPLETE: "#quizCompleteContainer",
  QUIZ_CREDITS: "span.rqMCredits",
} as const;

export const URLS = {
  REWARDS_BASE: "https://rewards.bing.com",
  REWARDS_REDEEM: "https://rewards.bing.com/redeem",
  REWARDS_DASHBOARD: "https://www.bing.com/rewards/dashboard",
  REWARDS_API_ME: "https://prod.rewardsplatform.microsoft.com/dapi/me",
  REWARDS_API_ACTIVITIES:
    "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
  APP_USER_DATA:
    "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
  BING_HOME: "https://www.bing.com",
  BING_SEARCH: "https://www.bing.com/search",
  BING_SIGNIN:
    "https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F",
} as const;

export const DISCORD = {
  MAX_EMBED_LENGTH: 1900,
  RATE_LIMIT_DELAY: 500,
  WEBHOOK_TIMEOUT: 10000,
  DEBOUNCE_DELAY: 750,
  COLOR_RED: 0xff0000,
  COLOR_CRIMSON: 0xdc143c,
  COLOR_ORANGE: 0xffa500,
  COLOR_BLUE: 0x3498db,
  COLOR_GREEN: 0x00d26a,
  COLOR_GRAY: 0x95a5a6,
  WEBHOOK_USERNAME: "Microsoft-Rewards-Bot",
  AVATAR_URL:
    "https://raw.githubusercontent.com/LightZirconite/Microsoft-Rewards-Bot/main/assets/logo.png",
} as const;

export const LOGGER_CLEANUP = {
  BUFFER_MAX_AGE_MS: TIMEOUTS.ONE_HOUR,
  BUFFER_CLEANUP_INTERVAL_MS: TIMEOUTS.TEN_MINUTES,
} as const;

export const STOAT = {
  WEBHOOK_TIMEOUT: 10000,
  RATE_LIMIT_DELAY: 500,
  MAX_EMBED_LENGTH: 2000,
  DEBOUNCE_DELAY: 750,
  WEBHOOK_USERNAME: "Microsoft-Rewards-Bot",
  AVATAR_URL: DISCORD.AVATAR_URL,
} as const;

export const DISMISSAL_DELAYS = {
  BETWEEN_BUTTONS: 150, // Delay between dismissing multiple popup buttons
  AFTER_DIALOG_CLOSE: 1000, // Wait for dialog close animation to complete
} as const;
