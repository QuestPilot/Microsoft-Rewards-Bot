# Troubleshooting

## Auto-Update Fails

The bot logs the update error and continues with the local version when the network or manifest is unavailable. It refuses to apply an update if the archive checksum is invalid.

If a 4.0.0 install reports `Manifest signature missing` or `Manifest signature is invalid`, update once with the installer or by pulling the `release` branch manually. The original 4.0.0 updater required a private signing key that is no longer available, so it cannot accept the new public manifest by itself. After 4.0.1 is installed, future public updates use the GitHub manifest plus archive SHA-256 verification.

Use:

```bash
npm run update:check
```

## Development Version Gets Replaced

Use `npm run dev` or pass `-dev`. Auto-update is skipped in development mode.

## Npm Start Stops After The Update Check

Use the latest `release` branch. Older 4.0.1 builds could stop after `Already up to date` when the Windows installer terminal did not expose `npm` correctly to the nested launcher. The launcher now uses npm's own executable path and prints a clear `[START]` error if a child process cannot start.

## Sessions Are Lost After Build

Sessions are stored in the root `sessions/` folder. If an older build saved them under `dist/automation/sessions`, `src/automation/sessions`, `dist/browser/sessions`, or `src/browser/sessions`, `npm run build` migrates missing files into the root session folder before clearing `dist`.

## Core Plugin Does Not Load

Check `plugins/plugins.jsonc` and run:

```bash
npm run plugins
```

The Plugin Desk shows whether the Core checksum matches `plugins/official-core.json`.

## Core Dashboard Does Not Show A Machine

The web dashboard is a Core-only feature. Check that `plugins/plugins.jsonc` enables Core and that the license prompt succeeds.

If Core is active but the machine is still absent, check whether the dashboard service URL is reachable from the machine. The official release uses the default service; custom deployments can set `core.config.dashboardUrl`.

The open-source bot no longer starts a local dashboard server.

## Rewards Dashboard Automation Stops Working

Run the page analyzer against saved Microsoft Rewards captures:

```bash
npm run analyze:pages
```

If it reports missing RSC data, missing `reportActivity`, or unknown activity models, Microsoft likely changed the dashboard payload or server action wiring.

For dashboard-specific checks, use [Dashboard testing](./dashboard-testing.md). Start with `npm run analyze:pages`, then run `npm run test:dashboard:mock` if side panels or streak protection changed.
