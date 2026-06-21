# Removing legacy (ASP.NET) dashboard support

> Maintainer note. The bot supports **both** Microsoft Rewards dashboards in one
> codebase: the new **Next.js** dashboard and the old **legacy ASP.NET** one. The
> variant is detected per account at login (Next.js first, else legacy) and drives
> which code path runs. The legacy side is deliberately isolated so it can be
> deleted in **one localized pass** the day Microsoft finishes migrating everyone.
>
> Keep this file in sync whenever you add legacy-specific code: anything that only
> exists to serve the legacy dashboard must be listed here.

## How the seam works (so you know what's safe to delete)

- Reads are shared: `PageController.getDashboardData()` normalizes **both**
  dashboards into the same `DashboardData` shape. This is NOT legacy-specific —
  keep it.
- Writes go through the variant seam: tasks call `bot.dashboard.reportActivity(...)`
  / `reportQuizOnce(...)`. The active strategy is chosen by
  `DashboardActionsFactory.getDashboardActions(bot)` from `bot.dashboardVariant`.
- No task file branches on the variant. Deleting legacy therefore never touches a
  task file — only the isolated legacy modules and the single switch.

## Deletion checklist

### Public bot (`Microsoft-Rewards-Bot/`)

1. Delete the folder `src/automation/dashboard/legacy/` (`LegacyDashboardActions.ts`).
2. `src/automation/dashboard/DashboardActionsFactory.ts`: remove the
   `LegacyDashboardActions` import and the legacy branch — collapse to
   `return new NextDashboardActions(bot)`.
3. `src/automation/auth/AuthManager.ts` → `getRewardsSession()`: remove the
   `__RequestVerificationToken` extraction, the `dashboardMode === 'legacy'`
   handling and the legacy fallback. Keep only the Next.js detection (or simplify
   the method away entirely).
4. `src/index.ts`: remove the `requestToken` field (and its only writer in
   AuthManager); collapse `dashboardVariant` to a constant `'next'` (or remove
   `dashboardVariantByDevice` / `setDashboardVariant` and the `DashboardVariant`
   import). Keep `resetDashboardState()` (it also resets the shared
   `dashboardApiUnavailable` memo); `userData.timezoneOffset` is legacy-only and
   can be removed.
5. `src/types/Account.ts`: remove `dashboardMode`. `src/helpers/SchemaValidator.ts`:
   remove `dashboardMode` from `AccountSchema`.
6. `src/types/Dashboard.ts`: remove `DashboardVariant` (or collapse to `'next'`).
7. `src/automation/DashboardSelectors.ts`: remove `URLS.reportActivity` (the legacy
   report endpoint) once nothing references it.
8. Optional — classic punch cards are legacy-only (the Next.js dashboard has none,
   so `TaskBase.doPunchCards` is already a no-op there). You may keep it (harmless)
   or remove `doPunchCards` from `TaskBase`, the call in `index.ts::Main`, and the
   `doPunchCards` flag in `types/Config.ts` + `helpers/SchemaValidator.ts` +
   `config.json` + `config.example.json`.

The seam itself (`bot.dashboard`, the `DashboardActions` interface and
`NextDashboardActions`) can stay — it is variant-agnostic and leaves no legacy
residue. Inlining it back into the tasks is optional.

### Core plugin (`Core-Source/`)

1. Delete the folder `src/tasks/legacy/` (`LegacyClaimPoints.ts`,
   `LegacyDailyStreak.ts`, `LegacyDashboardInfo.ts`).
2. `src/index.ts`: remove the three `Legacy*` imports and, in each dispatch
   closure, delete the `if (bot.dashboardVariant === 'legacy') { ... }` branch
   (claim points, daily streak, dashboard info, streak-protection sync) and the
   legacy no-op guards (apply coupons, set goal, temporary punchcards). Each
   closure reverts to its plain Next.js implementation.

### Verify after removal

```bash
# bot
cd Microsoft-Rewards-Bot && npm run build && npm test
# core (build the bot dist first; never concurrently)
cd ../Core-Source && npm run build && npm test
```

Then `grep -ri "legacy\|requestToken\|dashboardVariant\|reportactivity\|claimallpoints\|togglestreak" src` in both repos should return nothing dashboard-related.
