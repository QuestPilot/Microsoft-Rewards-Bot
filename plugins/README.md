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

## Built-in Free Plugins

`plugins/run-summary/` is an optional free plugin. It records account results locally in
`diagnostics/run-summary/` and is useful when users want a simple after-run report without enabling
premium Core features or sending extra data to a remote service.

## Third-Party Plugins

A plugin can be a folder with:

- `index.js` or `index.jsc`
- `package.json`
- `README.md`
- optional assets or support files

See these docs for the full contract:

- [Plugin system overview](../docs/plugins.md)
- [Create a plugin](../docs/create-plugin.md)
- [Plugin API reference](../docs/plugin-api.md)
- [Plugin publishing](../docs/plugin-marketplace.md)

You can also run `npm run plugins` from the repository root to open the local Plugin Desk.

## Plugin Safety

If your plugin is paid, proprietary, or license-gated, make that boundary clear in its README and UI.
Never present a plugin license as if it were the bot license.
