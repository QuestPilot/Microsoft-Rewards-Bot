# Core Dashboard

The web dashboard is an official Core feature. It is not part of the open-source runtime and it does not open a local network port.

When the official Core plugin is enabled and the license is valid, Core starts a private outbound connection to the official dashboard service. Users open the dashboard from the official domain, enter their Core license key, then complete Discord OAuth.

## Availability

| Capability | Open source | Official Core |
| --- | --- | --- |
| Local HTTP dashboard | No | No |
| Remote web dashboard | No | Yes |
| License + Discord login | No | Yes |
| Masked account status | No | Yes |
| Recent filtered logs | No | Yes |
| Safe remote actions | No | Yes |
| Full config editing | No | No |

## Security Model

The dashboard service receives only sanitized runtime data:

- masked account emails;
- run state and uptime;
- points summary;
- filtered recent logs;
- selected worker and scheduler summary.

Core must never send Microsoft account passwords, cookies, access tokens, proxy credentials, webhook URLs, or the full local configuration to the dashboard service.

The first release only supports safe commands such as starting a run when the bot is idle. Full remote configuration editing is intentionally not supported.

## Live Updates

The dashboard is intentionally not a raw WebSocket stream. Core sends sanitized snapshots on an adaptive timer:

- when the dashboard is open, updates arrive every few seconds;
- when the dashboard is closed, Core slows down to protect the free backend quotas;
- commands are queued briefly and acknowledged by the bot on its next poll.

After clicking an action, the interface shows a notification and then waits for the bot acknowledgement. A short delay is normal and helps prevent Redis, Turso, and Vercel from being spammed by repeated polling.

## Safe Actions

V1 exposes only safe controls:

- `Run now`: starts a run only when the bot is idle or waiting.
- `Stop safely`: asks a scheduled bot to stop after the current run finishes.

The dashboard does not edit accounts, passwords, cookies, proxy settings, tokens, or the full local config.
