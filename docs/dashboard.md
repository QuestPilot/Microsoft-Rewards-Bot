<div align="center">
  <img src="../assets/banner-core.png" alt="Microsoft Rewards Bot — Core" width="100%">
</div>

---

# Core Dashboard

Navigation: [Documentation index](./README.md) · [Official Core plugin](./core-plugin.md) · [Core technical reference](./core-plugin-reference.md) · [Troubleshooting](./troubleshooting.md)

The web dashboard is an official Core feature. It is not part of the public bot runtime and it does not open a local network port.

When the official Core plugin is enabled and the license is valid, Core starts a private outbound connection to the official dashboard service. Users join the **[QuestPilot Discord](https://discord.gg/JWhCkhSYtg)**, open the `Core Panel` channel, enter their Core license key, then complete Discord OAuth.

## Availability

| Capability | Open source | Official Core |
| --- | --- | --- |
| Local HTTP dashboard | No | No |
| Remote web dashboard | No | Yes |
| License + Discord login | No | Yes |
| Masked account status | No | Yes |
| Recent filtered logs | No | Yes |
| Safe remote actions | No | Yes |
| Safe config overrides | No | Yes |
| Account editor | No | Yes, encrypted to the local bot |
| Background auto-start | No | Yes |

## Security Model

The dashboard service receives only sanitized runtime data:

- masked account emails;
- run state and uptime;
- points summary;
- filtered recent logs;
- selected worker and scheduler summary.

Core must never send Microsoft account passwords, cookies, access tokens, proxy credentials, webhook URLs, or the full local configuration to the dashboard service.

Account and config mutations are sent as signed, verified commands to the local Core bot. The official backend only relays these commands and never stores readable Microsoft account passwords, TOTP secrets, proxy credentials, cookies, or tokens.

## Live Updates

The dashboard is intentionally not a raw WebSocket stream. Core sends three kinds of sanitized updates on adaptive timers:

- lightweight heartbeats keep the device online;
- snapshots refresh run state, account summaries, config summaries, versions, and auto-start status;
- filtered log events append to the live terminal history;
- when the dashboard is open, command polling stays fast enough for interactive control;
- when the dashboard is closed, Core slows down to protect the free backend quotas;
- commands are queued briefly and acknowledged by the bot on its next poll.

Devices remain visible for up to 30 days after they go offline. Offline devices can still be opened to inspect their last known state or deleted from the dashboard cache. Deleting dashboard device data does not revoke the license activation.

## Safe Actions

The dashboard exposes these controls when Core is active and licensed:

- `Run now`: starts a run only when the bot is idle or waiting.
- `Stop safely`: asks a scheduled bot to stop after the current run finishes.
- `Install Auto-Start`: installs a Windows Task Scheduler task or Linux systemd user service.
- `Remove Auto-Start`: removes the OS auto-start entry.
- `Open Console`: opens a visible Windows attach console, shows an attach command on Linux, and shows Docker log guidance in containers.
- `Restart Agent`: asks the local agent to exit so the OS/service manager can restart it.
- `Diagnostics`: returns a sanitized support bundle.
- `Delete Device`: removes dashboard state only.

Safe config overrides are limited to scheduler, headless, workers, run-on-startup, log filters, and background agent settings. The account editor writes `src/accounts.json` locally after the bot decrypts and validates the command.

## Background Agent

Core can run as a background agent:

```bash
npm start -- --background
```

The background agent connects to the dashboard and waits. It does not run rewards by itself unless the built-in scheduler is enabled. To view a local terminal stream for an already running agent:

```bash
npm start -- --attach
```

If a second `npm start` is launched while an agent is already running, the bot reports the existing instance. In an interactive terminal it can close the old instance and continue; in background mode it exits without disturbing the running agent.

## Related Pages

- [Official Core plugin](./core-plugin.md) for purchase and enablement.
- [Core technical reference](./core-plugin-reference.md) for coverage and security boundaries.
- [Troubleshooting](./troubleshooting.md) if a machine does not appear.
