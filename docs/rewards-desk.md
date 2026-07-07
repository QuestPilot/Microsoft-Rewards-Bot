<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Rewards Desk

Navigation: [Documentation index](./README.md) · [Install & auto-updates](./updates.md) · [Plugin system overview](./plugins.md)

**Rewards Desk** is the friendly control panel for the bot. It opens automatically in its own window when you run `npm start` on a normal desktop — there's no browser tab to find and no extra command to remember. Almost everything you do day to day happens here.

> Rewards Desk runs entirely on your own computer. It does not open a public server or put anything on the internet. On headless machines and inside Docker it doesn't open at all — the bot simply runs in the terminal instead.

---

## Opening the Desk

Just run:

```bash
npm start
```

The Desk window opens on its own once the bot is ready. The first time you start, you may briefly see a terminal window while the bot checks for updates and prepares itself; that's normal, and it goes away once the Desk appears.

---

## Pages

| Page | What it's for |
| --- | --- |
| **Dashboard** | Start or stop a run, and watch live progress, points, and Core status. |
| **Accounts** | Add, edit, enable, or disable your Microsoft accounts. Your sign-in details stay on your computer. |
| **Console** | The live bot log. Scroll up freely — it only auto-follows when you're at the bottom. Copy the whole log with one click. |
| **Settings** | Turn tasks, notifications, headless mode, the scheduler, and Core features on or off. Free open-source tasks and premium Core tasks are clearly separated. |
| **Plugins** | See, enable/disable, install, and **remove** plugins — including from the community **marketplace** (verified + sandboxed). Open a plugin's **Settings** to change its options and see its panel, approve its **network access** per host (with a warning), grant **Trusted Mode**, **report** a bad one, **Publish** your own on the developer site, or open the build guide. |
| **Core** | Before activation: what the premium Core plugin adds. After activation: an estimate of the extra points Core is earning you. |
| **Docs** | This documentation, shown right inside the app — the same pages you're reading here. |

## Activating Core

If you have a Core license, click **Activate Core** (in the sidebar, or from the prompt on first launch), paste your `MSRB-XXXX-XXXX-XXXX-XXXX` key, and the Desk checks it online and saves it safely on this computer. The same Core window is used everywhere in Rewards Desk — there's no separate license dialog to hunt for.

A successful activation automatically turns on the official Core plugin for you (even if you previously chose **Continue without Core**). Choosing **Continue without Core** turns the plugin off so later runs start straight in free open-source mode without asking again. Once a license is activated, the bot picks it up automatically on every run — you never have to re-enter it. See [Official Core plugin](./core-plugin.md) for what activation unlocks.

## Your accounts stay safe on your computer

On desktop computers, Rewards Desk automatically encrypts your account passwords and keeps them safely on your own device — they never leave your computer. You don't have to set anything up; it just works in the background.

If you ever need to, **Settings → Advanced → Account protection** lets you turn encryption off, rotate the local key, or make a portable password-protected backup. A portable backup can be moved to another computer and is automatically re-secured there. Turning encryption off asks you to confirm with your computer's username first, so it can't happen by accident.

## Sending feedback

Found a bug or have a suggestion? Use the in-app feedback option to send a short report straight from the Desk — no need to copy logs by hand or open anything else. Reports are anonymous and, by default, go to your own configured webhook. (If you'd rather route reports through the project's shared relay instead, see the advanced note in [Troubleshooting](./troubleshooting.md).)

## Install desktop shortcuts

Click **Install Rewards Desk** near the bottom of the sidebar to create native launchers:

- Windows: Desktop and Start menu shortcuts with the Rewards Desk icon.
- Linux: Desktop and application-menu entries.
- macOS: a `Rewards Desk.app` launcher in your Applications folder.

The launcher keeps a small terminal visible while update checks and the local build run, then closes it once the Desk is open. If startup fails, the terminal stays open so you can read the error.

Once the shortcuts exist, the install button hides itself. The Desk re-checks the shortcut files at startup and every 30 seconds, so if you delete a shortcut by hand, the install button simply reappears. You can remove the shortcuts any time from **Settings → Advanced**.

> Rewards Desk uses a runtime workspace folder (`.core/`) for its own generated launch and build files. It holds no account data and no Core license — you can safely ignore it.

## Prefer a plain terminal?

If you'd rather watch raw terminal logs, go to **Settings → Developer mode → Run in terminal**. That closes the Desk window and relaunches the bot in a terminal. You can also force it any time with:

```bash
npm start -- --terminal
```

Set it back to off (or drop the `--terminal` flag) to bring the Desk window back.

## Related pages

- [Install & auto-updates](./updates.md)
- [Plugin system overview](./plugins.md)
- [Official Core plugin](./core-plugin.md)
- [Troubleshooting](./troubleshooting.md)
