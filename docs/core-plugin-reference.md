# Core Plugin Technical Reference

This page documents how the official Core plugin behaves, what it covers, and how it is published. For the public-facing overview, see [Official Core plugin](./core-plugin.md).

## Distribution Model

The public bot repository is source-available, but the official Core plugin is proprietary and requires a paid license.

Core is preinstalled in `plugins/core`, shipped as compiled bytecode, and trusted only when its checksum matches `plugins/official-core.json`.

## Coverage Model

The public edition focuses on the stable Rewards workflow:

- Bing searches;
- limited Daily Set processing;
- simple URL rewards;
- quizzes.

Core adds the maintained premium layer for newer or faster-changing dashboard surfaces:

- claimable point cards;
- app rewards;
- streak details;
- streak protection sync;
- redeem goal automation;
- best-effort handling for temporary quest and punchcard pages under `/earn/quest/...`;
- advanced side-panel automation;
- the official remote dashboard.

## Dashboard Card Categories

Not every card shown on the Microsoft Rewards dashboard is a direct point task.

| Card type | Typical behavior |
| --- | --- |
| Standard web activity | Can often be completed directly |
| Search-triggered activity | May require an eligible Bing query |
| Temporary quest / punchcard | Best effort when the page follows a supported pattern |
| Passive progress card | Tracked by Microsoft account state |
| App-only or install task | Reported or skipped |
| Subscription, redeem, or sweepstakes offer | Reported or skipped |

Examples of passive or external items include level-up streaks, default-search progress, installing Edge, installing an extension, using the Bing or Xbox app, redeeming points, subscribing to Game Pass, or entering a sweepstakes.

## Temporary Punchcards

Temporary punchcards are campaign-specific. Core handles the common supported pattern when possible:

1. open the quest page;
2. activate the punchcard if Microsoft exposes an activation action;
3. complete supported `bing.com/search` or simple URL steps;
4. leave redeem, install, subscription, app-only, and time-gated steps as external.

This lets Core support recurring campaign structures without hardcoding every short-lived promotion.

## Dashboard Behavior

Core includes the official remote dashboard and background agent. It starts after a successful license check and opens only an outbound connection to the official dashboard service. It does not expose a local HTTP server or bind to the user's local network.

Users sign in on the official dashboard domain with:

1. their Core license key;
2. Discord OAuth.

The dashboard shows masked account status, run state, recent filtered logs, point summaries, version/update state, auto-start status, diagnostics, and allowlisted actions such as starting a run when the bot is idle.

Dashboard commands are queued and acknowledged asynchronously, so a short delay after an action is expected. Live state is Redis-first: heartbeats, snapshots, logs, and command state stay in Redis with TTLs to protect Turso quota. Turso is used for license/auth state and durable audit records for mutations.

Devices remain visible after going offline so users can inspect the last known state. Deleting a device from the dashboard removes live dashboard state only and does not revoke the license activation.

Sensitive account/config mutations use encrypted command payloads. The dashboard encrypts for the selected device, Redis transports the encrypted payload, and the local bot decrypts and validates before writing local files.

Maintainers can override the service URL for custom deployments:

```jsonc
"core": {
  "enabled": true,
  "priority": 100,
  "config": {
    "dashboardUrl": "https://bot.lgtw.tf"
  }
}
```

## License Validation

Core validates licenses against the official backend. The release build contains the private runtime configuration required for the official service; users do not need to configure database access locally.

The public repository includes only examples for local maintainer tooling. Real private configuration must never be committed.

## Security Boundary

The public plugin API cannot grant official Core entitlement and cannot register premium Core tasks. Only the signed official Core bytecode can unlock those paths in the official release.

Because the source-available repository is modifiable, a local copy can remove local limits from its own files. The license does not permit public redistribution of those changes when they bypass, unlock, replace, emulate, or reproduce Core. The protected value is the maintained signed Core release, its license checks, and the premium automation that is not shipped as source.

## Release Checklist

Before copying a new Core build into the public repo:

- verify that no database token, API token, private key, or local `.env` value is committed;
- revoke any token that was ever shipped in bytecode or source;
- run `npx tsc --noEmit` and `npm audit --audit-level=moderate` in both repositories;
- rebuild Core using Node.js `24.15.0`;
- copy only bytecode, package, and license artifacts;
- verify that `plugins/official-core.json` matches `plugins/core/index.jsc`;
- run the checks in [Dashboard testing](./dashboard-testing.md).
