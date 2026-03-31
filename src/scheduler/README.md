# Internal Scheduler

## Overview

The **Internal Scheduler** is a cross-platform scheduling system built into the bot. It automatically runs the bot daily at a specified time - **no external cron setup required, no Task Scheduler configuration needed**.

## Features

✅ **Simple time format** - Just specify "09:00" for 9 AM  
✅ **Automatic timezone detection** - Uses your computer/server timezone automatically  
✅ **Cross-platform** - Works on Windows, Linux, and macOS  
✅ **Zero external configuration** - No cron or Task Scheduler setup required  
✅ **Overlap protection** - Prevents concurrent runs  
✅ **Automatic retry** - Retries failed runs with exponential backoff  
✅ **Clean shutdown** - Gracefully stops on CTRL+C or SIGTERM

## Quick Start

### 1. Enable Scheduling

Edit `src/config.jsonc`:

```jsonc
{
  "scheduling": {
    "enabled": true,
    "time": "09:00"  // Daily at 9:00 AM (your local time)
  }
}
```

### 2. Run the Bot

```bash
npm start
```

The bot will:
- Start the internal scheduler
- Detect your timezone automatically
- Keep the process alive
- Execute automatically daily at the specified time
- Log each scheduled run

### 3. Stop the Bot

Press **CTRL+C** to stop the scheduler and exit cleanly.

## Time Format Examples

| Time | Description |
|------|-------------|
| `"09:00"` | Daily at 9:00 AM |
| `"21:30"` | Daily at 9:30 PM |
| `"00:00"` | Daily at midnight |
| `"12:00"` | Daily at noon |
| `"06:15"` | Daily at 6:15 AM |

**Note:** Always use 24-hour format (HH:MM). The scheduler automatically uses your system's timezone.

## Configuration Options

### `scheduling.enabled`
- **Type:** `boolean`
- **Default:** `false`
- **Description:** Enable/disable automatic scheduling

### `scheduling.time`
- **Type:** `string`
- **Format:** `"HH:MM"` (24-hour format)
- **Default:** `"09:00"`
- **Description:** Daily execution time in your local timezone
- **Examples:** `"09:00"`, `"21:30"`, `"00:00"`

### Legacy `scheduling.cron.schedule` (deprecated)
- **Type:** `string` (cron expression)
- **Description:** Advanced cron format (e.g., `"0 9 * * *"`)
- **Note:** Supported for backwards compatibility. Use `time` instead for simplicity.

## Timezone Detection

The scheduler **automatically detects your timezone** using your computer/server's system settings:

- **Windows:** Uses Windows timezone settings
- **Linux/Mac:** Uses system timezone (usually from `/etc/localtime`)
- **Docker:** Uses container timezone (set via `TZ` environment variable)

**You don't need to configure timezone manually!** The bot logs the detected timezone on startup:

```
✓ Internal scheduler started
  Daily run time: 09:00
  Timezone: America/New_York
  Next run: Thu, Jan 18, 2024, 09:00 AM
```

## How It Works

1. **Initialization**
   - Bot reads `config.scheduling`
   - Detects your timezone automatically
   - Creates scheduler for daily execution
   - Validates time format

2. **Execution**
   - Scheduler waits until next scheduled time
   - Triggers bot execution (`initialize()` + `run()`)
   - Logs start/completion/errors
   - Calculates next run time

3. **Error Handling**
   - Failed runs are retried (using `config.crashRecovery` settings)
   - Overlap protection prevents concurrent runs
   - Errors are logged but don't stop the scheduler

4. **Shutdown**
   - SIGINT/SIGTERM signals stop the scheduler
   - Current task completes before exit
   - Cleanup handlers run normally

## Advantages Over OS Schedulers

