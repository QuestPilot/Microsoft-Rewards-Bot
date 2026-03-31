# Account Creation Mode

## What it does
Creates new Microsoft accounts and prepares them for Rewards.

## How to use
1. Make sure you accept the risk of new accounts being flagged if used immediately.
2. Run `npm run creator` for prompts, or add `-y` plus a recovery email for faster setup.
3. Let new accounts rest for a few weeks before earning points.

### Use a proxy for creation (recommended)
- One-off CLI flag: `npm run creator -- --proxy=http://user:pass@host:port -y you@example.com "<full referral url>"`
- Or env var (keeps credentials out of shell history): `CREATOR_PROXY_URL=http://user:pass@host:port npm run creator -- -y you@example.com`
- Each run now uses a unique session ID and does not persist fingerprints, so pair this with a residential/ISP proxy per account.

### Anti-detection tips for fresh accounts
- After creation, stay logged in for 2-3 minutes, browse Outlook/OneDrive/Bing manually, then sign out.
- Do not run Rewards immediately; wait 48–72 hours, ideally 5–7 days, before first earn.
- Use a recovery email you control and enable 2FA during creation.
- Keep IP/region/timezone consistent between creation and the first Rewards run.
- Space creations: at least 5–10 minutes between accounts; avoid bursts of many in one day.

## Example
```bash
npm run creator -- -y backup@example.com
```

---
**[← Back to Documentation](index.md)**
