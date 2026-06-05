# Dashboard Testing

Microsoft Rewards changes often. Use these checks when the dashboard starts failing, after refreshing files in `Page/`, or before publishing a release.

## 1. Analyze Saved Pages

Save the current Rewards pages in `Page/`, including the generated asset folders, then run:

```powershell
npm run analyze:pages
```

Look at `problems` first. Useful signals:

- `reportActivity server action id not found in saved HTML/chunks`: the saved page did not expose the server action id, or Microsoft moved it.
- `Daily Set models found, but no Daily Set activity has both offerId and hash`: Daily Set extraction is unsafe.
- `pointsclaim model found, but no side-panel signal was found`: claim-point UI may need a live test.
- `streak models found, but no disclosure trigger was found`: the progression panel structure changed.

The analyzer should classify Rewards dashboard pages as `rewards-next` and Bing quiz/search pages as `bing-search`.

## 2. Run Mocked Side-Panel Tests

These tests do not use a Microsoft account. They load a small local HTML page that mimics the Rewards side panel and run the real side-panel controller against it.

```powershell
npm run test:dashboard:mock
```

This covers:

- opening the progress disclosure;
- opening the streak side panel;
- switching protection from off to on;
- switching protection from on to off;
- disabled switch handling without a crash.

Run this whenever `RewardsSidePanelController` or streak protection behavior changes.

## 3. Run Live Dashboard Diagnostics

Live diagnostics are intentionally opt-in. They open a visible browser and reuse:

```text
sessions/dashboard-live-diagnostics
```

First run:

```powershell
$env:MSRB_LIVE_DASHBOARD = "1"
npm run diagnostics:dashboard:live
```

If the browser asks for login, sign in manually, close it, then run the same command again.

By default this is read-only. It opens the dashboard, inspects RSC models, detects sections, attempts to open the streak panel, and prints a JSON report.

If the report shows `welcomePage: true`, Microsoft redirected the session to `/welcome` instead of the real dashboard. Run the interactive mode, finish the welcome/onboarding page in the opened browser, and wait for the command to retry:

```powershell
$env:MSRB_LIVE_DASHBOARD = "1"
$env:MSRB_LIVE_DASHBOARD_INTERACTIVE = "1"
npm run diagnostics:dashboard:live
```

Only enable writes when you explicitly want to test the streak protection toggle:

```powershell
$env:MSRB_LIVE_DASHBOARD = "1"
$env:MSRB_LIVE_DASHBOARD_WRITE = "1"
npm run diagnostics:dashboard:live
```

When write mode is enabled, the script tries to set the first visible streak-protection switch to ON.

## Release Checklist

Before release:

```powershell
npm run analyze:pages
npm test
npm run test:dashboard:mock
npx tsc --noEmit
npm audit --audit-level=moderate
```

If Core was rebuilt, also run `npm run core:release-check`.
