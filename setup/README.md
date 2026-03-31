# Setup Scripts

This folder contains setup and update scripts for the Microsoft Rewards Bot.

## Files

### setup.bat / setup.sh

**First-time installation scripts** for Windows (.bat) and Linux/macOS (.sh).

**What they do:**

1. Check prerequisites (Node.js, npm)
2. Create `accounts.jsonc` from template
3. Guide you through account configuration
4. Install dependencies (`npm install`)
5. Build TypeScript project (`npm run build`)
6. Install Playwright Chromium browser

**Usage:**

```bash
# Windows
.\setup\setup.bat

# Linux/macOS
./setup/setup.sh
```

**Important:** These scripts do NOT start the bot automatically. After setup, run:

```bash
npm start
```

### update/update.mjs

**Automatic update script** that keeps your bot up-to-date with the latest version.

**Features:**

- Uses GitHub API (downloads ZIP - no Git required)
- Preserves your configuration and accounts
- No merge conflicts, always clean
- Automatic dependency installation and rebuild

**Usage:**

```bash
# Run update manually
node scripts/installer/update.mjs
```

**Automatic updates:** The bot checks for updates on startup (controlled by `update.enabled` in config.jsonc).

**Note:** Installer scripts have been moved to `scripts/installer/` directory. See `scripts/README.md` for details.

## Quick Start Guide

### First-time setup:

**Windows:**

```batch
.\setup\setup.bat
```

**Linux/macOS:**

```bash
chmod +x setup/setup.sh
./setup/setup.sh
```

### Daily usage:

```bash
# Start the bot
npm start

# Start with TypeScript (development)
npm run dev

# View dashboard
npm run dashboard
```

### Configuration:

- **Accounts:** Edit `src/accounts.jsonc`
- **Settings:** Edit `src/config.jsonc`
- **Documentation:** See `docs/` folder

## Troubleshooting

### "npm not found"

Install Node.js from https://nodejs.org/ (v20 or newer recommended)

### "Setup failed"

1. Delete `node_modules` folder
2. Delete `package-lock.json` file
3. Run setup again

### "Build failed"

```bash
npm run clean
npm run build
```

### Update issues

If automatic updates fail, manually update:

```bash
git pull origin legacy
npm install
npm run build
```

## Need Help?

- **Documentation:** `docs/index.md`
- **Getting Started:** `docs/getting-started.md`
- **Troubleshooting:** `docs/troubleshooting.md`
- **Discord:** https://discord.gg/k5uHkx9mne
