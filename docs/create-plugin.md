# Create a Plugin

Navigation: [Documentation index](./README.md) → [Plugin system overview](./plugins.md) → [Plugin API reference](./plugin-api.md) → [Publishing a plugin](./plugin-marketplace.md)

A plugin is a small folder of code that the bot loads at startup. It can add diagnostics, react to account events, register selector groups, and read its own settings — without touching the bot's source. This page walks through a complete plugin from empty folder to running, then points you to publishing.

> Plugins use the **public** plugin API. They cannot register premium Core tasks or grant premium entitlements — those are reserved for the official Core plugin.

---

## 1. Create the folder

Every plugin lives in its own folder under `plugins/`. The folder name should match the plugin's `name`.

```text
plugins/summary/
├── index.js        # the plugin code (or index.jsc for compiled plugins)
├── package.json    # name, version, metadata
└── README.md       # what it does and every config key
```

## 2. Write `index.js`

A plugin is a class (or factory) that exposes a `name`, a `version`, and a `register(context)` method. Lifecycle hooks such as `onAccountEnd` are optional.

```js
class SummaryPlugin {
    name = 'summary'
    version = '1.0.0'
    botVersionRange = '>=4.0.0'
    capabilities = ['diagnostics']

    // Called once when the bot starts and the plugin is enabled.
    register(context) {
        // context.config is this plugin's "config" block from plugins.jsonc
        this.config = context.config || {}
        context.log.info('main', 'SUMMARY', 'Summary plugin loaded')

        context.registerDiagnostics(() => [
            { level: 'info', message: 'Summary plugin is active' }
        ])
    }

    // Called after each account finishes its run.
    onAccountEnd({ log, result }) {
        log.info('main', 'SUMMARY', `${result.email}: +${result.collectedPoints} points`)
    }
}

module.exports = SummaryPlugin
```

Writing the plugin in TypeScript? Import the public types from `microsoft-rewards-bot/plugin-api` and compile to `index.js`. See the [Plugin API reference](./plugin-api.md) for the exact interfaces and every lifecycle hook.

## 3. Add `package.json`

```json
{
  "name": "summary",
  "version": "1.0.0",
  "description": "Writes a short per-account summary after each run.",
  "main": "index.js",
  "license": "MIT"
}
```

## 4. Enable it

Add an entry to `plugins/plugins.jsonc`:

```jsonc
{
  "summary": {
    "enabled": true,
    "priority": 50,
    "config": {}
  }
}
```

- `enabled` — `true` loads it, `false` keeps it installed but inactive
- `priority` — higher values load first (Core is `100`)
- `config` — passed to your plugin as `context.config`

You can also flip plugins on and off from the **Plugins** page in Rewards Desk — it edits this same file for you.

## 5. Run and verify

Start the bot with `npm start`. When the plugin loads you'll see this in the console (and in the Desk **Console** page):

```text
Registered plugin: summary@1.0.0
```

If it doesn't appear, check that the folder name matches `name`, that `enabled` is `true`, and that `index.js` exports the class.

---

## Good practices

- **Match the names.** The folder name, the `name` field, and the `plugins.jsonc` key should all be identical.
- **Document every config key** in your README so users know what they're turning on.
- **Stay on the public API.** Don't reach into internal or Core APIs — they change without notice and are reserved for the paid plugin.
- **Declare a version range.** Use `botVersionRange` (for example `>=4.0.0`) so the bot can warn on mismatches.
- **Fail soft.** If your plugin can't do its job, log a warning and return — never crash the run.

## Next steps

- [Plugin API reference](./plugin-api.md) — every interface, context method, and lifecycle hook.
- [Publishing a plugin](./plugin-marketplace.md) — package, checksum, and share your plugin so others can install it.
- [Official Core plugin](./core-plugin.md) — understand the boundary between public plugins and the paid Core plugin.
