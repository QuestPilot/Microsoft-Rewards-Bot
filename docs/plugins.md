# Plugin System Overview

The bot loads plugins from the `plugins/` directory at startup.

When `plugins/plugins.jsonc` exists, it decides which plugins are active:

- `enabled: true` loads the plugin
- `enabled: false` keeps the plugin installed but inactive
- higher `priority` values load first
- each entry can pass a plugin-specific `config` object

The built-in Core plugin lives in `plugins/core/` and is distributed as a proprietary compiled package. Third-party plugins can live beside it and use the same loader, but they use a separate public API.

## What a Plugin Can Do

- register public selector groups
- provide diagnostics
- receive account lifecycle events
- read its own config
- provide non-premium extension points such as diagnostics and notifications

Public plugins cannot register official premium Core tasks or unlock premium entitlements.

The official web dashboard is also outside the public plugin contract. It is started by the verified Core bytecode only and is not available to third-party plugins.

## Managing Plugins

Run:

```bash
npm run plugins
```

The local Plugin Desk edits `plugins/plugins.jsonc`, verifies checksums against `plugins/catalog.json`, and shows the Core manifest status.

## How to Learn More

- Read the [Plugin API reference](./plugin-api.md) for exact interfaces and lifecycle hooks.
- Read [Create a plugin](./create-plugin.md) for a small end-to-end example.
