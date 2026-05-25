# Docker

Navigation: [Documentation index](./README.md) -> [Node.js version](./node-version.md) -> [Official Core plugin](./core-plugin.md) -> [Troubleshooting](./troubleshooting.md)

Docker is supported for the public bot and the official Core plugin on the official image target:

- Debian 12 Bookworm, from `node:24.15.0-slim`
- Node.js `24.15.0`
- Linux `x64`

Core is optional. If you do not have a Core license, disable it in `plugins/plugins.jsonc` or start the container without `LICENSE_KEY`; the public bot still runs.

Docker images do not self-update. At startup, the bot checks GitHub and logs a warning if a newer version exists. Pull or rebuild the image to update.

## Build

From the repository root:

```bash
docker build -t microsoft-rewards-bot .
```

The Dockerfile builds the TypeScript app, installs production dependencies, installs the browser runtime, and copies `plugins/` into the final image.

## Run

Use a mounted config directory if you want to keep accounts, sessions, and diagnostics outside the container:

```bash
docker run --rm \
  -e CRON_SCHEDULE="0 2 * * *" \
  -e RUN_ON_START=true \
  -e TZ=UTC \
  -e LICENSE_KEY="MSRB-XXXX-XXXX-XXXX-XXXX" \
  microsoft-rewards-bot
```

For Core in Docker, `LICENSE_KEY` is the non-interactive license input. Without it, Core disables itself and the bot continues in public mode.

## Compose Example

```yaml
services:
  msrb:
    build: .
    environment:
      CRON_SCHEDULE: "0 2 * * *"
      RUN_ON_START: "true"
      TZ: "UTC"
      LICENSE_KEY: "MSRB-XXXX-XXXX-XXXX-XXXX"
    volumes:
      - ./src/accounts.json:/usr/src/microsoft-rewards-bot/dist/accounts.json:ro
      - ./src/config.json:/usr/src/microsoft-rewards-bot/dist/config.json:ro
      - ./plugins/plugins.jsonc:/usr/src/microsoft-rewards-bot/plugins/plugins.jsonc:ro
      - ./sessions:/usr/src/microsoft-rewards-bot/sessions
    restart: unless-stopped
```

The long-term recommended scheduler is the built-in Node scheduler in `src/config.json`. The cron entrypoint remains supported for existing Docker installs.

## Core Bytecode Compatibility

The official Core plugin is shipped as V8 bytecode through `bytenode`. That bytecode must match the runtime target. The supported Docker target is Node.js `24.15.0` on Linux `x64`.

A `.jsc` built on Windows is not Docker-compatible. A `.jsc` built on Linux is not automatically Windows-compatible. Maintainers must publish a Core artifact built for the Docker target, or move Core to the multi-target layout described in [Core release security](./core-release-security.md).

If Core fails with `Invalid or incompatible cached data (cachedDataRejected)`, the container is not running the Node.js/V8 build that matches the Core bytecode.

If Core fails with `Segmentation fault (core dumped)` during `require('./plugins/core/index.jsc')`, do not add random Debian packages. That failure happens before browser automation starts and usually points to a bytecode/runtime target mismatch or a bytenode/V8 bytecode crash. Use the official Dockerfile target and an official Core release built for Linux `x64`.

## Runtime Packages

The runtime stage installs:

- `cron`, `gettext-base`, `tzdata`, `ca-certificates`
- Chromium headless system libraries required by Patchright
- the app production `node_modules`
- `plugins/`, including `plugins/core`
- `node_modules/microsoft-rewards-bot`, used by Core bytecode imports

Do not remove `plugins/` or `node_modules/microsoft-rewards-bot` from the final image. Core needs both at startup.
