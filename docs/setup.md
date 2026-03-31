# Setup

Get the bot ready before your first run.

## Prerequisites

- **Node.js 20 or newer** - [Download here](https://nodejs.org/)
- **Git** (optional) - For cloning the repository

## Installation

```bash
# Clone the repository (Legacy branch for old dashboard)
git clone -b legacy https://github.com/LightZirconite/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot

# For V4 (new dashboard), use:
# git clone -b v4 https://github.com/LightZirconite/Microsoft-Rewards-Bot.git

# Install dependencies (happens automatically on first run)
npm install
```

## Account Configuration

1. Copy the example file:

   ```bash
   cp src/accounts.example.jsonc src/accounts.jsonc
   ```

2. Edit src/accounts.jsonc with your Microsoft account(s):

```jsonc
[
  {
    "email": "your-email@outlook.com",
    "password": "your-password",
  },
  {
    "email": "second-account@outlook.com",
    "password": "another-password",
    "totp": "YOUR_2FA_SECRET", // Optional: for accounts with 2FA
  },
]
```

## Optional: 2FA Support

If your account has two-factor authentication enabled, add the TOTP secret:

- Extract the secret from your authenticator app setup QR code
- Add it as the totp field in your account entry

## Optional: Proxy Support

For accounts that need a proxy:

```jsonc
{
  "email": "account@outlook.com",
  "password": "password",
  "proxy": "http://user:pass@proxy.example.com:8080",
}
```

## Optional: Discord Notifications

Set up Discord webhook alerts:

```bash
# Windows
set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Linux/Mac
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Or configure in src/config.jsonc:

```jsonc
{
  "webhook": {
    "enabled": true,
    "url": "https://discord.com/api/webhooks/...",
  },
}
```

## Verify Setup

Run the bot once to verify everything works:

```bash
npm start
```

---

**[Back to Documentation](index.md)**
