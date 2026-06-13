# Microsoft Rewards - Comprehensive Selectors Reference

> Extracted from the new Next.js/React Aria interface (rewards.bing.com)  
> Framework: **Next.js** + **React Aria** + **Tailwind CSS**  
> Base URL: `https://rewards.bing.com/`

> ### ⚠️ 2026-06 update — design-system overhaul
> Microsoft **renamed its entire Tailwind token set**. Class examples throughout this
> document (e.g. `bg-neutralBg1`, `rounded-2xl`, `text-body1Strong`, `text-title1`,
> `text-statusSuccessFg1`) are **stale** and must not be used as selectors. Verified
> renames:
>
> | Old token | New token |
> | --- | --- |
> | `bg-neutralBg1` | `bg-bgCardOnPrimaryDefaultRest` |
> | `rounded-2xl` | `rounded-cornerCardDefault` |
> | `rounded-full` (badges) | `rounded-cornerCircular` |
> | `text-statusSuccessFg1` | `text-statusSuccessTintFg` |
> | `bg-statusSuccessBg3` | `bg-statusSuccessRewardsBg` |
>
> **Rule:** build selectors from **structure** — section ids, `role`, `aria-*`, `slot`,
> `data-rac`, `data-react-aria-pressable`, React-Aria classes — plus locale-independent
> image `src` fragments. **Never** key off visible/localized text. Treat design tokens as
> the last, most fragile resort. Other confirmed changes: the active nav link no longer
> carries `aria-current="page"` (use `a[data-selected="true"]`); the Earn "Explore on Bing"
> section id `#exploreonbing` is gone — tasks now live under `#moreactivities` (and
> `#quests` for punchcards). Current Earn section ids: `#streaks #levelup #quests
> #moreactivities #microsoft`. The canonical, maintained selector set is
> `Core-Source/src/PremiumSelectors.ts`.

---

## Table of Contents

