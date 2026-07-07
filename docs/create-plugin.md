<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Create a Plugin

Navigation: [Documentation index](./README.md) → [Plugin system overview](./plugins.md) → [Plugin API reference](./plugin-api.md) → [Publishing a plugin](./plugin-marketplace.md)

A plugin is a small folder of code that the bot loads at startup. It can add diagnostics, react to account events, register selector groups, read its own **settings**, keep a little **storage**, and show a **panel** in Rewards Desk — all without touching the bot's source and (for community plugins) without any Node.js access. This page walks through a complete plugin from empty folder to running, then points you to publishing.

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

## 6. Settings, storage, and a panel (the capability surface)

These three capabilities let a plugin have its own little UI and memory **without** Node.js access and **without** patching the Desk. They work identically whether your plugin runs sandboxed (community) or in-process (first-party).

### Declare a manifest — `plugin.json`

Ship a `plugin.json` next to `index.js`. It is the **static** source of truth the Desk reads to draw your settings form — your code never runs just to show settings.

```json
{
  "name": "earnings-estimator",
  "version": "1.0.0",
  "permissions": ["settings", "storage", "ui.panel", "points.read"],
  "settings": [
    { "key": "pointsPerEuro", "type": "number", "label": "Points per €", "default": 1500, "min": 1 },
    { "key": "days", "type": "number", "label": "Days to project", "default": 30, "min": 1, "max": 3650 }
  ]
}
```

- **`permissions`** — what your plugin uses. `settings`, `storage`, `ui.panel`, `points.read` are default-safe (no prompt). `net:<host>` is elevated and asks the user for consent.
- **`settings`** — a field list (`number` | `text` | `toggle` | `select`). The Desk renders a form; the user's values are validated against this schema.

### Read settings, use storage, push a panel

```js
module.exports = {
  name: 'earnings-estimator',
  version: '1.0.0',
  register(ctx) { render(ctx) },
  onAccountEnd(ctx) {
    const total = (Number(ctx.storage.get('totalPoints')) || 0) + (ctx.result.collectedPoints || 0)
    ctx.storage.set('totalPoints', total)     // persists across runs, scoped to this plugin
    render(ctx)
  }
}
function render(ctx) {
  const euros = (Number(ctx.storage.get('totalPoints')) || 0) / (ctx.settings.pointsPerEuro || 1500)
  ctx.ui.panel({                               // shown in the Desk Plugins page — no HTML, a fixed vocabulary
    title: 'Earnings estimate',
    stats: [{ label: 'Worth now', value: euros.toFixed(2) + ' €' }]
  })
}
```

- **`ctx.settings`** — resolved values: schema defaults, then `plugins.jsonc` `config`, then what the user set in the Desk.
- **`ctx.storage`** — `get` / `set` / `delete` / `keys`, JSON only, size-capped, persisted under `plugins/.data/<name>/`.
- **`ctx.ui.panel(data)`** — replaces your plugin's panel: a `title`, labelled `stats`, and text `lines`. It is **not** HTML and plugins **cannot** create new Desk pages — everything renders inside your card on the one Plugins page.

A complete, runnable version of this plugin is in [`docs/examples/earnings-estimator/`](./examples/earnings-estimator/) — copy it into `plugins/` to try it, or use it as a template to publish.

---

## Good practices

- **Match the names.** The folder name, the `name` field, and the `plugins.jsonc` key should all be identical.
- **Document every config key** in your README so users know what they're turning on.
- **Stay on the public API.** Don't reach into internal or Core APIs — they change without notice and are reserved for the paid plugin.
- **Declare a version range.** Use `botVersionRange` (for example `>=4.0.0`) so the bot can warn on mismatches.
- **Fail soft.** If your plugin can't do its job, log a warning and return — never crash the run.

## Next steps

- [Plugin API reference](./plugin-api.md) — every interface, context method, and lifecycle hook.
- [Example: earnings-estimator](./examples/earnings-estimator/) — a full settings + storage + panel plugin you can copy.
- [Publishing a plugin](./plugin-marketplace.md) — package, checksum, and share your plugin so others can install it.
- [Official Core plugin](./core-plugin.md) — understand the boundary between public plugins and the paid Core plugin.
