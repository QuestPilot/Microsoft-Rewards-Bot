<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Built-in Scheduler

The built-in scheduler lets the bot run immediately, finish all configured accounts, then wait inside the same process until the next daily run time. It works on Windows, macOS, Linux, and Docker without cron, systemd, Task Scheduler, or any third-party service.

With Core enabled, the scheduler can run inside the background agent. In that mode the machine stays visible in the Core dashboard, waits silently between runs, and can still receive dashboard commands.

## Configuration

Add or update this block in `src/config.json`:

```json
"scheduler": {
  "enabled": true,
  "runOnStartup": true,
  "timezone": "Europe/Paris",
  "startTime": "08:00",
  "randomDelay": {
    "min": "0min",
    "max": "30min"
  }
}
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Enables the scheduler loop. |
| `runOnStartup` | `true` | Runs once as soon as the bot starts, then waits for the next scheduled time. |
| `timezone` | `Europe/Paris` | Time zone used to calculate the daily start time. |
| `startTime` | `08:00` | Daily target time in `HH:mm` format. |
| `randomDelay.min` | `0min` | Minimum extra delay after `startTime`. |
| `randomDelay.max` | `30min` | Maximum extra delay after `startTime`. |

With the example above, the bot runs immediately when launched. After it finishes, it schedules the next run for 08:00 Paris time plus a random delay between 0 and 30 minutes.

## Docker Notes

For Docker, keep the container running. The scheduler is inside the Node.js process, so restarting the container also restarts the scheduler state.

If you change `src/config.json` or `src/accounts.json`, restart the bot so the new settings are loaded.

## Core Background Agent

Core adds a dashboard-managed background mode:

```bash
npm start -- --background
```

On Windows, the dashboard can install a user Task Scheduler entry that starts this command at logon. On Linux, it can install a `systemd --user` service. Docker does not install auto-start entries; use the container restart policy instead.

If `scheduler.enabled` is false, the background agent stays connected but does not run rewards until a dashboard command asks it to run. If `scheduler.enabled` is true, the scheduler controls when runs start.
