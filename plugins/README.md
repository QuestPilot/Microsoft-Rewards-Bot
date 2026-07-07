# Plugins Directory

This folder contains the built-in official Core plugin and any third-party plugins.

## Activation

The bot reads `plugins/plugins.jsonc` at startup.

- `enabled: true` loads a plugin
- `enabled: false` keeps a plugin installed but inactive
- `priority` controls load order
- each plugin can receive its own `config` object

When `plugins/plugins.jsonc` exists, only the plugins listed there are eligible to load.

## Built-in Core Plugin

`plugins/core/` contains the proprietary Core plugin that ships with the bot.
It is shipped as a compiled official artifact and loaded through the same plugin manager as third-party plugins.
Its checksum is pinned in `plugins/official-core.json`; if it does not match, premium entitlement is not granted.

## Free and Community Plugins

The bot ships with only the official Core plugin. Every other plugin is installed from the
cloud marketplace — see [Publishing a plugin](../docs/plugin-marketplace.md). Declare it in
`plugins.jsonc` with `"source": "marketplace"` and the bot downloads, verifies, and sandboxes it
on the next start.

## Third-Party Plugins

A plugin can be a folder with:

- `index.js` or `index.jsc`
- `plugin.json` — optional manifest declaring `permissions` and a `settings` schema (the Desk renders a settings form from it)
- `package.json`
- `README.md`
- optional assets or support files

Beyond logging, selectors, diagnostics, and notifications, a plugin can use `ctx.settings`
(user-editable settings), `ctx.storage` (a scoped key/value store), `ctx.ui.panel(...)` (a
read-only panel on the Plugins page), and — with a declared + user-approved `net:<host>`
permission — `ctx.fetch(...)`. A complete example is in
[`../docs/examples/earnings-estimator/`](../docs/examples/earnings-estimator/).

See these docs for the full contract:

- [Plugin system overview](../docs/plugins.md)
- [Create a plugin](../docs/create-plugin.md)
- [Plugin API reference](../docs/plugin-api.md)
- [Publishing a plugin](../docs/plugin-marketplace.md)

To enable or disable plugins visually, open **Rewards Desk** (`npm start`) and go to the **Plugins** page — it edits `plugins/plugins.jsonc` for you.

## Plugin Safety

If your plugin is paid, proprietary, or license-gated, make that boundary clear in its README and UI.
Never present a plugin license as if it were the bot license.
