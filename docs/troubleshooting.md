<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Troubleshooting

Navigation: [Documentation index](./README.md) · [Install & auto-updates](./updates.md) · [Node.js version](./node-version.md) · [Plugin system overview](./plugins.md)

## Auto-Update Fails

The bot logs the update error and continues with the local version when GitHub is unavailable.

The updater resolves `main` to an exact commit SHA, reads `package.json` at that SHA, and
downloads or fetches that same commit. GitHub Releases and signing keys are not required
for Bot auto-updates.

Use:

```bash
npm run update:check
npm run update:repair
npm run update:doctor
```

Docker never applies updates inside the container. If Docker logs that an update is available, pull or rebuild the image.

If another terminal started an update at the same time, the updater waits on `.updates/update.lock`. If the lock is still active after the wait window, the bot continues with the local version instead of mutating a half-updated tree. Stale locks from crashed update processes are removed automatically.

Use `npm run update:repair` when the installed files look inconsistent but the local `package.json` version already matches the remote `main` version. Repair mode re-applies the current `main` commit while preserving `src/config.json`, `src/accounts.json`, `plugins/plugins.jsonc`, sessions, logs, diagnostics, and custom plugin folders.

Installations still running the earlier signed-release updater may display
`Latest GitHub release is missing its signed update manifest`. That updater cannot update
itself from `main`; update or reinstall manually once to version 4.5.1 or newer.

After a successful update or repair, the launcher automatically restarts once, rebuilds
`dist/`, and starts the new version. A second update check is skipped during this
one-shot restart to prevent a loop.

## App Window Or Terminal

The bot starts in app window mode by default. The default user config contains:

```jsonc
"terminal": {
  "enabled": false
}
```

`npm start` opens the visual app window. Use this for normal, non-technical runs. If support asks for detailed logs, run:

```bash
npm start -- --terminal
```

The interface can accept a Core license prompt or an empty response, but developer diagnostics are still easier in terminal mode. On systems launched from an existing terminal, the launcher detaches the app process and returns the prompt; it does not forcibly close a terminal window that the user opened manually.

Docker, CI, and forced-headless launches stay in terminal mode automatically. Use `MSRB_NO_APP_WINDOW=1` if a desktop machine should also skip the app window.

The Desk window can fall back to an installed Chrome, Chromium, or Edge browser. Automation runs are stricter: they always use Patchright's bundled Chromium so behavior is consistent across Windows, Linux, and macOS.

The launcher checks for Patchright Chromium before opening Rewards Desk and installs it
automatically when it is missing. If that automatic repair is interrupted or fails, run:

```console
npm run browser:install
```

The bot no longer silently runs automation in the user's installed Chrome or Edge. Tracked automation browser processes are closed during normal completion, interruption signals, and fatal-error shutdown paths.

Rewards Desk opens its local window before loading the OS account vault and compiled Core licensing client. Those services finish in background processes so a slow DPAPI/Keychain/Secret Service response or Core bytecode startup does not freeze the Settings interface.

On Windows, Rewards Desk and the Core agent now use the current user's Startup folder and do not require administrator rights. When migrating an older protected Task Scheduler entry, Windows may show one UAC prompt solely to remove that legacy task.

## Development Version Gets Replaced

Use `npm run dev` or pass `-dev`. Auto-update is skipped in development mode.

## Npm Start Stops After The Update Check

Use the latest `main` branch. Older 4.0.1 builds could stop after `Already up to date` when the Windows installer terminal did not expose `npm` correctly to the nested launcher. The launcher now uses npm's own executable path and prints a clear `[START]` error if a child process cannot start.

## Sessions Are Lost After Build

Sessions are stored in the root `sessions/` folder and are not modified by `npm run build`.

## Config Or Accounts File Is Missing

Run `npm start`. Before building, the launcher creates a missing `src/config.json` from
`src/config.example.json`. It creates `src/accounts.json` from
`src/accounts.example.json` only when neither `accounts.json` nor
`accounts.enc.json` exists. Existing user files are never replaced.

## Core Plugin Does Not Load

Check that `core` is `enabled` in `plugins/plugins.jsonc` (or toggle it from the **Plugins** page in Rewards Desk).

Activating a valid license from Rewards Desk now enables this flag automatically. Choosing **Continue without Core** disables it and suppresses future startup prompts until Core is activated again from the Desk.

The bot logs whether the Core bytecode checksum matches `plugins/official-core.json` at startup — look for a Core entitlement line in the console. If the checksum doesn't match, premium entitlement is not granted and Core stays inactive.

For Docker, confirm that the final image contains:

- `plugins/core/index.js`
- the matching `plugins/core/targets/<target>/index.jsc`
- `plugins/official-core.json`
- `node_modules/microsoft-rewards-bot`

Then check the runtime target:

```bash
node -p "process.versions.node + ' ' + process.platform + '/' + process.arch"
```

Core in Docker is supported on Node.js `24.15.0` with Linux `x64`. If Core fails before browser startup, use the official Dockerfile target and an official Core release built for the Docker target.

## Core Dashboard Does Not Show A Machine

The web dashboard is a Core-only feature. Check that `plugins/plugins.jsonc` enables Core and that the license prompt succeeds.

If Core is active but the machine is still absent, check whether the dashboard service URL is reachable from the machine. The official release uses the default service; custom deployments can set `core.config.dashboardUrl`.

The public bot no longer starts a local dashboard server.

## Rewards Dashboard Automation Stops Working

Run the integrated Rewards harvester. It captures the live Microsoft Rewards pages and
validates selectors, RSC/flight data, route inventories, fingerprints, and screenshots in
one pass (using the first enabled account, without touching your sessions, statistics, or
configuration), then prints the full analysis in the terminal:

```bash
npm start -- harvester
```

If it reports missing required selectors, RSC data, or unknown activity models, Microsoft
likely changed the dashboard payload. This is normally fixed in a bot update, so make
sure you are on the latest version.

## Advanced Environment Variables

Most people never need these. They are optional and off by default.

- `MSRB_AUTOREPORT_RELAY=1` — opt in to sending anonymous error and feedback reports through the project's relay instead of directly to your own webhook. Default: off (reports go directly to your own configured webhook).
- `MSRB_CORE_TARGET` — auto-detected for your system. You normally never set this yourself.

## Related Pages

- [Install & auto-updates](./updates.md)
- [Docker](./docker.md)
- [Node.js version](./node-version.md)
- [Plugin system overview](./plugins.md)
- [Official Core plugin](./core-plugin.md)
