# Scripts Directory

This directory contains automation scripts for the Microsoft Rewards Bot.

## Available Scripts

### `installer/`
**Purpose:** Automated setup and update scripts  
**Description:** Contains Node.js scripts for initial setup and GitHub-based updates.

#### `installer/setup.mjs`
**Purpose:** Initial project setup automation  
**Usage:** `npm run setup` or `node scripts/installer/setup.mjs`  
**Description:** Automates initial project configuration, dependency installation, and first-time setup.

#### `installer/update.mjs`
**Purpose:** GitHub ZIP-based auto-updater  
**Usage:** `node scripts/installer/update.mjs`  
**Description:** Downloads and applies updates from GitHub without Git. Preserves user configuration files (`accounts.jsonc`, `config.jsonc`, `sessions/`).

**Features:**
- No Git required
- No merge conflicts
- Selective file preservation
- Automatic rollback on failure
- Dependency installation
- TypeScript rebuild

---

For Docker deployment, see the `docker/` directory.  
For shell scripts (setup.bat, setup.sh, run.sh), see the `setup/` directory.
