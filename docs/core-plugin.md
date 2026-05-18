# Official Core Plugin

The bot is open source, but the official Core plugin is proprietary and requires a paid license. Core is preinstalled in `plugins/core`, loaded from bytecode, and trusted only when its checksum matches `plugins/official-core.json`.

## Open Source vs Core

| Feature | Open source | Official Core |
| --- | --- | --- |
| Bing searches | Yes | Yes |
| Daily Set | Limited to 2 quests per day | Unlimited |
| Simple URL rewards and quizzes | Yes | Yes |
| Temporary punchcards and quest pages | No | Best effort |
| Passive level-up cards | Tracked by Microsoft account state | Tracked by Microsoft account state |
| External install, sweepstakes, or subscription offers | Not automated | Reported when detected |
| Public plugin API | Yes | Yes |
| Web dashboard | No | Yes |
| Claim points cards | No | Yes |
| Daily streak details | No | Yes |
| Streak protection sync | Forced off when accessible | Forced on when accessible |
| App rewards | No | Yes |
| Redeem goal automation | No | Yes |
| Advanced side-panel automation | No | Yes |

## Rewards Coverage

The open-source bot focuses on the stable Rewards workflow: Bing searches, Daily Set activities, simple URL rewards, and quizzes. It can still skip activities when Microsoft marks them as locked, passive, external, or unavailable for the account region.

Core adds the maintained premium layer for newer dashboard surfaces. This includes claimable point cards, app rewards, streak details, redeem goal automation, and best-effort handling for temporary quest or punchcard pages under `/earn/quest/...`.

Not every card shown on the Microsoft Rewards dashboard is a direct point task. Some cards are account-state progress, such as level-up streaks or default-search progress. Others are external offers, such as installing Edge, installing an extension, using the Bing/Xbox app, redeeming points, subscribing to Game Pass, or entering a sweepstakes. Core may detect and report those cards, but it does not claim them as normal web activities unless Microsoft exposes a supported Rewards action for the signed-in account.

Temporary punchcards are campaign-specific. Core should handle the common pattern when possible:

- open the quest page;
- activate the punchcard if Microsoft exposes an activation action;
- complete supported `bing.com/search` or simple URL steps;
- leave redeem, install, subscription, app-only, or time-gated steps as external.

This keeps the open-source edition simple while allowing Core to evolve with Microsoft dashboard changes without exposing the private automation layer.

## Value Expectations

Core is designed to cover more eligible Rewards surfaces, not to promise a fixed cash return. Microsoft Rewards point values, redemption options, search caps, dashboard cards, and regional availability can change by country, account level, device, subscription status, and time.

For that reason, the project should avoid fixed earnings claims such as “earn X dollars per month”. A clearer promise is:

- open source handles the stable baseline workflow;
- Core handles the advanced and fast-changing dashboard surfaces when they are eligible for the account;
- passive, external, app-only, install, subscription, sweepstakes, and redeem/spend-points cards are detected or skipped rather than counted as guaranteed earnings.

## Core Dashboard

Core includes the official remote dashboard. It starts automatically after a successful license check and opens only an outbound connection to the official dashboard service. It does not expose a local HTTP server and it does not bind to `localhost` or the user's local network.

Users sign in on the official dashboard domain with:

1. their Core license key;
2. Discord OAuth.

The dashboard shows masked account status, run state, recent filtered logs, point summaries, and safe actions such as starting a run when the bot is idle. Dashboard commands are queued and acknowledged asynchronously, so a small delay after clicking an action is expected. It does not allow full account or configuration editing.

Normal users do not need to configure this. Maintainers can override the dashboard service URL for custom deployments:

```jsonc
"core": {
  "enabled": true,
  "priority": 100,
  "config": {
    "dashboardUrl": "https://bot.lgtw.tf"
  }
}
```

## License And Payment

To buy or renew Core access, contact `@lightzirconite`/`683712256243925066` by private Discord message.

Accepted payment methods for v1:

- PayPal
- gift cards accepted by the maintainer

Xbox and PlayStation gift cards are not accepted.

After payment, you receive a license key. Enable the preinstalled Core plugin in `plugins/plugins.jsonc` and start the bot.

Core validates licenses against the official Turso license database. The official release already includes the required private runtime configuration; only override it if you are running a custom backend or database.

Example:

```jsonc
"core": {
  "enabled": true,
  "priority": 100
}
```

The files `plugins/core/license-admin.html`, `plugins/core/license-admin-server.js`, and `plugins/core/license-admin.config.example.js` are the local License Desk shipped from the private Core source release. The example config contains no secret; the real `license-admin.config.local.js` is for the private maintainer workspace and is ignored in the public bot repository.

## Protection Boundary

The public plugin API cannot grant official Core entitlement and cannot register premium Core tasks. Only the signed official Core bytecode can unlock those paths in the official release.

Because the open-source repository is modifiable, a fork can remove local limits from its own copy. The project does not pretend otherwise. The protected value is the maintained, signed Core release, its license checks, and the advanced dashboard automation that is not shipped as source.

## Before Publishing Core

Before copying a new Core build into the open-source repo:

- verify no database token, API token, private key, or local `.env` value is committed;
- revoke any token that was ever shipped in bytecode or source;
- run `npx tsc --noEmit` and `npm audit --audit-level=moderate` in both repositories;
- rebuild Core release and copy only bytecode/package/license artifacts;
- rebuild Core using Node.js 24.15.0;
- verify `plugins/official-core.json` matches `plugins/core/index.jsc`;
- run the dashboard checks in [Dashboard testing](./dashboard-testing.md).
