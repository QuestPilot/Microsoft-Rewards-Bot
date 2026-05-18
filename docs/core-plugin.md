# Official Core Plugin

Core is the optional premium plugin for Microsoft Rewards Bot.

The open-source edition already handles the essential workflow. Core adds the maintained premium layer for users who want broader Rewards coverage, more automation, and access to the official web dashboard.

## What Core Adds

| Feature | Open source | Official Core |
| --- | --- | --- |
| Bing searches | Yes | Yes |
| Daily Set | Limited | Full coverage |
| Simple activities and quizzes | Yes | Yes |
| Claimable points cards | No | Yes |
| Daily streak details | No | Yes |
| App rewards | No | Yes |
| Redeem goal automation | No | Yes |
| Temporary quest pages | No | Best effort |
| Official web dashboard | No | Yes |

Core is especially useful when Microsoft changes or expands the newer Rewards dashboard surfaces. The premium plugin is maintained separately so those faster-moving features can keep evolving without making the open-source edition heavier.

## Dashboard

Core includes access to the official remote dashboard.

With it, you can:

- see connected Core devices;
- follow run state and recent activity;
- view masked account summaries;
- start a run remotely when the bot is idle;
- request a safe stop after the current run.

The dashboard is tied to a valid Core license and Discord login.

## What Core Does Not Promise

Microsoft Rewards varies by country, account, available offers, account level, and time. Core is designed to cover more eligible Rewards surfaces, not to guarantee a fixed amount of money every month.

Some dashboard cards are passive progress, external offers, app-only actions, subscriptions, sweepstakes, or redemption offers. Core may detect those items, but not every visible card is a normal web task that can be automated.

## Buy Core

To buy or renew Core access, contact `@lightzirconite` / `683712256243925066` by private Discord message.

Accepted payment methods:

- PayPal
- gift cards accepted by the maintainer

Xbox and PlayStation gift cards are not accepted.

After payment, you receive a license key. Enable the preinstalled Core plugin in `plugins/plugins.jsonc`, start the bot, and enter the key when prompted.

```jsonc
"core": {
  "enabled": true,
  "priority": 100
}
```

## Learn More

For technical behavior, supported surface details, security boundaries, and maintainer notes, read [Core technical reference](./core-plugin-reference.md).
