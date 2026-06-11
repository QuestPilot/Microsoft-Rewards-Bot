# Official Core Plugin

Navigation: [Documentation index](./README.md) -> [Plugin system overview](./plugins.md) -> [Core technical reference](./core-plugin-reference.md) -> [Core Dashboard](./dashboard.md)

Core is the paid, proprietary plugin for Microsoft Rewards Bot. The open-source bot handles the essential workflow; Core adds the polished automation, dashboard, background mode, and run summaries for users who want the bot to feel simple instead of technical.

## Why Core

Core is built for users who want:

- broader Rewards coverage when Microsoft changes dashboard surfaces;
- automatic handling for ready-to-claim points and dashboard coupons;
- a remote dashboard to monitor machines, runs, accounts, versions, and logs;
- Windows/Linux background startup without keeping a terminal open;
- safe remote actions such as run now, stop safely, open console, and restart agent;
- simpler status and summaries for people who do not want to read terminal logs.

Core is especially useful for desktop users who do not want to understand terminals. Once configured, the bot can start silently with the computer, appear in the dashboard, and wait for scheduler runs or manual dashboard commands.

The public bot also includes an app window mode, enabled by default with `terminal.enabled` set to `false` in `src/config.json`. Keep terminal mode enabled only when you need detailed support logs.

## Open Source vs Core

| Capability | Open source | Official Core |
| --- | --- | --- |
| Bing searches | Yes | Yes |
| Daily Set | Limited | Full maintained coverage |
| Simple activities and quizzes | Yes | Yes |
| Claimable point cards | No | Yes |
| Dashboard coupons | No | Yes |
| Daily streak details | No | Yes |
| Streak protection sync | No | Yes |
| App rewards | No | Yes |
| Temporary quest pages | No | Best effort |
| Final webhook summary with Core impact | Basic run logs | Yes, includes Core points and coupon impact |
| Remote dashboard | No | Yes |
| Background agent | No | Yes |
| Dashboard account editor | No | Yes, encrypted to the local bot |
| Docker Core support | No | Yes, Linux x64 Node.js `24.15.0` |

## Remote Dashboard

Core includes the official remote dashboard. The bot opens an outbound connection to the dashboard service; it does not expose a local web server on the user's network.

From the dashboard, users can:

- see every connected Core device;
- keep offline devices visible for up to 30 days;
- inspect the last known state of a machine after it shuts down;
- follow filtered live logs;
- see app version, Core version, platform, Docker status, and update warnings;
- run the bot remotely when idle;
- stop safely after the current account;
- install or remove Windows/Linux auto-start;
- open or attach to a visible console;
- apply safe config overrides;
- edit local accounts through encrypted commands;
- request a sanitized diagnostics bundle.

The dashboard is tied to a valid Core license and Discord login. After buying Core, join the Discord and open the `Core Panel` channel to access the panel, connect your license, and manage your devices.

## Rewards Coverage

Core can inspect the newer Rewards dashboard surfaces that are not part of the stable public workflow:

- claim ready-to-claim point cards when the card shows a value greater than zero;
- open the Coupons panel when `Coupon (N)` shows one or more available coupons;
- apply each visible coupon that still needs action;
- recognize coupons that already show `Applied`;
- log coupon title, expiry, and estimated point discount;
- add Core impact lines to the optional final Discord/Ntfy run summary.

Enable the relevant workers in `src/config.json`:

```jsonc
"workers": {
  "doClaimPoints": true,
  "doApplyCoupons": true
},
"webhook": {
  "runSummary": {
    "enabled": true,
    "discordUrl": "https://discord.com/api/webhooks/...",
    "includeCoreComparison": true
  }
}
```

The final Discord summary uses its own `webhook.runSummary.discordUrl`; the normal `webhook.discord` destination remains dedicated to filtered console logs. The summary is sent as a structured embed with per-account results, total balance changes, runtime, coupon names when available, and an optional Core impact comparison. The existing ntfy destination can still receive the text recap.

## Background Agent

Core can run as a quiet background agent:

```bash
npm start -- --background
```

The agent connects to the dashboard and waits. It does not start a rewards run by itself unless the built-in scheduler is enabled. This keeps the machine visible while avoiding unnecessary work.

Users who want to see the terminal can attach to the running instance:

```bash
npm start -- --attach
```

On Windows, the dashboard can open a visible console for the running agent. On Linux, it shows the attach command. In Docker, users should use `docker logs -f <container>`.

## Auto-Start

Core can install auto-start from the dashboard:

- Windows: current-user Startup folder entry.
- Linux: `systemd --user` service.
- macOS: current-user LaunchAgent.
- Docker: no local mutation; use the container restart policy.

If another bot instance is already running, a new interactive `npm start` reports it and can close the old instance before continuing. Background launches simply exit and leave the running agent untouched.

## Security Model

Core sends only sanitized live state to the dashboard:

- masked account emails;
- run state, uptime, versions, platform, and auto-start status;
- filtered recent logs;
- scheduler and worker summaries;
- point summaries and supported diagnostics.

Core must never send Microsoft account passwords, cookies, access tokens, proxy credentials, webhook URLs, or the full local config in readable form.

Account edits and safe config overrides are encrypted in the browser for the selected device. Redis and Core-API transport the command but cannot read the secret payload. The local bot decrypts, validates, writes local files, and reports only masked state back to the dashboard.

## What Core Does Not Promise

Microsoft Rewards varies by country, account, available offers, account level, and time. Core improves coverage and maintenance, but it does not guarantee a fixed monthly value.

Some dashboard cards are passive progress, external offers, app-only actions, subscriptions, sweepstakes, redeem pages, or time-gated campaigns. Core may detect or report those cards, but not every visible item is a normal automatable web task.

## Buy Core

To buy or renew Core access, contact `@lightzirconite` / `683712256243925066` by private Discord message.

Accepted payment methods:

- PayPal
- gift cards accepted by the maintainer

Xbox and PlayStation gift cards are not accepted.

After payment, you receive a license key. Join the Discord, open the `Core Panel` channel, and follow the panel instructions. Then enable the preinstalled Core plugin in `plugins/plugins.jsonc`, start the bot, and enter the key when prompted.

```jsonc
"core": {
  "enabled": true,
  "priority": 100
}
```

For Docker, set `LICENSE_KEY` in the container environment so Core can validate the license without an interactive prompt.

## Learn More

- [Core Dashboard](./dashboard.md) explains the remote dashboard and background agent.
- [Core technical reference](./core-plugin-reference.md) documents coverage, security boundaries, and release rules.
- [Docker](./docker.md) documents the supported Core Docker target.
- [Node.js version](./node-version.md) explains why Core requires an exact Node.js version.
