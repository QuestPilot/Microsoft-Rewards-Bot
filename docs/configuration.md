# Configuration

## What it does
Controls how the bot behaves through `src/config.jsonc`.

## How to use
- Open `src/config.jsonc` and edit only the fields you need.
- Keep `humanization.enabled` true to mimic real usage.
- Adjust `workers` to enable or disable search, quizzes, and promotions.
- Set `scheduling.enabled` to automate runs.

## Example
```jsonc
{
  "humanization": { "enabled": true },
  "workers": {
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doDailySet": true
  },
  "scheduling": { "enabled": false }
}
```

---
**[← Back to Documentation](index.md)**
