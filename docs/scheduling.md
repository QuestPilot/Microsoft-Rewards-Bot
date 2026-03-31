# Scheduling

## What it does
Runs the bot automatically at set times.

## How to use
- Turn on scheduling in `src/config.jsonc` under `scheduling.enabled`.
- Choose a time using the cron or Task Scheduler fields already in the config.
- Leave the machine or container running so the schedule can trigger.
- Check the console after start: it prints the next run time. If you close the window or stop the container, the scheduler stops.
- Serverless hosts (e.g., Vercel) will not keep the scheduler alive; run on a machine or container that stays on. Use Vercel only for the API endpoints (like error reporting), not for scheduled runs.

## Example
```jsonc
{
  "scheduling": {
    "enabled": true,
    "cron": { "schedule": "0 9 * * *" }
  }
}
```

---
**[← Back to Documentation](index.md)**
