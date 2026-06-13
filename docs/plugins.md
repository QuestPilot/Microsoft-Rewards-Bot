<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Plugin System Overview

Navigation: [Documentation index](./README.md) -> [Create a plugin](./create-plugin.md) -> [Plugin API reference](./plugin-api.md) -> [Official Core plugin](./core-plugin.md)

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

## Built-in Free Plugins

The source-available public release can ship optional free plugins beside Core. These plugins are normal public plugins, so users can inspect them, disable them, modify them privately, or use them as examples.

| Plugin | Default | Purpose |
| --- | --- | --- |
| `run-summary` | Disabled | Writes local account result summaries to `diagnostics/run-summary/` after each account finishes. |
| `run-health` | Disabled | Tracks repeated failures, zero-point completions, and account duration using masked local history. |
| `session-health` | Disabled | Reports missing, empty, or stale directories under the official `sessions/` path without reading cookies. |

Enable one in `plugins/plugins.jsonc` or from the **Plugins** page in Rewards Desk.

### Example Activation

```jsonc
{
  "run-summary": {
    "enabled": true,
    "priority": 10,
    "config": {
      "includeEmails": false,
      "writeMarkdown": true
    }
  }
}
```

These plugins write or inspect local diagnostics only. They do not send account data to a remote service.

## Managing Plugins

Open **Rewards Desk** (it launches automatically on `npm start`) and go to the **Plugins** page. There you can:

- see every plugin listed in `plugins/plugins.jsonc`
- toggle each plugin on or off (the change is written straight back to `plugins.jsonc`)
- spot the official Core plugin and whether your license unlocks it
- jump to the guide for building your own plugin

You can also edit `plugins/plugins.jsonc` by hand if you prefer. The bot still verifies the Core bytecode checksum against `plugins/official-core.json` and any catalog checksums in `plugins/catalog.json` at startup.

## How to Learn More

- Read the [Plugin API reference](./plugin-api.md) for exact interfaces and lifecycle hooks.
- Read [Create a plugin](./create-plugin.md) for a small end-to-end example.
- Read [Plugin publishing](./plugin-marketplace.md) if you want to distribute a plugin.
- Read [Official Core plugin](./core-plugin.md) to understand how the paid Core plugin differs from public plugins.
