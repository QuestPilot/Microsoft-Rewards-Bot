# Troubleshooting

Navigation: [Documentation index](./README.md) -> [Install and auto-updates](./updates.md) -> [Node.js version](./node-version.md) -> [Plugin system overview](./plugins.md)

## Auto-Update Fails

The bot logs the update error and continues with the local version when GitHub is unavailable.

The updater reads the `release` branch, compares `package.json`, and downloads the immutable tarball for that exact commit. It no longer uses `updates/stable.json` or signed manifests.

Use:

```bash
npm run update:check
npm run update:doctor
```

Docker never applies updates inside the container. If Docker logs that an update is available, pull or rebuild the image.

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

For Docker, confirm that the final image contains:

- `plugins/core/index.jsc`
- `plugins/official-core.json`
- `node_modules/microsoft-rewards-bot`

Then check the runtime target:

```bash
node -p "process.versions.node + ' ' + process.platform + '/' + process.arch"
```

Core in Docker is supported on Node.js `24.15.0` with Linux `x64`. A `cachedDataRejected` error means the bytecode does not match the Node.js/V8 runtime. A segmentation fault during `require('./plugins/core/index.jsc')` happens before browser startup; adding browser or GTK packages is not the fix. Use the official Dockerfile and a Core release built for the Docker target.

## Core Dashboard Does Not Show A Machine

The web dashboard is a Core-only feature. Check that `plugins/plugins.jsonc` enables Core and that the license prompt succeeds.

If Core is active but the machine is still absent, check whether the dashboard service URL is reachable from the machine. The official release uses the default service; custom deployments can set `core.config.dashboardUrl`.

The public bot no longer starts a local dashboard server.

## Rewards Dashboard Automation Stops Working

Run the page analyzer against saved Microsoft Rewards captures:

```bash
npm run analyze:pages
```

If it reports missing RSC data, missing `reportActivity`, or unknown activity models, Microsoft likely changed the dashboard payload or server action wiring.

For dashboard-specific checks, use [Dashboard testing](./dashboard-testing.md). Start with `npm run analyze:pages`, then run `npm run test:dashboard:mock` if side panels or streak protection changed.

## Related Pages

- [Install and auto-updates](./updates.md)
- [Docker](./docker.md)
- [Node.js version](./node-version.md)
- [Plugin system overview](./plugins.md)
- [Official Core plugin](./core-plugin.md)