1. [Framework & Technology Patterns](#1-framework--technology-patterns)
2. [Global Shell & Layout](#2-global-shell--layout)
3. [Navigation Tabs](#3-navigation-tabs)
4. [Profile & Points Header](#4-profile--points-header)
5. [Main Content Area](#5-main-content-area)
6. [Disclosure / Collapsible Sections](#6-disclosure--collapsible-sections)
7. [Dashboard Page (`/dashboard`)](#7-dashboard-page-dashboard)
8. [Earn Page (`/earn`)](#8-earn-page-earn)
9. [Redeem Page (`/redeem`)](#9-redeem-page-redeem)
10. [About Page (`/about`)](#10-about-page-about)
11. [Refer Page (`/refer`)](#11-refer-page-refer)
12. [Progress Bars](#12-progress-bars)
13. [Cards & Task Items](#13-cards--task-items)
14. [Badges & Status Indicators](#14-badges--status-indicators)
15. [Cookie Consent Banner](#15-cookie-consent-banner)
16. [URL Patterns & Query Parameters](#16-url-patterns--query-parameters)
17. [Recommended Automation Selectors (Summary)](#17-recommended-automation-selectors-summary)
18. [Error & Suspended Account Pages](#18-error--suspended-account-pages)
19. [React Aria Component Catalog](#19-react-aria-component-catalog)
20. [Data Models & Instrumentation](#20-data-models--instrumentation)

---

## 1. Framework & Technology Patterns

### Core Stack

- **Next.js** (confirmed by `self.__next_s`, `data-precedence="next"`, `<next-route-announcer>`)
- **React Aria** (accessibility library: `data-rac`, `data-react-aria-pressable="true"`, `react-aria-*` IDs)
- **Tailwind CSS** (utility classes throughout)
- **Dark Reader** compatible (`data-darkreader-inline-stroke` attributes)

### Key Data Attributes (Universal)

| Attribute                          | Usage                               | Notes                                       |
| ---------------------------------- | ----------------------------------- | ------------------------------------------- |
| `data-rac`                         | All React Aria components           | Present on every interactive element        |
| `data-rac=""`                      | Empty string value                  | Always empty                                |
| `data-react-aria-pressable="true"` | Clickable elements (links, buttons) | Universal click target marker               |
| `data-selected="true"`             | Active/selected tab                 | Only on current page tab                    |
| `data-current="true"`              | Current page marker                 | Companion to `data-selected`                |
| `data-expanded="true"/"false"`     | Disclosure sections                 | On `.react-aria-Disclosure`                 |
| `data-pressed="true"`              | Currently pressed button            | Transient state                             |
| `aria-expanded="true"/"false"`     | Expandable triggers                 | On disclosure trigger buttons               |
| `aria-current="page"`              | Active navigation link              | On current page nav link                    |
| `aria-hidden="true"/"false"`       | Hidden panels                       | On collapsed disclosure panels              |
| `hidden="until-found"`             | Collapsed content                   | Browser native, collapsed disclosure panels |
| `slot="trigger"`                   | Disclosure trigger button           | Identifies the expand/collapse button       |

### React Aria ID Patterns

- Dynamic IDs: `react-aria-_R_XXXXX_` or `react-aria8138508238-_r_XX_`
- These IDs are **NOT stable** - do not use them as selectors
- Use `aria-label`, `aria-controls`, text content, or structural selectors instead

---

## 2. Global Shell & Layout

### Shell Container

```css
div#shell.flex.min-h-screen.flex-col
```

### Header

```css
header.grid.grid-cols-\[auto_1fr_auto\].items-center.gap-x-6.px-4.py-1\.5
```

### Grow Container (below header)

```css
div.grow > div.mt-25.xl\:mt-14
```

### Background Gradient (Gold member)

```css
div.bg-rewardsBgGoldGradient
```

### Footer

```css
footer  /* Standard footer at page bottom */
```

---

## 3. Navigation Tabs

### Tab Container

All nav links are inside the `<header>` element.

### Tab Link (generic)

```css
header a[data-rac][data-react-aria-pressable="true"]
```

### Individual Tab Links

| Page      | Selector                                       | href         |
| --------- | ---------------------------------------------- | ------------ |
| Dashboard | `a[href="https://rewards.bing.com/dashboard"]` | `/dashboard` |
| Earn      | `a[href="https://rewards.bing.com/earn"]`      | `/earn`      |
| Redeem    | `a[href="https://rewards.bing.com/redeem"]`    | `/redeem`    |
| About     | `a[href="https://rewards.bing.com/about"]`     | `/about`     |
| Refer     | `a[href="https://rewards.bing.com/refer"]`     | `/refer`     |

### Active Tab Detection

```css
/* Active tab has ALL of these: */
a[data-selected="true"][aria-current="page"][data-current="true"]

/* Active tab classes include: */
.text-body1Strong.after\:bg-brandStrokeCompound

/* Inactive tab classes include: */
.text-body1.text-neutralFg1.after\:bg-transparent
```

### Tab Visual Indicator (underline)

The active tab has an `::after` pseudo-element with `bg-brandStrokeCompound` (colored underline).

### Full Active Tab Class String

```
outline-0 cursor-pointer group outline-neutralStrokeFocus2 inline-flex items-center justify-center transition-colors group relative text-body1Strong rounded-md -outline-offset-2 after:bg-brandStrokeCompound after:rounded-full after:absolute after:bottom-0 py-3 px-2.5 after:left-2.5 after:right-2.5 after:h-[3px] shrink-0
```

### Full Inactive Tab Class String

```
outline-0 cursor-pointer group outline-neutralStrokeFocus2 inline-flex items-center justify-center transition-colors group relative text-body1 text-neutralFg1 rounded-md -outline-offset-2 after:bg-transparent after:rounded-full after:absolute after:bottom-0 py-3 px-2.5 after:left-2.5 after:right-2.5 after:h-[3px] shrink-0
```

---

## 4. Profile & Points Header

### Profile Button

```css
button[aria-label="Afficher le profil"]
/* Classes: bg-neutralBgSubtle border-transparent text-neutralFg2 */
```

### Points Display (in profile button)

```css
button[aria-label="Afficher le profil"] p
/* Displays current points total, e.g., "58" */
```

### Member Badge Image

```css
img[alt="Adhérent Or"]  /* Gold member - French */
img[alt*="Adhérent"]    /* Any member tier */
```

### Avatar/Initials

```css
div.grid.place-items-center.relative.overflow-hidden.rounded-full.select-none.font-semibold > p
/* Shows initials like "NN" */
```

### Profile Button Structure

```
button[aria-label="Afficher le profil"]
├── div (flex container)
│   ├── div (member badge + points)
│   │   ├── img[alt="Adhérent Or"] (tier badge)
│   │   ├── img[alt="Points disponibles"] (points icon)
│   │   └── p (points number)
│   └── div.rounded-full (avatar circle)
│       └── p (initials "NN")
```

### 4.1 Profile Popover Dialog

Clicking the profile button opens a React Aria **Popover** with a **Dialog** inside.

```css
/* Underlay (background overlay) */
div[data-testid="underlay"]  /* style: position:fixed; inset:0px */

/* Popover container */
div.react-aria-Popover[data-rac][data-trigger="DialogTrigger"][data-placement="bottom"]
/* aria-labelledby points to profile button ID */
/* z-index: 100000 */

/* Dialog section */
section[role="dialog"][data-rac]  /* tabindex="-1" */

/* Dismiss button (hidden, for screen readers) */
button[aria-label="Rejeter"]  /* 1x1px hidden button */
```

#### Profile Popover Content

```css
/* Logo inside popover */
img[alt="Logo de Microsoft Rewards"]  /* dark:hidden / hidden dark:block variants */

/* Logout link */
a[href="/auth/logout"]  /* appearance: "subtle", text: "Se déconnecter" */
/* Instrument: HeaderProfileFlyout_Logout */

/* User avatar (72px) */
div.shrink-0 img  /* size: 72, user profile photo */

/* User name */
p.pii.truncate.text-subtitle2  /* e.g., "Ngan Nguyen" */

/* User email */
p.pii.truncate  /* e.g., "user@example.com" */

/* Microsoft Account link */
a[href="https://account.microsoft.com"][target="_blank"]
```

#### Popover Structure Tree

```
div[data-testid="underlay"]
div.react-aria-Popover[data-trigger="DialogTrigger"]
├── button[aria-label="Rejeter"] (hidden dismiss)
└── section[role="dialog"]
    ├── div (header row)
    │   ├── img[alt="Logo de Microsoft Rewards"] (logo)
    │   └── a[href="/auth/logout"] ("Se déconnecter")
    ├── div (user info row)
    │   ├── img (user avatar, 72px)
    │   ├── p.text-subtitle2 (user name)
    │   ├── p (user email)
    │   └── a[href="https://account.microsoft.com"] (account link)
    └── div (level/points info)
```

---

## 5. Main Content Area

### Main Element

```css
main.pg-content
/* Classes: gap-6 py-6 lg:gap-10 lg:py-10 */
```

### Page Title (hidden/sr-only on dashboard)

```css
main.pg-content h1
/* Dashboard: class="sr-only" (hidden, text "Tableau de bord") */
/* Earn: class="text-title2 md:text-largeTitle mai:text-pageHeader" */
```

---

## 6. Disclosure / Collapsible Sections

All content sections use the React Aria Disclosure pattern.

### Disclosure Container

```css
div.react-aria-Disclosure[data-rac]
```

### Disclosure States

```css
/* Expanded */
div.react-aria-Disclosure[data-expanded="true"]

/* Collapsed */
div.react-aria-Disclosure:not([data-expanded])
div.react-aria-Disclosure[data-expanded="false"]  /* Not always present */
```

### Section Trigger (Expand/Collapse Button)

```css
button[slot="trigger"][data-react-aria-pressable="true"]
/* Has aria-label matching section name */
/* Has aria-expanded="true"/"false" */
/* Has aria-controls pointing to panel ID */
```

### Disclosure Panel

```css
div.react-aria-DisclosurePanel[data-rac][role="group"]
/* When visible: aria-hidden="false" */
/* When hidden: aria-hidden="true" hidden="until-found" */
```

### Section Header (inside disclosure)

```css
h2.truncate.text-subtitle2Stronger.text-neutralFg2
/* Also has: lg:text-title3 mai:text-sectionHeader */
```

### Completion Badge (next to section header)

```css
/* Green checkmark badge = section completed */
div.flex.h-5.w-fit.min-w-5.items-center.justify-center.rounded-full.px-1\.5.bg-statusSuccessBg3.text-neutralFgInverted1

/* Contains count like "3/3" or just a checkmark SVG */
```

### Section Background Variants

```css
/* With background (some sections) */
div.-mx-3.flex.flex-wrap.items-center.gap-2.rounded-xl.p-3.bg-rewardsBgAlpha1

/* Without background (others) */
div.-mx-3.flex.flex-wrap.items-center.gap-2.rounded-xl.p-3
```

---

## 7. Dashboard Page (`/dashboard`)

### Section IDs (anchor navigation)

| Section           | ID          | Content                                   |
| ----------------- | ----------- | ----------------------------------------- |
| Offers/Advantages | `#offers`   | Promotions, punch cards, onboarding       |
| Snapshot/Progress | `#snapshot` | Streak, bonus info                        |
| Daily Set         | `#dailyset` | Daily search tasks, quizzes               |
| Streaks/Activity  | `#streaks`  | Bing/Edge/Mobile/DailySet circle trackers |
| Badges            | _(no id)_   | Achievement badges collection             |

### 7.1 Gold Level Refresh Progress Bar

```css
/* Level status bar (top of page) */
div[aria-label="Actualisation de Or"][role="progressbar"]
/* Attributes: aria-valuenow, aria-valuemin="0", aria-valuemax="100", aria-valuetext="2%" */
```

### Level Status Text

```css
p.text-caption1.mai\:text-itemBody
/* Contains spans with: */
/*   "Actualisation de" + "Or" */
/*   "Points restants :" + "729" */
/*   "Activités restantes :" + "2" */
```

### 7.2 Available Points Card

```css
a[href="https://rewards.bing.com/redeem"] div.overflow-hidden.rounded-2xl.bg-neutralBg1
```

Inside:

```css
p.text-body1Strong  /* "Points disponibles" label */
p.text-title1.font-semibold  /* Points number, e.g., "58" */
img[alt="Points disponibles"]  /* Points icon */
```

### 7.3 "Vos avantages" (Offers) Section

```css
section#offers div.react-aria-Disclosure[data-expanded="true"]
```

### Punch Card Links (Quest modals)

```css
a[href*="modal=quest&questId="]
/* Example: /dashboard?modal=quest&questId=WW_pcparent_redesign_existinguser_onboarding_offer_punchcard */
```

### Offer Cards (Bing Star, Monthly Bonus, etc.)

```css
/* Generic offer card */
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4.hover\:shadow-8.flex.h-full.min-h-22.w-full.items-center.gap-4.p-3

/* Offer title */
p.text-body1Strong.line-clamp-2

/* Offer points section */
div.relative.aspect-square.min-h-16 p.text-subtitle1.leading-none.text-neutralFg1  /* Points number */
p.text-caption2Strong  /* "Points" or "Jusqu'à" label */

/* Completed offer indicator */
svg.size-5.shrink-0.text-statusSuccessFg1  /* Green checkmark icon */

/* Pending status text */
p.line-clamp-2.text-caption1  /* e.g., "Acquis le mois dernier : En attente" */
```

### 7.4 "Votre progression" (Snapshot) Section

```css
section#snapshot div.react-aria-Disclosure
/* Collapsed by default on dashboard */
```

#### Daily Streak Card

```css
button[aria-expanded] div p.text-body1Strong  /* Contains "Série quotidienne" */
img[alt="Série quotidienne"]  /* Streak icon */
p.text-title1.font-semibold  /* Streak count, e.g., "1 jour" or "2 jours" */
```

**Streak Data Model** (from React server component props):

```typescript
// Instrument data on the daily streak button
instrument: {
  name: "SnapshotSection_DailyStreak",
  click: true,
  data: {
    streakCounter: 2,       // Current day count
    isProtectionEnabled: true // Whether streak protection is active
  }
}
```

#### Streak Protection

Streak protection prevents losing your streak if you miss a day.

```css
/* Protection status indicator (inside streak side panel) */
/* Label: "Protection contre les séries" */
/* streakProtectionLabel in i18n messages */

/* Protection status badge within streak card */
div.flex.h-15.flex-col.items-center.justify-center.gap-0\.5.rounded-xl.border.px-2
/* When protection active: border-neutralStrokeDisabled */
```

**i18n Keys**:

```json
{
    "DailyStreak": {
        "streakProtectionLabel": "Protection contre les séries",
        "subtitle": "Maintenez votre série quotidienne : réalisez au moins une activité de série chaque jour.",
        "title": "Série quotidienne",
        "howItWorksBody": "...activer la protection contre les séries pour protéger votre série de points..."
    }
}
```

#### Streak Bonus Card

```css
/* Bonus card with gradient text */
p.bg-rewardsBgBonusGradient.bg-clip-text.text-body1Stronger.text-transparent
/* Contains e.g., "+1 000 point" */

/* Bonus card button */
button[aria-expanded] div p.text-body1Strong  /* Contains "Bonus de série" */
```

**Streak Bonus Data Model**:

```typescript
// Instrument data on streak bonus card
instrument: {
  name: "SnapshotSection_StreakBonus",
  click: true,
  data: {
    bonus: 1000,              // Total bonus points
    activityProgress: 11,    // Stamps collected
    activitiesTotal: 12      // Stamps needed
  }
}

// DSE Bonus model (Default Search Engine bonus)
model: {
  bonus: {
    prevPointsEarned: 0,
    prevPointsMax: 210,
    pointsMax: 210,
    pointsPerLevel: { "1": 30, "2": 90, "3": 210 },
    state: "pending",     // "pending" | "complete" | "notEligible"
    daysProgress: 2,
    daysMax: 14
  }
}
```

**i18n Keys**:

```json
{
    "StreakBonus": {
        "ctaText": "Afficher les séries quotidiennes",
        "overlay": "POINTS BONUS",
        "progress": "{activities, number} étapes à réaliser",
        "subtitle": "Pour gagner des points plus rapidement, utilisez les produits Microsoft chaque jour pour compléter des séries.",
        "subtitleCompleted": "Vous avez collecté tous les tampons {stamps, number} et gagné {points, number} points bonus",
        "title": "Bonus de série"
    }
}
```

#### Streak Progress Dots

```css
div.flex.h-15.flex-col.items-center.justify-center.gap-1
/* Contains individual day-of-week dots */
```

#### Claim Points Card ("Prêt à réclamer")

```css
/* Claim card button (in snapshot section) */
button[data-rac][aria-expanded] div p.text-body1Strong  /* Contains "Prêt à réclamer" */
img[alt="Prêt à réclamer"]  /* Coins icon */
p.text-title1.font-semibold  /* Points to claim, e.g., "423" */

/* Claim CTA button (bottom of card) */
div.items-center.justify-center.bg-rewardsBgAlpha1.px-4.py-2.text-center.font-semibold
/* Text: "Réclamer" */
```

**Point Claim Data Model**:

```typescript
model: {
  pointClaim: {
    points: 423,              // Total claimable
    entries: [
      { category: "mtb", description: "Bonus de niveau mensuel", points: 180 },
      { category: "bsc", description: "Bonus Bing Star", points: 243 }
    ]
  }
}
```

**i18n Keys**:

```json
{
    "PointsClaim": {
        "claimCta": "Réclamer des points",
        "claimInProgress": "Demande en cours",
        "errorMessage": "Une erreur est survenue lors de la réclamation de vos points. Veuillez réessayer plus tard.",
        "nothingToClaim": "Aucun point à récupérer pour l'instant",
        "successMessage": "Revendication réussie !",
        "title": "Réclamer des points"
    }
}
```

#### Goal Card ("Définir un objectif Récompenses")

```css
/* Goal card link */
a[data-rac][href*="/redeem/vn?section=shop"]
/* Instrument: RedeemGoalCard */

/* Goal card text */
p.text-body1Strong  /* "Définir un objectif Récompenses" */
p.text-body1Strong  /* "Choisissez une carte cadeau ou un don comme objectif" */

/* Goal card placeholder icon */
div.grid.h-17.w-30.shrink-0.place-items-center.rounded-xl.border.border-neutralStroke1.bg-neutralBgAlpha1
/* Contains gift SVG icon */

/* Browse rewards CTA */
div.text-caption1  /* "Parcourir les récompenses" */
```

### 7.5 "Ensemble du jour" (Daily Set) Section

```css
section#dailyset div.react-aria-Disclosure
```

#### Daily Set Tasks (Search/Quiz links)

```css
/* Link to daily task */
section#dailyset a[data-rac][href*="bing.com/search"]
section#dailyset a[data-rac][href*="REWARDSQUIZ"]

/* Task card inside */
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4.hover\:shadow-8

/* Task title */
p.line-clamp-3.text-body1Strong

/* Points badge */
div.flex.h-5.w-fit.min-w-5.items-center.justify-center.rounded-full.px-1\.5.border.border-neutralStroke1
p.text-caption1Stronger.leading-none.text-neutralFg2  /* e.g., "+10" */
```

#### Daily Set URL Pattern

```
https://www.bing.com/search?q=QUERY&form=ML2G76&OCID=ML2G76&PUBL=RewardsDO&CREA=ML2G76&rnoreward=1&filters=BTEPOKey%3A%22REWARDSQUIZ_DailySet_UrlOffer%22+...
```

### 7.6 "Votre activité" (Streaks/Activity) Section

```css
section#streaks div.react-aria-Disclosure
```

#### Activity Circle Progress Bars (Bing, Daily Set, Edge, Mobile)

```css
/* Circular progress */
div[role="progressbar"][aria-label="Bing"]
div[role="progressbar"][aria-label="Ensemble du jour"]
div[role="progressbar"][aria-label="Edge"]
div[role="progressbar"][aria-label="Application mobile"]

/* Properties: aria-valuenow, aria-valuemin, aria-valuemax, aria-valuetext */
/* Container: div.h-18.w-18 */
```

#### Activity Circle Card

```css
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-2.hover\:shadow-4.flex.h-full.w-full.flex-col.gap-2.px-4.py-3

/* Label */
p.text-body1Strong.text-neutralFg3  /* "Bing", "Edge", "Ensemble du jour", "Application mobile" */

/* Greyscale = incomplete */
div.relative.self-center.grayscale  /* Added when activity = 0 */
```

#### SVG Circle Progress Structure

```html
<svg width="100%" height="100%" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="41.7" stroke="var(--color-rewardsBgAlpha3)" />
    <!-- Background -->
    <circle
        cx="50"
        cy="50"
        r="41.7"
        stroke="var(--color-brandBg1)"
        stroke-dasharray="262.0088..."
        stroke-dashoffset="0"
    />
    <!-- 0 = 100% filled -->
</svg>
```

### 7.7 Carousel / Banner Slides

The offers section includes a carousel with slide indicators.

```css
/* Carousel radio group (slide indicators) */
div[role="radiogroup"]

/* Active slide indicator */
button[aria-pressed="true"]  /* e.g., aria-label="Diapositive 1 sur 3" */

/* Inactive slide indicators */
button[aria-pressed="false"]  /* e.g., aria-label="Diapositive 2 sur 3" */

/* Next slide button */
button[aria-label="Diapositive suivante"]

/* Previous slide button */
button[aria-label="Diapositive précédente"]
```

### 7.8 Coupon Button

```css
/* Coupon button in offers section */
button[data-rac]  /* Contains text "Coupon (1)" */

/* Coupon trigger text pattern */
/* triggerLabel: "Coupon ({count, number})" */
```

### 7.9 Achievements Section

```css
section#achievements div.react-aria-Disclosure
/* Collapsed by default; title: "Réalisations" */
/* Instrument: Dashboard_AchievementsSection */
```

**i18n Keys**:

```json
{
    "featureEdu": {
        "title": "Atteindre vos objectifs",
        "description": "Débloquer des badges lorsque vous atteignez des étapes clés, comme gagner, échanger ou offrir des points."
    }
}
```

#### Achievement Badge Milestones

Streak-based badges come in these tiers:

| Badge Name         | Category                  | Requirement     |
| ------------------ | ------------------------- | --------------- |
| Série de 7 jours   | Série quotidienne         | 7 days streak   |
| Série de 30 jours  | Série quotidienne         | 30 days streak  |
| Série de 60 jours  | Série quotidienne         | 60 days streak  |
| Série de 90 jours  | Série quotidienne         | 90 days streak  |
| Série de 180 jours | Série quotidienne         | 180 days streak |
| Série de 365 jours | Série quotidienne         | 365 days streak |
| Série de 999 jours | Série quotidienne de sets | 999 days streak |

```css
/* Badge progress text (unearned) */
p.text-center.text-caption1Strong.text-neutralFg3  /* "79 / 180" or "Acquis le 09/11/25" */

/* Badge earned date format */
/* "Acquis le DD/MM/YY" */
```

### 7.10 Badges Section (Legacy)

```css
/* Badge card */
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4.flex.h-full.w-full.flex-col.gap-1\.5.p-2

/* Badge image */
div.relative.shrink-0.overflow-hidden.rounded-lg.bg-neutralBg2.aspect-square img
/* alt text = badge name: "Collègue de bureau", "Patron de DOS", "Audiophile", etc. */

/* Badge title */
p.text-subtitle2.lg\:text-subtitle1  /* Badge name */

/* Badge progress (unearned) */
p.text-center.text-neutralFg3  /* "35 000 points à vie" or "1 997 points cumulés" */
p.text-center.text-caption1Strong.text-neutralFg3  /* "25 408 / 35 000" or "Acquis le 05/11/25" */

/* Unearned badge overlay */
div.relative.shrink-0.overflow-hidden.rounded-lg.bg-neutralBg2.aspect-square.grayscale
div.absolute.inset-0.bg-black.opacity-40  /* Dark overlay on locked badges */
```

---

## 8. Earn Page (`/earn`)

### Section IDs

| Section         | ID               | Content                                   |
| --------------- | ---------------- | ----------------------------------------- |
| Streaks         | `#streaks`       | Bing search streak, daily check-in streak |
| Explore on Bing | `#exploreonbing` | Search task cards                         |

### Page Title

```css
h1.text-title2.md\:text-largeTitle.mai\:text-pageHeader
/* Text: "Gagner des récompenses" */
```

### Subtitle

```css
p.text-body2.text-neutralFg3.mai\:text-readingBody
/* Text: "Parcourez pour trouver les bonnes affaires..." */
```

### 8.1 Top Summary Cards

#### Today's Points Card ("Les points du jour")

```css
/* Today's points button */
button[data-rac][aria-expanded="false"]  /* Contains "Les points du jour" */
/* Shows total points earned today, e.g., "21" */
p.text-title1.font-semibold  /* Points number */
```

#### Points Breakdown Button

```css
/* "Répartition des points" button */
button[data-rac]  /* Contains text "Répartition des points" */
```

#### Daily Streak Card (Earn top)

```css
/* Daily streak card on Earn page */
button[data-rac][aria-expanded="false"]  /* Contains "Série quotidienne" */
/* Shows current streak count, e.g., "1" */
```

#### "En savoir plus" Card

```css
button[data-rac] div.items-center.justify-center.bg-rewardsBgAlpha1.px-4.py-2.text-center.font-semibold
/* Text: "En savoir plus" */
/* Shows "1" point available */
```

### 8.2 Streaks Section (`#streaks`)

```css
section#streaks div.react-aria-Disclosure[data-expanded="true"]
h2:has-text("Séries")  /* Section header */
```

#### Streak Cards

```css
/* Streak card button */
section#streaks button[data-rac][aria-expanded]

/* Streak card structure */
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4.hover\:shadow-8.flex.h-full.w-full.flex-col

/* Card title */
p.text-body1Strong  /* "Série Recherche Bing", "Série d'Archivage" */

/* Streak day count badge (green = active) */
div.shrink-0.rounded-full.flex.items-center.justify-center.border.h-5.w-fit.px-1\.5.border-brandBg1.bg-brandBg1.text-neutralFgOnBrand
/* Contains: checkmark SVG + "1 jour" text */

/* Streak progress text */
div.line-clamp-2.text-end.text-caption1.wrap-anywhere
/* "Recherche : 3/3" or "Archivage : 0/1" */
```

#### Card Image (streak type)

```css
img[alt="Série Recherche Bing"]  /* Bing search streak image */
```

### 8.3 "Explorer sur Bing" Section (`#exploreonbing`)

```css
section#exploreonbing div.react-aria-Disclosure[data-expanded="true"]
```

#### Explore Task Links

```css
/* External Bing links */
section#exploreonbing a[data-rac][href*="bing.com"]
/* target="_blank" - opens in new tab */

/* Task card structure */
a[data-rac] div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4.hover\:shadow-8

/* Task card with hover image zoom */
div.hover\:\[\&_img\]\:scale-110
```

#### Task Card Content

```css
/* Task title */
p.line-clamp-3.text-body1Strong  /* "Apprenez les paroles des chansons", "Traduisez n'importe quoi", etc. */

/* Task description */
p.line-clamp-3  /* "Recherchez sur Bing les paroles de votre chanson préférée" */

/* Points badge */
div.flex.h-5.w-fit.min-w-5.items-center.justify-center.rounded-full.px-1\.5.border.border-neutralStroke1
p.text-caption1Stronger.leading-none.text-neutralFg2  /* "+10", "+20", "+50" */

/* Availability text (if not yet available) */
div.line-clamp-2.text-end.text-caption1.wrap-anywhere  /* "Disponible vendredi" */

/* Icon container (top-right of card) */
div.flex.h-6.items-center.justify-end.gap-1  /* Contains gift/treasure chest SVG icons */
```

#### Task Bing URL Pattern

```
https://www.bing.com/?form=ML2PCR&OCID=ML2PCR&PUBL=RewardsDO&CREA=ML2PCR&rwAutoFlyout=exb
/* Also specific search queries with rwAutoFlyout=exb */
```

---

## 9. Redeem Page (`/redeem`)

### Sub-Tab Navigation

| Tab             | href                | Content        |
| --------------- | ------------------- | -------------- |
| Recommandés     | `/redeem/fr`        | Featured items |
| Cartes cadeaux  | `/redeem/fr/shop`   | Gift cards     |
| Faire un don    | `/redeem/fr/donate` | Donations      |
| Tirages au sort | `/redeem/fr/win`    | Sweepstakes    |

### Section IDs

| Section | ID        |
| ------- | --------- |
| Shop    | `#shop`   |
| Donate  | `#donate` |
| Win     | `#win`    |

### Gift Card Item Links

```css
a[data-rac][href*="/redeem/sku/"]
/* Each links to: https://rewards.bing.com/redeem/sku/XXXXXXXXXXXX */
```

### Gift Card Structure

```css
/* Card container */
div.overflow-hidden.rounded-2xl.bg-neutralBg1.shadow-4

/* Card image */
div.relative.aspect-video.shrink-0.overflow-hidden img

/* Card title */
p.text-subtitle2Stronger  /* Gift card name */

/* Points cost */
p.text-subtitle2Stronger  /* Points number */
p.text-caption2.text-neutralFg2  /* "pts" label */

/* Discounted items */
div.flex.items-center.gap-0\.5.text-statusDangerFg1  /* Red sale price */
p.line-through  /* Original price (struck through) */
```

### Donation URLs

```
https://rewards.bing.com/redeem/sku/000999012006?causeId=XXX-XXXXXXXXX
```

### 9.1 Goal Card on Redeem Page

```css
/* Goal card link (also present on dashboard) */
a[data-rac][href*="/redeem/vn?section=shop"]
p.text-body1Strong  /* "Définir un objectif Récompenses" */
p.text-body1Strong  /* "Sélectionnez votre pays et choisissez une carte cadeau ou un don comme objectif" */
```

### 9.2 Region Warning

```css
/* Region warning banner */
/* Text: "En déplacement ? Vous prévisualisez un catalogue en dehors de votre pays d'origine" */
/* "Revenir à mon pays" link → /redeem/vn */
a[href*="/redeem/vn"]  /* Return to country link */
```

### 9.3 Search Button on Redeem

```css
a[aria-label="Rechercher"][href*="/redeem/fr/shop?af=true"]
```

### 9.4 Product Detail Page (SKU)

Accessed via `/redeem/sku/XXXXXXXXXXXX`.

#### Back Navigation

```css
a[href="https://rewards.bing.com/redeem"]  /* Text: "Retour" */
```

#### Product Title

```css
/* Product name as heading */
/* e.g., "Carte numérique Roblox" */
```

#### Option Selection (Toggle Buttons)

Product options use `aria-pressed` toggle buttons:

```css
/* Selected option */
button[aria-pressed="true"][data-selected="true"]
/* Classes: bg-neutralBg1Selected border-neutralStroke1Selected text-neutralFg1Selected */

/* Unselected option */
button[aria-pressed="false"]
/* Classes: bg-neutralBg1 border-neutralStroke1 text-neutralFg1 */

/* Option text examples: "400 Robux", "800 Robux", "1000 Robux" */
```

#### Discount Badge

```css
/* Discount chip */
div.border-statusDangerFg3  /* Contains e.g., "200 pts désactivés" */

/* Current price */
p  /* e.g., "6 550 pts" */

/* Original price (strikethrough) */
span  /* with strikethrough, e.g., "6 750" */
```

#### Redemption Progress Bar

```css
div[role="progressbar"][aria-label="Progression des points à échanger"]
/* aria-valuenow="92", aria-valuemax="6550" */
/* Shows how close user is to having enough points */
```

#### Coupon Checkbox

```css
/* React Aria Checkbox (coupon application) */
div.react-aria-Checkbox[data-selected="true"]
input[type="checkbox"][checked]  /* Inside the checkbox component */
/* Label: "-200 pts : Coupon de remise d'échange" */

/* Unselected coupon checkbox */
div.react-aria-Checkbox:not([data-selected])
```

#### "Afficher le catalogue" Link

```css
a[href*="/redeem/vn"]  /* Text: "Afficher le catalogue" */
```

---

## 10. About Page (`/about`)

### Section IDs

| Section    | ID            |
| ---------- | ------------- |
| Perks      | `#perks`      |
| Microsoft  | `#microsoft`  |
| Benefits   | `#benefits`   |
| FAQ        | `#faq`        |
| Help       | `#help`       |
| Disclaimer | `#disclaimer` |

### CTA Button

```css
a.bg-brandBg1.border-transparent.text-neutralFgOnBrand.rounded-full
```

### FAQ Accordion

```css
/* FAQ trigger */
button[aria-expanded][slot="trigger"]

/* FAQ panel */
div[role="group"][aria-hidden]
```

### Member Level Table

```css
div[role="table"]
div[role="row"]
div[role="cell"]
```

### Tier Indicators

```css
/* Base */   .border-b-rewards-baseCore\/50   .bg-rewardsBgBaseGradient
/* Silver */ .border-b-rewards-silverCore\/70  .bg-rewardsBgSilverGradient
/* Gold */   .border-b-rewards-goldCore\/50    .bg-rewardsBgGoldGradient

/* Gold highlight */
.bg-rewards-goldCore\/10.text-neutralFg1
```

---

## 11. Refer Page (`/refer`)

### Section IDs

| Section        | ID                |
| -------------- | ----------------- |
| How it works   | `#how-it-works`   |
| Your referrals | `#your-referrals` |

### Referral Link Input

```css
input[readonly][value*="rewards.bing.com/welcome?rh="]
/* Inside: span.inline-flex */
```

### Copy Button

```css
button[data-rac]  /* Contains "Copier le lien" text */
```

### Share Button

```css
button[data-rac]  /* Contains "Partager" text */
```

### Referral Stats

```css
p.text-subtitle2Stronger.text-neutralFg2
/* Values: "Références" (0), "Points obtenus" (0), "Points en attente" (0) */
```

### Pending Points Info Tooltip

```css
button[aria-label="À propos de Points en attente"][aria-expanded]
```

---

## 12. Progress Bars

### Linear Progress Bar

```css
div[role="progressbar"]
/* Attributes: aria-valuenow, aria-valuemin, aria-valuemax, aria-valuetext */
/* aria-label identifies what it tracks */
```

#### Level Refresh Bar (Dashboard top)

```css
div[role="progressbar"][aria-label="Actualisation de Or"]
/* Track: div.bg-rewardsBgAlpha2.rounded-full.h-1\.5 */
/* Fill:  div.h-full.rounded-full.bg-brandBgCompound (style="width:X%") */
```

#### Gift Card Progress Bar (Redeem page)

```css
div[role="progressbar"]
/* Same structure, inside gift card items */
```

### Circular Progress Bar (Activity trackers)

```css
div[role="progressbar"].h-18.w-18
/* aria-label: "Bing", "Ensemble du jour", "Edge", "Application mobile" */
/* Uses SVG circles with stroke-dasharray/stroke-dashoffset */
```

---

## 13. Cards & Task Items

### Standard Card

```css
div.overflow-hidden.rounded-2xl.bg-neutralBg1
/* Common additions: shadow-2, shadow-4, hover:shadow-4, hover:shadow-8 */
/* With forced colors support: forced-colors:border */
```

### Card Hover States

```css
.cursor-pointer.hover\:bg-neutralBg1Hover.active\:bg-neutralBg1Pressed
```

### Card Types

| Card Type     | Additional Classes                                                           | Context            |
| ------------- | ---------------------------------------------------------------------------- | ------------------ |
| Activity card | `shadow-2 hover:shadow-4 flex h-full w-full flex-col gap-2 px-4 py-3`        | Activity circles   |
| Task card     | `shadow-4 hover:shadow-8 flex h-full w-full flex-col`                        | Earn page tasks    |
| Offer card    | `shadow-4 hover:shadow-8 flex h-full min-h-22 w-full items-center gap-4 p-3` | Dashboard offers   |
| Gift card     | `shadow-4`                                                                   | Redeem page items  |
| Badge card    | `shadow-4 flex h-full w-full flex-col gap-1.5 p-2`                           | Dashboard badges   |
| Streak card   | `shadow-2 hover:shadow-4 flex h-38 w-full flex-col gap-3 px-4 py-3`          | Dashboard snapshot |

### Card Grid Layouts

```css
/* 4-column responsive grid */
div.grid.grid-cols-1.gap-3.sm\:grid-cols-2.lg\:grid-cols-3.xl\:grid-cols-4.3xl\:grid-cols-5

/* 6-column responsive grid (dashboard top) */
div.grid.grid-cols-1.gap-x-3.gap-y-6.sm\:grid-cols-2.lg\:gap-y-10.xl\:grid-cols-4.2xl\:grid-cols-6
```

---

## 14. Badges & Status Indicators

### Points Badge (Small, in cards)

```css
/* Points value badge (bordered) */
div.flex.h-5.w-fit.min-w-5.items-center.justify-center.rounded-full.px-1\.5.border.border-neutralStroke1
p.text-caption1Stronger.leading-none.text-neutralFg2  /* e.g., "+10" */

/* Active/complete badge (green filled) */
div.flex.h-5.w-fit.min-w-5.items-center.justify-center.rounded-full.px-1\.5.bg-statusSuccessBg3.text-neutralFgInverted1

/* Streak active badge (brand color filled) */
div.shrink-0.rounded-full.border.h-5.w-fit.px-1\.5.border-brandBg1.bg-brandBg1.text-neutralFgOnBrand
```

### Completion Icons

```css
/* Green checkmark (task complete) */
svg.size-5.shrink-0.text-statusSuccessFg1

/* External link icon (opens new tab) */
svg.size-4.shrink-0.text-neutralFg2Link  /* External link arrow icon */

/* Chevron (expand / navigate) */
svg.size-3.shrink-0.-rotate-90  /* Right-pointing chevron */
svg.size-3\.5.text-neutralFg1.rotate-180  /* Down-pointing, expanded */
svg.size-3\.5.text-neutralFg1  /* Up-pointing, collapsed */
```

### Gradient Backgrounds

```css
.bg-rewardsBgGoldGradient      /* Gold member background */
.bg-rewardsBgSilverGradient    /* Silver member background */
.bg-rewardsBgBaseGradient      /* Base member background */
.bg-rewardsBgBonusGradient     /* Streak bonus text gradient */
.bg-rewardsBgAlpha1            /* Section backgrounds, CTA areas */
.bg-rewardsBgAlpha2            /* Progress bar tracks */
.bg-rewardsBgAlpha3            /* SVG circle tracks */
.bg-brandBgCompound            /* Progress bar fills */
.bg-brandBg1                   /* Brand primary color fills */
```

---

## 15. Cookie Consent Banner

### Banner Container

```css
/* Obfuscated class names - use style ID instead */
[id="ms-consent-banner-main-styles"]  /* In <head> */

/* Banner bar selector by structure */
div._23tra1HsiiP6cT-Cka-ycB  /* Minified class, may change */
```

### Consent Buttons (by class pattern)

```css
/* Accept button (primary, blue) */
button._1zNQOqxpBFSokeCLGi_hGr

/* Reject button (secondary, grey) */
button.erL690_8JwUW-R4bJRcfl
```

### Consent Dialog (modal)

```css
div._2bvsb3ubApyZ0UGoQA9O9T  /* Full-screen overlay */
div.AFsJE948muYyzCMktdzuk     /* Dialog box */
```

### Consent Script

```css
script[data-nscript="lazyOnload"][src*="wcp-consent"]
```

> **Note**: Cookie consent class names are obfuscated CSS modules and may change between deployments. Prefer using the button text content or position-based selectors.

---

## 16. URL Patterns & Query Parameters

### Page Routes

| Route               | Page                        |
| ------------------- | --------------------------- |
| `/dashboard`        | Dashboard                   |
| `/earn`             | Earn points                 |
| `/redeem`           | Redeem                      |
| `/redeem/fr`        | Recommended (French locale) |
| `/redeem/fr/shop`   | Gift cards                  |
| `/redeem/fr/donate` | Donations                   |
| `/redeem/fr/win`    | Sweepstakes                 |
| `/about`            | About                       |
| `/refer`            | Referral                    |

### Dashboard Modal URLs

```
/dashboard?modal=quest&questId=WW_pcparent_redesign_existinguser_onboarding_offer_punchcard
```

### Bing Search Task URLs

```
# Daily Set task
https://www.bing.com/search?q=QUERY&form=ML2G76&OCID=ML2G76&PUBL=RewardsDO&CREA=ML2G76&rnoreward=1&filters=BTEPOKey%3A%22REWARDSQUIZ_DailySet_UrlOffer%22+BTDSUOI%3A%22...%22

# Explore on Bing
https://www.bing.com/?form=ML2PCR&OCID=ML2PCR&PUBL=RewardsDO&CREA=ML2PCR&rwAutoFlyout=exb
```

### Redeem SKU URLs

```
# Gift card
https://rewards.bing.com/redeem/sku/XXXXXXXXXXXX

# Donation
https://rewards.bing.com/redeem/sku/000999012006?causeId=XXX-XXXXXXXXX
```

### Referral URL

```
https://rewards.bing.com/welcome?rh=XXXXXXXX
```

### Key URL Parameters

| Parameter      | Value              | Purpose                       |
| -------------- | ------------------ | ----------------------------- |
| `form`         | `ML2G76`, `ML2PCR` | Tracking form identifier      |
| `OCID`         | Same as form       | Origin/campaign ID            |
| `PUBL`         | `RewardsDO`        | Publisher                     |
| `CREA`         | Same as form       | Creative ID                   |
| `rnoreward`    | `1`                | No-reward flag (daily set)    |
| `rwAutoFlyout` | `exb`              | Auto-flyout for explore tasks |
| `filters`      | BTEPOKey, BTDSUOI  | Quiz/task identification      |
| `modal`        | `quest`            | Opens quest modal             |
| `questId`      | ID string          | Specific quest to show        |

---

## 17. Recommended Automation Selectors (Summary)

### High Priority (Navigation & State Detection)

```typescript
const SELECTORS = {
    // Shell & Layout
    shell: '#shell',
    mainContent: 'main.pg-content',

    // Navigation
    navLink: (page: string) => `header a[href*="/${page}"]`,
    activeTab: 'a[data-selected="true"][aria-current="page"]',

    // Profile & Points
    profileButton: 'button[aria-label="Afficher le profil"]',
    currentPoints:
        'button[aria-label="Afficher le profil"] p.text-title1, button[aria-label="Afficher le profil"] div.flex p',

    // Universal Interactive Elements
    clickable: '[data-react-aria-pressable="true"]',
    racComponent: '[data-rac]',

    // Disclosure Sections
    disclosureExpanded: '.react-aria-Disclosure[data-expanded="true"]',
    disclosureCollapsed: '.react-aria-Disclosure:not([data-expanded="true"])',
    disclosureTrigger: 'button[slot="trigger"]',
    disclosurePanel: '.react-aria-DisclosurePanel[role="group"]',

    // Section by ID
    section: (id: string) => `section#${id}`,
    sectionHeader: 'h2.text-subtitle2Stronger',

    // Progress Bars
    progressBar: '[role="progressbar"]',
    progressBarByLabel: (label: string) => `[role="progressbar"][aria-label="${label}"]`,

    // Cards (generic)
    card: 'div.overflow-hidden.rounded-2xl.bg-neutralBg1',

    // Points Badge
    pointsBadge: 'div.rounded-full.px-1\\.5.border.border-neutralStroke1 p.text-caption1Stronger',
    completionBadge: 'div.bg-statusSuccessBg3',

    // Completion indicator
    greenCheck: 'svg.text-statusSuccessFg1'
}
```

### Dashboard-Specific

```typescript
const DASHBOARD = {
    // Sections
    offersSection: 'section#offers',
    snapshotSection: 'section#snapshot',
    dailySetSection: 'section#dailyset',
    streaksSection: 'section#streaks',
    achievementsSection: 'section#achievements',

    // Level Progress
    levelProgressBar: '[role="progressbar"][aria-label*="Actualisation"]',
    pointsRemaining: 'p.text-caption1 span.font-semibold', // "729" (points remaining)

    // Available Points
    availablePointsCard: 'a[href*="/redeem"] p.text-title1.font-semibold',

    // Daily Set Tasks
    dailySetLinks: 'section#dailyset a[href*="bing.com"]',

    // Activity Circles
    bingProgress: '[role="progressbar"][aria-label="Bing"]',
    dailySetProgress: '[role="progressbar"][aria-label="Ensemble du jour"]',
    edgeProgress: '[role="progressbar"][aria-label="Edge"]',
    mobileProgress: '[role="progressbar"][aria-label="Application mobile"]',

    // Streak Info
    dailyStreak: 'p.text-body1Strong:has-text("Série quotidienne")',
    streakBonus: 'p.bg-rewardsBgBonusGradient',

    // Claim Points
    claimCard: 'p.text-body1Strong:has-text("Prêt à réclamer")',
    claimButton: 'div.bg-rewardsBgAlpha1.text-center.font-semibold',

    // Goal Card
    goalCard: 'a[data-rac][href*="/redeem/vn?section=shop"]',

    // Carousel
    carouselRadioGroup: '[role="radiogroup"]',
    carouselNextSlide: 'button[aria-label="Diapositive suivante"]',
    carouselPrevSlide: 'button[aria-label="Diapositive précédente"]',

    // Offer Cards
    offerCard: 'section#offers div.min-h-22.items-center.gap-4.p-3',
    offerTitle: 'p.text-body1Strong.line-clamp-2',
    offerPoints: 'p.text-subtitle1.leading-none.text-neutralFg1'
}
```

### Earn-Specific

```typescript
const EARN = {
    // Sections
    streaksSection: 'section#streaks',
    exploreSection: 'section#exploreonbing',

    // Streak Cards
    streakCard: 'section#streaks button[data-rac][aria-expanded]',
    bingSearchStreak: 'img[alt*="Série Recherche Bing"]',
    streakProgress: 'div.text-end.text-caption1.wrap-anywhere', // "Recherche : 3/3"

    // Task Cards
    taskLink: 'section#exploreonbing a[data-rac][href*="bing.com"]',
    taskTitle: 'p.line-clamp-3.text-body1Strong',
    taskDescription: 'p.line-clamp-3:not(.text-body1Strong)',
    taskPoints: 'p.text-caption1Stronger.leading-none.text-neutralFg2',
    taskAvailability: 'div.text-end.text-caption1.wrap-anywhere' // "Disponible vendredi"
}
```

### Redeem-Specific

```typescript
const REDEEM = {
    // Sub-tabs
    recommendedTab: 'a[href*="/redeem/fr"]',
    giftCardsTab: 'a[href*="/redeem/fr/shop"]',
    donateTab: 'a[href*="/redeem/fr/donate"]',
    sweepstakesTab: 'a[href*="/redeem/fr/win"]',

    // Gift cards
    giftCardLink: 'a[href*="/redeem/sku/"]',
    giftCardTitle: 'p.text-subtitle2Stronger',
    giftCardPoints: 'p.text-subtitle2Stronger', // context-dependent
    discountedPrice: 'div.text-statusDangerFg1',
    originalPrice: 'p.line-through',

    // Search
    searchButton: 'a[aria-label="Rechercher"][href*="/redeem/fr/shop?af=true"]',

    // Goal card
    goalCard: 'a[data-rac][href*="/redeem/vn?section=shop"]',

    // Region warning
    returnToCountryLink: 'a[href*="/redeem/vn"]',

    // Sections
    shopSection: 'section#shop, #shop',
    donateSection: 'section#donate, #donate',
    winSection: 'section#win, #win'
}
```

### Product Detail (SKU) Page

```typescript
const PRODUCT_DETAIL = {
    // Navigation
    backLink: 'a[href="https://rewards.bing.com/redeem"]',

    // Options
    selectedOption: 'button[aria-pressed="true"][data-selected="true"]',
    unselectedOption: 'button[aria-pressed="false"]',

    // Progress
    redemptionProgress: '[role="progressbar"][aria-label="Progression des points à échanger"]',

    // Coupon
    couponCheckbox: '.react-aria-Checkbox',
    couponChecked: '.react-aria-Checkbox[data-selected="true"]',

    // Discount
    discountBadge: 'div.border-statusDangerFg3',

    // Catalog
    viewCatalog: 'a[href*="/redeem/vn"]'
}
```

### Profile Popover

```typescript
const PROFILE = {
    // Trigger
    profileButton: 'button[aria-label="Afficher le profil"]',
    currentPoints: 'button[aria-label="Afficher le profil"] p',

    // Popover
    popoverOverlay: 'div[data-testid="underlay"]',
    popover: '.react-aria-Popover[data-trigger="DialogTrigger"]',
    dialog: 'section[role="dialog"]',
    dismissButton: 'button[aria-label="Rejeter"]',

    // User info
    userName: 'p.pii.truncate.text-subtitle2',
    userEmail: 'p.pii.truncate:not(.text-subtitle2)',
    logoutLink: 'a[href="/auth/logout"]',
    accountLink: 'a[href="https://account.microsoft.com"]'
}
```

---

## 18. Error & Suspended Account Pages

### Page Not Found (404)

```css
div.pg-content p.text-title2.lg\:text-largeTitle  /* "Nous n'avons pas pu trouver la page" */
/* Contains: "Vérifiez l'URL ou revenez à la page d'accueil" */
a[href="/"]  /* "page d'accueil" link */
```

### Suspended Account (403)

```css
div.pg-content p.text-title2.lg\:text-largeTitle  /* "Votre compte Microsoft Rewards a été suspendu" */
```

#### Suspension Reasons List

The forbidden page lists violation reasons:

```css
li  /* Each <li> contains a reason: */
/* - "Ouvrir plusieurs comptes utilisateur par personne" */
/* - "Résider en dehors des régions prises en charge" */
/* - "Fournir des informations de compte inexactes, notamment votre vrai prénom et nom, votre adresse postale complète et exacte, un numéro de téléphone fonctionnel et votre adresse e-mail" */
/* - "Utiliser un service destiné à masquer votre véritable adresse IP ou votre localisation" */
/* - "Utiliser un bot, un code de triche, une macro ou toute autre méthode automatisée pour participer à Microsoft Rewards" */
```

> **Important for automation**: Microsoft explicitly prohibits automated methods. The phone number requirement exists in account information.

---

## 19. React Aria Component Catalog

References to the React Aria components imported in the Next.js bundles:

| Component         | Usage                                                      |
| ----------------- | ---------------------------------------------------------- |
| `DialogTrigger`   | Profile button triggers profile popover dialog             |
| `Dialog`          | Profile popover content, side panels                       |
| `Popover`         | `.react-aria-Popover` — profile flyout                     |
| `Disclosure`      | `.react-aria-Disclosure` — collapsible sections            |
| `DisclosurePanel` | `.react-aria-DisclosurePanel` — collapsible content        |
| `Checkbox`        | `.react-aria-Checkbox` — coupon toggle on product page     |
| `progressbar`     | `[role="progressbar"]` — linear and circular progress bars |
| `radiogroup`      | `[role="radiogroup"]` — carousel slide indicators          |

### React Aria i18n (French Locale)

Key aria translations loaded in the French locale:

```javascript
'@react-aria/overlays': { dismiss: "Rejeter" }
'@react-aria/searchfield': { "Clear search": "Effacer la recherche" }
'@react-aria/menu': { longPressMessage: "Appuyez de manière prolongée ou appuyez sur Alt + Flèche vers le bas pour ouvrir le menu." }
'@react-aria/steplist': { steplist: "Liste des étapes" }
'@react-aria/spinbutton': { Empty: "Vide" }
```

---

## 20. Data Models & Instrumentation

### Instrumentation Names (for telemetry tracking)

These `instrument.name` values are used throughout the RSC payloads:

| Instrument Name                     | Feature                              |
| ----------------------------------- | ------------------------------------ |
| `HeaderProfile_Profile`             | Profile button click                 |
| `HeaderProfileFlyout_Logout`        | Logout button in profile popover     |
| `Dashboard_OffersSection`           | Offers disclosure section view       |
| `Dashboard_SnapshotSection`         | Snapshot disclosure section view     |
| `Dashboard_DailySetSection`         | Daily set disclosure section view    |
| `Dashboard_StreakSection`           | Streaks disclosure section view      |
| `Dashboard_AchievementsSection`     | Achievements disclosure section view |
| `SnapshotSection_DailyStreak`       | Daily streak card click              |
| `SnapshotSection_StreakBonus`       | Streak bonus card click              |
| `DashboardStreakSection_StreakCard` | Activity streak card click           |
| `RedeemGoalCard`                    | Goal card click/view                 |

### Monthly Bonus Tiers

```typescript
const BONUS_TIERS = {
    MonthlyTierBonus: { newLevel1: 60, newLevel2: 180, newLevel3: 420 },
    DSEBonus: { newLevel1: 30, newLevel2: 90, newLevel3: 210 },
    GoodUserBonus: { newLevel1: 300, newLevel2: 900, newLevel3: 2100 },
    RedemptionDiscountCoupons: { newLevel2: 100, newLevel3: 200 }
}

// Star bonus modal URL
const STAR_BONUS_URL = '?modal=starbonus'
// Points breakdown URL
const POINTS_BREAKDOWN_URL = 'https://rewards.bing.com/pointsbreakdown'
```

### Daily Set Task Data Model

```typescript
interface DailySetTask {
    date: string // "02/06/2026" (DD/MM/YYYY)
    description: string // task description in French
    destination: string // full Bing URL with tracking params
    hash: string // SHA-256 hash for verification
    imageUrl: string // bing.com/th?id=OMR.xxx
    isCompleted: boolean // whether task is done
    isLocked: undefined | boolean
    isUnlocked: undefined | boolean
    offerId: string // e.g., "Global_DailySet_20260206_Child1"
    points: number // e.g., 10
    title: string // task title in French
}
```

### Streak Types

| Streak Key                        | French Title                      | Activity Description          |
| --------------------------------- | --------------------------------- | ----------------------------- |
| `DailyCheckIn_Bing_Title`         | Série Recherche Bing              | Search on Bing 3 times/day    |
| `DailyCheckIn_DailySet_Title`     | Série quotidienne                 | Complete daily set activities |
| `DailyCheckIn_Edge_Title`         | Série de navigation en périphérie | Browse Edge 30 min/day        |
| `DailyCheckIn_NTP_Title`          | Série d'articles MSN              | Read 3 MSN articles/day       |
| `DailyCheckIn_Outlook_Title`      | Série d'e-mails Outlook           | Read 3 Outlook emails/day     |
| `DailyCheckIn_Sapphire_Title`     | Série d'applications Bing         | Open Bing mobile app daily    |
| `DailyCheckIn_VisualSearch_Title` | Série de recherches visuelles     | Visual search daily           |
| `dailyset_activityTitle`          | Ensemble du jour                  | Complete 3 daily activities   |

### Benefits Feature Keys

```typescript
const BENEFITS = {
    SearchAndEarn: "Gagnez {searchPoints} points par recherche Bing, jusqu'à {points} par jour",
    ExclusiveEarningOffers: 'Offres de gains exclusives',
    GoodUserBonus: 'Bonus Bing Star',
    MonthlyTierBonus: 'Bonus de niveau mensuel',
    DSEBonus: 'Bonus du moteur de recherche par défaut',
    PlayToEarn: 'Jouez et gagnez',
    RedemptionDiscountCoupons: 'Coupons de remise de valeur_échéance'
}
```

---

## Appendix: Telemetry Context

```javascript
window.telemetryContext = {
    instrumentationKey: '94f8d95915164be4bdfaa069859dd53e-...',
    rootTraceId: '...',
    traceId: '...',
    anid: 'DEE005D3B005CCFD4B34F32BFFFFFFFF',
    country: 'fr',
    language: 'fr',
    sessionId: '...'
}
```

### Locale Detection

```css
html[lang="fr"][dir="ltr"]  /* French, left-to-right */
```

### React Aria i18n

```javascript
window[Symbol.for('react-aria.i18n.locale')] /* Locale setting */
```
