# Publishing a Plugin

Navigation: [Documentation index](./README.md) → [Plugin system overview](./plugins.md) → [Create a plugin](./create-plugin.md) → [Plugin API reference](./plugin-api.md)

Once your plugin works locally, you can share it so other people can install it. Plugins are plain folders, so distribution is simple: ship the folder, tell people where to drop it, and be honest about what it does.

---

## 1. Package the folder

A distributable plugin should contain:

- `index.js` (or a compiled `index.jsc`)
- `package.json` with `name`, `version`, `description`, and `license`
- `README.md` documenting every config key and what the plugin does
- `LICENSE` if you have specific terms
- a checksum (SHA-256) of the released archive so users can verify it

Zip the folder, or publish it to a public Git repository — whatever is easiest for your users.

## 2. How users install it

Users install a third-party plugin by:

1. placing the plugin folder inside `plugins/`
2. adding an entry for it in `plugins/plugins.jsonc` (or toggling it from the **Plugins** page in Rewards Desk)
3. restarting the bot

That's it — the bot loads every enabled plugin listed in `plugins.jsonc` at startup.

## 3. Listing it in the catalog (optional)

The bot keeps an integrity catalog at `plugins/catalog.json`. Adding an entry lets the bot match a plugin against a known checksum and refuse to load a tampered copy.

```json
{
  "plugins": [
    {
      "name": "summary",
      "version": "1.0.0",
      "description": "Account run summaries.",
      "license": "MIT",
      "price": "free",
      "botVersionRange": ">=4.0.0",
      "installUrl": "https://example.com/summary.zip",
      "supportUrl": "https://discord.gg/example",
      "purchaseUrl": "https://discord.gg/example",
      "sha256": "expected-release-checksum"
    }
  ]
}
```

Paid plugins use an external link (`purchaseUrl`) for payment — the bot does not handle money, commissions, or license issuance for third-party plugins.

> The bot does **not** sandbox plugin code. A plugin runs with the same access as the bot. Tell users to install plugins only from authors they trust, and only install plugins you trust yourself.

## Publishing rules

- **Be clear about the license.** Say whether the plugin is free, paid, open source, or proprietary.
- **Never present a plugin license as the bot license.** They are separate.
- **State supported versions** with `botVersionRange`.
- **Provide a support or contact link** so users can reach you.
- **Don't claim official Core capabilities.** Only the official Core plugin can grant premium entitlement; third-party plugins use the public API only.

## The official Core plugin

The Core plugin ships preinstalled in `plugins/core`. Its bytecode checksum is pinned by `plugins/official-core.json`; if the bytecode doesn't match, the bot refuses to grant premium entitlement. Third-party plugins can't impersonate it.

## Related pages

- [Plugin system overview](./plugins.md)
- [Create a plugin](./create-plugin.md)
- [Plugin API reference](./plugin-api.md)
- [Official Core plugin](./core-plugin.md)
