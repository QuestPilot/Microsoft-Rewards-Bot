# Microsoft Rewards Bot v4.0.1

Microsoft Rewards Bot v4.0.1 is now available on the `release` branch.

This update focuses on reliability, safer operation, and a smoother setup for both open-source users and Core plugin users.

## What's New

- Added an optional local web dashboard for the open-source bot.
- Added scheduler support so the bot can run now, wait, and restart at the configured daily time.
- Added a remote safety advisory check that can warn users when running the bot is considered risky.
- Added a warning when more than four accounts are configured.
- Added a Core License Desk for local license management, including create, edit, disable, delete, notes, plan, expiration, and machine limits.
- Rebuilt and refreshed the official Core plugin bytecode.

## Fixes And Improvements

- Chrome is now preferred before Edge when choosing a browser channel.
- Session files are kept outside the rebuilt `dist` folder so logins are not wiped by each start/build cycle.
- Microsoft login handling was improved for password/passkey interruption screens.
- Dashboard data fallback handling was improved.
- Auto-update documentation and preserved-file behavior were clarified.
- Core license documentation now explains that runtime validation calls the official license API, while the backend checks the Turso database and returns a signed response.

## Notes

- The open-source bot still works without the Core plugin.
- Core requires a valid license and a configured license response public key.
- `updates/stable.json` was not changed in this commit because update manifests must be signed with the private Ed25519 update key.
