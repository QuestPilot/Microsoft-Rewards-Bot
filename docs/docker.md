# Docker

## What it does
Runs the bot in a container with bundled scheduling and browser setup.

## How to use
- Ensure `src/accounts.jsonc` and `src/config.jsonc` are present before starting.
- Run `npm run docker:compose` to build and start the container.
- View logs with `docker logs -f microsoft-rewards-bot` or the compose service name.

## Example
```bash
npm run docker:compose
```

---
**[← Back to Documentation](index.md)**
