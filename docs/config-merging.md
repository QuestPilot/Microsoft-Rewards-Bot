# Intelligent Configuration Merging System

## Overview

This bot now features an **intelligent configuration merging system** that automatically:
- Creates config/accounts files on first run (from `.example.jsonc` templates)
- Merges new options during updates **without overwriting your customizations**
- Preserves all sensitive data (passwords, API keys, custom settings)

## How It Works

### First-Time Setup
1. Run `npm start`
2. The system automatically:
   - Installs dependencies (`npm install`)
   - Installs Chromium browser
   - Builds the TypeScript project
   - Copies `config.example.jsonc` → `config.jsonc`
   - Copies `accounts.example.jsonc` → `accounts.jsonc`
3. Edit `src/accounts.jsonc` with your Microsoft accounts
4. Run `npm start` again to launch the bot

**No manual file renaming required!**

### Automatic Updates

When you update the bot (via `npm run update` or automatic updates), the system:

#### Smart Merge Process
1. **Detects new options** in `.example.jsonc` files
2. **Preserves all your existing values** (accounts, passwords, custom settings)
3. **Adds only new options** with their default values
4. **Logs what changed** so you know what's new

#### Example Scenario

**Before update** (`config.jsonc`):
```jsonc
{
  "workers": {
    "doDesktopSearch": true,
    "doMobileSearch": true
  },
  "myCustomApiKey": "secret123" // Your custom value
}
```

**New version** (`config.example.jsonc`):
```jsonc
{
  "workers": {
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doDailyCheckIn": true // NEW OPTION
  }
}
```

**After merge** (your `config.jsonc`):
```jsonc
{
  "workers": {
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doDailyCheckIn": true // Added automatically
  },
  "myCustomApiKey": "secret123" // Preserved!
}
```

You'll see:
```
📝 Configuration: Added 1 new option(s): workers.doDailyCheckIn
```

### Configuration Options

In `config.jsonc`, you can control auto-update behavior:

```jsonc
{
  "update": {
    "enabled": true,
    "autoUpdateConfig": true,   // Merge new config options
    "autoUpdateAccounts": true  // Merge new account fields
  }
}
```

**Recommendations:**
- `autoUpdateConfig: true` - Safe, preserves your settings
- `autoUpdateAccounts: true` - Safe, preserves your accounts/passwords

**How merging works:**
- ✅ New options are added with default values
- ✅ Your existing values are preserved
- ✅ Deprecated options are kept (backward compatible)
- ✅ Account passwords and emails are NEVER overwritten

**To disable:**
- Set `autoUpdateConfig: false` to manually review config changes
- Set `autoUpdateAccounts: false` to manually review account schema changes

## Technical Details

### Implementation

- **TypeScript**: [`ConfigMerger.ts`](../src/util/core/ConfigMerger.ts) - Intelligent deep merge algorithm
- **JavaScript**: [`update.mjs`](../scripts/installer/update.mjs) - GitHub update system with merge support
- **Bootstrap**: [`FileBootstrap.ts`](../src/util/core/FileBootstrap.ts) - Initial file creation and merge orchestration

### Merge Algorithm

The system uses a **deep recursive merge** strategy:

1. **Preserve user primitives**: If user has a custom value (string, number, boolean), keep it
2. **Merge objects recursively**: Dive into nested objects to merge field-by-field
3. **Add new fields**: Any field in example but not in user is added
4. **Keep extra fields**: Any field in user but not in example is preserved (backward compatibility)

### Safety Guarantees

- **No data loss**: User values are NEVER overwritten
- **Rollback support**: Update system creates backups before changes
- **Validation**: JSON parsing errors prevent corrupt files
- **Idempotent**: Running merge multiple times produces same result

## Troubleshooting

### "Configuration file error" on startup
- Check `src/config.jsonc` for JSON syntax errors
- Backup your file, delete it, restart to regenerate from example
- Or manually fix the JSON (missing comma, trailing comma, etc.)

### "Missing new options after update"
- Ensure `autoUpdateConfig: true` in your config
- Manually run: `npm run update` to trigger merge
- Check console logs for merge results

### "Lost my custom settings"
- This should never happen! Please report as a bug
- Check backup files in `.update-backup/` directory
- The merge algorithm is designed to preserve ALL user values

## Command Reference

```bash
# Automated all-in-one command
npm start                    # Install deps, build, create configs, run bot

# Development
npm run dev                  # Run with TypeScript directly (no build)
npm run build                # Compile TypeScript only
npm run typecheck            # Check types without building

# Updates
npm run update               # Manual update from GitHub (includes smart merge)

# Dashboard
npm run dashboard            # Launch web dashboard (auto-setup included)
```

## Migration from Old Versions

If you're upgrading from a version **before this feature**, your existing config/accounts files are **automatically preserved**. The system will:
1. Detect existing files
2. Run smart merge to add new options
3. Keep all your existing settings

**No manual action required!**

---

**Questions?** See [Main Documentation](./index.md) or [Troubleshooting Guide](./troubleshooting.md)
