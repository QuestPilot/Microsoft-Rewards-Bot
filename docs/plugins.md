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
- `source: "marketplace"` marks a plugin installed from the marketplace — it is verified against the signed catalog and runs **sandboxed** (a V8 isolate with no Node APIs)
- `trust: "sandbox"` isolates a local plugin too; `trust: "full"` (**Trusted Mode**) runs it in-process with full access — an explicit, local opt-in for plugins that genuinely need it

The built-in Core plugin lives in `plugins/core/` and is distributed as a proprietary compiled package. Third-party plugins can live beside it and use the same loader, but they use a separate public API.

## What a Plugin Can Do

- register public selector groups
- provide diagnostics
- receive account lifecycle events
- read its own config
- provide non-premium extension points such as diagnostics and notifications

Public plugins cannot register official premium Core tasks or unlock premium entitlements.

The official web dashboard is also outside the public plugin contract. It is started by the verified Core bytecode only and is not available to third-party plugins.

## Free and Community Plugins

The bot ships with just the official Core plugin. Every other plugin — free or paid — is installed from the **[plugin marketplace](./plugin-marketplace.md)**: enable it and the bot downloads, verifies, and runs it **sandboxed** on the next start. Browse and install them from the **Plugins → Marketplace** tab in Rewards Desk, or list the catalog from a terminal with `npm run marketplace:list`.

### Example Activation

A marketplace plugin is declared with `source: "marketplace"`:

```jsonc
{
  "cool-plugin": {
    "enabled": true,
    "source": "marketplace",
    "version": "1.2.0"
  }
}
```

The bot fetches it from the signed catalog, verifies its signature and checksum, and runs it in a V8 sandbox. See [Plugin marketplace](./plugin-marketplace.md).

## Managing Plugins

Open **Rewards Desk** (it launches automatically on `npm start`) and go to the **Plugins** page. There you can:

- see every plugin listed in `plugins/plugins.jsonc`
- toggle each plugin on or off (the change is written straight back to `plugins.jsonc`)
- install plugins from the **marketplace** — add a `source: "marketplace"` entry and the bot downloads, verifies, and installs it on the next run (see [Plugin marketplace](./plugin-marketplace.md))
- grant a marketplace plugin **Trusted Mode** (full access) with an explicit per-plugin checkbox — a clear warning is shown first, and enabling a community plugin always warns that it is community-made
- spot the official Core plugin and whether your license unlocks it
- **Publish a plugin** — opens the developer site where you sign in with Discord (no Core license needed) and upload your own plugin
- jump to the guide for building your own plugin

You can also edit `plugins/plugins.jsonc` by hand if you prefer. The bot still verifies the Core bytecode checksum against `plugins/official-core.json` at startup, and every marketplace plugin against the signed `plugins/marketplace.json` catalog.

## How to Learn More

- Read the [Plugin API reference](./plugin-api.md) for exact interfaces and lifecycle hooks.
- Read [Create a plugin](./create-plugin.md) for a small end-to-end example.
- Read [Plugin publishing](./plugin-marketplace.md) if you want to distribute a plugin.
- Read [Official Core plugin](./core-plugin.md) to understand how the paid Core plugin differs from public plugins.
