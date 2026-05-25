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
// Bing Search Page (unchanged by dashboard migration)
// ---------------------------------------------------------------------------

export const BING_SEARCH = {
    /** Main search input */
    searchBar: '#sb_form_q',
    /** Organic search result links */
    resultLinks: '#b_results .b_algo h2'
} as const

// ---------------------------------------------------------------------------
// URL Patterns
// ---------------------------------------------------------------------------

export const URLS = {
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
