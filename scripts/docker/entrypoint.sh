#!/usr/bin/env bash
set -euo pipefail

# Ensure Playwright uses preinstalled browsers
export PLAYWRIGHT_BROWSERS_PATH=0

# 1. Timezone: default to UTC if not provided
: "${TZ:=UTC}"
ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
echo "$TZ" > /etc/timezone
dpkg-reconfigure -f noninteractive tzdata

# 2. Prefer the built-in scheduler when enabled in config.json.
if node -e "const fs=require('fs');const p='/usr/src/microsoft-rewards-bot/dist/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));process.exit(c.scheduler&&c.scheduler.enabled===true?0:1)" 2>/dev/null; then
  echo "[entrypoint] Built-in scheduler enabled in dist/config.json; starting Node scheduler at $(date)"
  exec node dist/index.js
fi

# 3. Validate CRON_SCHEDULE
if [ -z "${CRON_SCHEDULE:-}" ]; then
  echo "ERROR: CRON_SCHEDULE environment variable is not set." >&2
  echo "Please set CRON_SCHEDULE (e.g., \"0 2 * * *\") or enable scheduler.enabled in dist/config.json." >&2
  exit 1
fi

# 4. Initial run without sleep if RUN_ON_START=true
if [ "${RUN_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] Starting initial run in background at $(date)"
  (
    cd /usr/src/microsoft-rewards-bot || {
      echo "[entrypoint-bg] ERROR: Unable to cd to /usr/src/microsoft-rewards-bot" >&2
      exit 1
    }
    # Skip random sleep for initial run, but preserve setting for cron jobs
    SKIP_RANDOM_SLEEP=true scripts/docker/run_daily.sh
    echo "[entrypoint-bg] Initial run completed at $(date)"
  ) &
  echo "[entrypoint] Background process started (PID: $!)"
fi

# 5. Template and register cron file with explicit timezone export
if [ ! -f /etc/cron.d/microsoft-rewards-bot.template ]; then
  echo "ERROR: Cron template /etc/cron.d/microsoft-rewards-bot.template not found." >&2
  exit 1
fi

# Export TZ for envsubst to use
export TZ
envsubst < /etc/cron.d/microsoft-rewards-bot.template > /etc/cron.d/microsoft-rewards-bot
chmod 0644 /etc/cron.d/microsoft-rewards-bot
crontab /etc/cron.d/microsoft-rewards-bot

echo "[entrypoint] Cron configured with schedule: $CRON_SCHEDULE and timezone: $TZ; starting cron at $(date)"

# 6. Start cron in foreground (PID 1)
exec cron -f