| Feature | Internal Scheduler | OS Scheduler |
|---------|-------------------|--------------|
| Setup complexity | ✅ Simple | ❌ Manual config |
| Time format | ✅ Simple (09:00) | ❌ Complex cron |
| Windows support | ✅ Auto | ❌ Task Scheduler setup |
| Linux support | ✅ Auto | ⚠️ crontab config |
| Timezone handling | ✅ Automatic | ❌ Manual |
| Centralized logs | ✅ Yes | ❌ Separate logs |
| Dashboard integration | ✅ Possible | ❌ No |
| Process management | ⚠️ Must stay alive | ✅ Cron handles |

## Docker Users

Docker users can **continue using cron** if preferred (see `docker/` directory). The internal scheduler is **optional** and doesn't interfere with Docker cron setup.

**Docker Timezone Setup:**
```yaml
# docker/compose.yaml
environment:
  - TZ=America/New_York  # Set your timezone
  - RUN_ON_START=true
```

## Troubleshooting

### Scheduler doesn't start
- Check `scheduling.enabled` is `true`
- Verify `time` is in HH:MM format (e.g., `"09:00"`)
- Look for errors in console output

### Wrong timezone detected
- Check your system timezone settings
- For Docker, set `TZ` environment variable
- Verify in logs: "Timezone: YOUR_TIMEZONE"

### Runs don't trigger at expected time
- Verify time format is 24-hour (e.g., `"21:00"` not `"9:00 PM"`)
- Check system clock is correct
- Wait for the next scheduled time (check logs for "Next run")

### Process exits unexpectedly
- Check `jobState.autoResetOnComplete` is `true` (for scheduled runs)
- Review crash logs
- Ensure no SIGTERM/SIGINT signals from system

## Advanced: Cron Format (Legacy)

For users who need complex schedules (e.g., multiple times per day, specific weekdays), you can use the legacy cron format:

```jsonc
{
  "scheduling": {
    "enabled": true,
    "cron": {
      "schedule": "0 9,21 * * *"  // Daily at 9 AM and 9 PM
    }
  }
}
```

**Cron Expression Examples:**

| Schedule | Cron Expression | Description |
|----------|----------------|-------------|
| Every day at 9 AM | `0 9 * * *` | Once daily |
| Every 6 hours | `0 */6 * * *` | 4 times a day |
| Twice daily (9 AM, 9 PM) | `0 9,21 * * *` | Morning & evening |
| Weekdays at 8 AM | `0 8 * * 1-5` | Monday-Friday only |
| Every 30 minutes | `*/30 * * * *` | 48 times a day |

**Note:** Use [crontab.guru](https://crontab.guru) to create and validate cron expressions.

## API Reference

### `InternalScheduler.start()`
Starts the scheduler. Returns `true` if successful.

### `InternalScheduler.stop()`
Stops the scheduler gracefully.

### `InternalScheduler.isActive()`
Returns `true` if scheduler is running.

### `InternalScheduler.getStatus()`
Returns scheduler status object:
```typescript
{
  active: boolean
  isRunning: boolean
  lastRun: string | null
  nextRun: string
}
```

### `InternalScheduler.triggerNow()`
Manually trigger an immediate run (useful for dashboard).

## Related Files

- **Implementation:** `src/scheduler/InternalScheduler.ts`
- **Integration:** `src/index.ts` (main function)
- **Config:** `src/config.jsonc`
- **Interface:** `src/interface/Config.ts` (ConfigScheduling)

## Example: Complete Setup

```jsonc
// src/config.jsonc
{
  "scheduling": {
    "enabled": true,
    "time": "09:00"  // Daily at 9 AM (automatic timezone)
  },
  "jobState": {
    "enabled": true,
    "autoResetOnComplete": true  // Reset state after each scheduled run
  },
  "crashRecovery": {
    "enabled": true,
    "maxRetries": 3  // Retry failed runs up to 3 times
  }
}
```

Then run:
```bash
npm start
```

You'll see:
```
✓ Internal scheduler started
  Daily run time: 09:00
  Timezone: America/New_York
  Next run: Thu, Jan 18, 2024, 09:00 AM
Bot is ready and waiting for scheduled execution...
```
