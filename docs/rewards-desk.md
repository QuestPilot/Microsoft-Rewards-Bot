# Rewards Desk

Navigation: [Documentation index](./README.md) → [Install and auto-updates](./updates.md) → [Plugin system overview](./plugins.md)

**Rewards Desk** is the local control panel for the bot. It opens automatically in its own window when you run `npm start` on a normal desktop — no browser tab, no separate command. Everything you need day to day is here.

> The Desk runs entirely on your machine (`127.0.0.1`). It never exposes a public server. On headless setups and inside Docker it doesn't open at all — the bot just runs in the terminal.

---

## Pages

| Page | What it's for |
| --- | --- |
| **Dashboard** | Start or stop a run, watch live progress, points, and Core status. |
| **Accounts** | Add, edit, enable, or disable Microsoft accounts. Credentials stay on your machine. |
| **Console** | The live bot log. Scroll up freely — it only auto-follows when you're at the bottom. Copy the log with one click. |
| **Settings** | Toggle tasks, notifications, headless mode, the scheduler, and Core features. Free open-source tasks and premium Core tasks are clearly separated. |
| **Plugins** | See every plugin from `plugins/plugins.jsonc` and toggle them on or off. Links to the guide for building your own. |
| **Core** | Before activation: what Core adds. After activation: an estimate of the extra points Core is earning you. |
| **Docs** | This documentation, rendered straight from the bot's `docs/` folder — the same files you're reading on GitHub. |

## Activating Core

If you have a Core license, click **Activate Core** (sidebar, or the prompt on first launch), paste your `MSRB-XXXX-XXXX-XXXX-XXXX` key, and the Desk validates it online and stores it encrypted on this machine. The bot then picks it up automatically on every run — no need to re-enter it. See [Official Core plugin](./core-plugin.md) for what activation unlocks.

## Account encryption and backups

On desktop systems, Rewards Desk automatically encrypts account credentials with AES-256-GCM. The encryption key is protected by Windows DPAPI, macOS Keychain, or Linux Secret Service. Account edits are written atomically and re-encrypted with a fresh nonce.

The **Disable encryption** action remains visible in Settings → Advanced. It requires confirmation with the current local OS username, writes a verified plaintext `accounts.json`, and only then removes the encrypted file.

## Install desktop shortcuts

Click **Install Rewards Desk** near the bottom of the sidebar to create or repair native launchers:

- Windows: Desktop and Start menu shortcuts with the Rewards Desk icon.
- Linux: Desktop and application-menu `.desktop` entries.
- macOS: a `Rewards Desk.app` launcher in the current user's Applications folder.

The launcher keeps a terminal visible while update checks and the local TypeScript build run. The terminal closes automatically after Rewards Desk starts, or stays open when startup fails so the error can be read.

Taskbar and Dock pinning remains a user action. Windows intentionally restricts automatic taskbar pinning for ordinary unpackaged applications; Rewards Desk opens the installed shortcut's location so it can be pinned normally.

Use **Settings → Advanced → Account protection** to disable encryption, rotate the local key, or create a portable password-protected backup. Portable backups can be imported on another computer and are then re-encrypted with that computer's OS vault. If Linux Secret Service is unavailable, the Desk keeps `src/accounts.json` in plaintext and displays a warning instead of risking inaccessible credentials.

## Developer / terminal mode

Prefer raw terminal logs? **Settings → Developer mode → Run in terminal** sets `terminal.enabled` in your config, closes the Desk window, and relaunches the bot in a terminal. You can also force it any time with:

```bash
npm start -- --terminal
```

Set `terminal.enabled` back to `false` (or remove `--terminal`) to bring the Desk back.

## Related pages

- [Install and auto-updates](./updates.md)
- [Plugin system overview](./plugins.md)
- [Official Core plugin](./core-plugin.md)
- [Troubleshooting](./troubleshooting.md)
