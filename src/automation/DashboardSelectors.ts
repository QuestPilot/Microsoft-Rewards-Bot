/**
 * Microsoft Rewards Bot — Core Selectors
 * Copyright (c) 2026 QuestPilot
 *
 * Licensed under the QuestPilot Source Available License 1.0.
 * See LICENSE for full terms.
 *
 * Core CSS selectors required for basic bot functionality (search, cookie consent, URLs).
 * Premium dashboard selectors (DASHBOARD_HERO, EARN, SNAPSHOT, REDEEM, etc.) are provided
 * by the premium plugin.
 */

// ---------------------------------------------------------------------------
// Cookie Consent Banner (new dashboard)
// ---------------------------------------------------------------------------

export const COOKIE_CONSENT = {
    /**
     * WCP Consent Banner (wcpConsentBannerCtrl).
     *
     * Structure (Feb 2026):
     * ```
     * #wcpConsentBannerCtrl[role="alert"]
     *   div  (text + privacy links)
     *   div  (buttons row)
     *     button  "Accepter"          (1st – first-of-type)
     *     button  "Refuser"           (2nd – nth-of-type(2))
     *     button  "Gérer les cookies" (3rd – last-of-type)
     * ```
     *
     * The CSS-module class names are obfuscated and unstable.
     * We rely on the stable `#wcpConsentBannerCtrl` ID and button position.
     */

    /** Banner container – used to detect presence */
    banner: '#wcpConsentBannerCtrl',
    /** Accept all cookies – first button ("Accepter") */
    acceptButton: '#wcpConsentBannerCtrl button:first-of-type',
    /** Reject optional cookies – second button ("Refuser") */
    rejectButton: '#wcpConsentBannerCtrl button:nth-of-type(2)',
    /** Manage cookies – third button ("Gérer les cookies") */
    manageButton: '#wcpConsentBannerCtrl button:last-of-type'
} as const

// ---------------------------------------------------------------------------
// Dismiss / overlay selectors (shared by legacy + new dashboard and bing.com)
// ---------------------------------------------------------------------------

/**
 * Buttons that close welcome/onboarding/cookie prompts shared by BOTH the legacy
 * and new dashboard / Bing pages. Legacy selectors are kept as fallbacks since
 * not all users have been migrated and Bing search pages still use the old UI.
 */
export const DISMISS_BUTTONS: ReadonlyArray<{ selector: string; label: string }> = [
    // --- Legacy dashboard / Bing selectors (still needed on bing.com) ---
    { selector: '#acceptButton', label: 'AcceptButton' },
    { selector: '.ext-secondary.ext-button', label: '"Skip for now" Button' },
    { selector: '#iLandingViewAction', label: 'iLandingViewAction' },
    { selector: '#iShowSkip', label: 'iShowSkip' },
    { selector: '#iNext', label: 'iNext' },
    { selector: '#iLooksGood', label: 'iLooksGood' },
    { selector: '#idSIButton9', label: 'idSIButton9' },
    { selector: '.ms-Button.ms-Button--primary', label: 'Primary Button' },
    { selector: '.c-glyph.glyph-cancel', label: 'Mobile Welcome Button' },
    { selector: '.maybe-later', label: 'Mobile Rewards App Banner' },
    { selector: '#bnp_btn_accept', label: 'Bing Cookie Banner' },
    { selector: '#reward_pivot_earn', label: 'Reward Coupon Accept' },

    // --- WCP Cookie Consent Banner (shared by dashboard + bing.com) ---
    { selector: COOKIE_CONSENT.acceptButton, label: 'WCP Cookie Accept' }
] as const

/** Legacy Bing consent overlay (still present on bing.com search pages). */
export const BING_OVERLAY = {
    /** Overlay wrapper – used to detect presence */
    wrapper: '#bnp_overlay_wrapper',
    /** Reject optional cookies */
    rejectButton: '#bnp_btn_reject, button[aria-label*="Reject" i]',
    /** Accept cookies */
    acceptButton: '#bnp_btn_accept'
} as const

// ---------------------------------------------------------------------------
// Bing Search Page (unchanged by dashboard migration)
// ---------------------------------------------------------------------------

export const BING_SEARCH = {
    /** Main search input */
    searchBar: '#sb_form_q',
    /** Organic search result links */
    resultLinks: '#b_results .b_algo h2 a, #b_results .b_algo h2, main ol li h2 a',
    /** First organic result link that is an external http(s) destination (for result-visit) */
    resultLinkHref: '#b_results li.b_algo h2 a[href^="http"]'
} as const

// ---------------------------------------------------------------------------
// URL Patterns
// ---------------------------------------------------------------------------

export const URLS = {
    /**
     * Rewards root/home. Works on BOTH dashboards: the legacy ASP.NET dashboard is
     * served here directly, and a migrated account is redirected to the Next.js
     * `/dashboard`. The legacy flow only ever touches this root (never `/earn`,
     * `/dashboard`, `/redeem` — those are Next.js-only SPA routes).
     */
    home: 'https://rewards.bing.com/',
    /** New dashboard base */
    dashboard: 'https://rewards.bing.com/dashboard',
    /** Earn page */
    earn: 'https://rewards.bing.com/earn',
    /** Redeem page */
    redeem: 'https://rewards.bing.com/redeem',
    /** Dashboard API (unchanged) */
    dashboardApi: 'https://rewards.bing.com/api/getuserinfo?type=1',
    /**
     * Report activity API (legacy ASP.NET dashboard ONLY).
     *
     * On the new Next.js dashboard this endpoint no longer exists.
     * Activities are reported via a React Server Action instead
     * (see PageController.reportActivityViaBrowser).
     */
    reportActivity: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
    /** App dashboard API (unchanged) */
    appDashboard: 'https://prod.rewardsplatform.microsoft.com/dapi/me',
    /** Bing home */
    bingHome: 'https://bing.com'
} as const

// ---------------------------------------------------------------------------
// Bing Search URL Query Parameters (for task attribution)
// ---------------------------------------------------------------------------

export const BING_PARAMS = {
    /** Daily set task tracking parameters */
    dailySet: {
        form: 'ML2G76',
        OCID: 'ML2G76',
        PUBL: 'RewardsDO',
        CREA: 'ML2G76'
    },
    /** Explore on Bing task tracking parameters */
    exploreOnBing: {
        form: 'ML2PCR',
        OCID: 'ML2PCR',
        PUBL: 'RewardsDO',
        CREA: 'ML2PCR',
        rwAutoFlyout: 'exb'
    }
} as const
