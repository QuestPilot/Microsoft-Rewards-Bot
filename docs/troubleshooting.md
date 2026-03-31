# Troubleshooting

## What it does

Quick fixes for common problems.

## Common Issues

### ❌ "Failed to load accounts: accounts file not found"

**Symptom**: After updating from a very old version, the bot can't find your accounts file.

**Cause**: In older versions (pre-v3.0), account files could be stored in `dist/accounts.json` or at the root. Newer versions require files in `src/accounts.jsonc` or `src/accounts.json`.

**Fix**:

1. **Automatic Migration** (v3.61.5+): The bot now automatically migrates legacy files to `src/` during updates and startup.

2. **Manual Migration** (if automatic fails):

   ```bash
   # Check if you have an old accounts file
   dir accounts.json    # Windows
   ls accounts.json     # Linux/Mac

   # Or in dist/
   dir dist\accounts.json   # Windows
   ls dist/accounts.json    # Linux/Mac

   # If found, copy it to src/
   copy accounts.json src\accounts.json          # Windows
   cp accounts.json src/accounts.json            # Linux/Mac

   # Or from dist/
   copy dist\accounts.json src\accounts.json     # Windows
   cp dist/accounts.json src/accounts.json       # Linux/Mac
   ```

3. **Verify Migration**:

   ```bash
   # Check that file exists in src/
   dir src\accounts.json    # Windows
   ls src/accounts.json     # Linux/Mac
   ```

4. **Restart the bot**: `npm start`

**Prevention**: Keep your bot updated regularly to avoid major migration issues.

---

### 🔄 "Activities not found yet" - Infinite Retry Loop

**Symptom**: Bot keeps retrying forever with messages like:

```
[DESKTOP] [GO-HOME] Activities not found yet (iteration 1/5), retrying...
[DESKTOP] [GO-HOME] On correct URL but activities missing - forcing page reload
[DESKTOP] [GO-HOME] [ACTIVITY] Element not found after 5000ms
```

**Cause**: The bot tries 5 times to find activities on the Microsoft Rewards page but never succeeds. Possible reasons:

1. **Region/Account Type**: Your account region has no activities available today
2. **Page Structure Changed**: Microsoft updated the Rewards page HTML (selectors outdated)
3. **Network Issues**: Slow connection prevents page from fully loading
4. **Account Restriction**: Account may be flagged or temporarily restricted
5. **Browser Issues**: Headless detection or anti-bot measures

**Fix**:

1. **Manual Verification** (FIRST STEP):

   ```bash
   # Stop the bot if running (Ctrl+C)

   # Try with visible browser to see what's happening
   # Edit src/config.jsonc:
   "browser": {
     "headless": false  // Changed from true
   }

   # Run bot
   npm start
   ```

   Watch what happens in the browser. Do activities show up manually?

2. **Check Account Status**:
   - Open https://rewards.microsoft.com/ in a real browser
   - Log in with your account
   - Verify activities are visible
   - Check if account shows any warning/suspension messages

3. **Regional Issues**:
   - Some regions have limited or no daily activities
   - Check Microsoft Rewards availability in your region
   - Consider using accounts from supported regions (US, UK, etc.)

4. **Update Selectors** (If page structure changed):

   ```bash
   # Update to latest version
   npm start  # Auto-updates if enabled

   # Or manually
   git pull origin main
   npm install
   npm run build
   ```

5. **Network/Timing Fix**:

   ```jsonc
   // In src/config.jsonc, increase timeouts:
   "browser": {
     "globalTimeout": "60s"  // Increased from default 30s
   }
   ```

6. **Try Different Browser Engine**:
   The bot uses Chromium by default. Sometimes changing the rendered helps:
   - Reinstall browser: `npx playwright install chromium --force`

7. **Clear Browser State**:

   ```bash
   # Delete sessions folder
   rm -rf sessions/     # Linux/Mac
   rmdir /s sessions    # Windows

   # Bot will re-login fresh
   npm start
   ```

8. **Wait and Retry**:
   - Sometimes Microsoft temporarily blocks automation
   - Wait 24 hours and try again
   - Use `humanization.randomOffDaysPerWeek` to appear more natural

**Prevention**:

- Enable humanization to reduce detection:
  ```jsonc
  "humanization": {
    "enabled": true,
    "randomOffDaysPerWeek": 2
  }
  ```
- Run at random times, not same time every day
- Use scheduling with "randomMinuteOffset" to vary execution time
- Don't run too frequently (once per day is recommended)

**Version Note**: v3.61.5+ will now properly fail after 5 attempts instead of retrying forever, making this issue more visible and debuggable.

---

### ⚠️ Build Failures

## How to use

- If a run fails, rerun with `npm start` after closing all browser windows.
- If builds fail, delete `node_modules` and `dist`, then run `npm install` followed by `npm run build`.
- Ensure `DISCORD_WEBHOOK_URL` is set if you expect alerts.
- Check that `accounts.jsonc` has valid emails and passwords.

## Example

```bash
npx rimraf node_modules dist
npm install
npm run build
npm start
```

---

**[← Back to Documentation](index.md)**
