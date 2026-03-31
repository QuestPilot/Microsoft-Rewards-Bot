# Notifications

## What it does
Sends run summaries and issues to your preferred webhook.

## How to use
- Set `DISCORD_WEBHOOK_URL` in your environment for Discord alerts.
- Keep `humanization.enabled` true to avoid unsafe behavior in production.
- Start the bot normally; alerts send automatically when configured.

## Example
```bash
set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... 
npm start
```

---
**[← Back to Documentation](index.md)**
