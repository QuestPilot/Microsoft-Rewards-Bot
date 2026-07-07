<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Plugin API Reference

Navigation: [Documentation index](./README.md) -> [Plugin system overview](./plugins.md) -> [Create a plugin](./create-plugin.md) -> [Plugin publishing](./plugin-marketplace.md)

This page documents the public third-party plugin contract. Import it from:

```ts
import type { IPlugin, PublicPluginContext } from 'microsoft-rewards-bot/plugin-api'
```

The official Core plugin uses an internal API that is not part of this public contract.

## Public Contract

```ts
export interface IPlugin {
    readonly name: string
    readonly version: string
    readonly botVersionRange?: string
    readonly capabilities?: readonly PluginCapability[]
    readonly description?: string
    readonly author?: string
    readonly homepage?: string
    readonly license?: string

    register(context: PublicPluginContext): void | Promise<void>
    onBotInitialized?(context: PluginLifecycleContext): void | Promise<void>
    onAccountStart?(context: AccountLifecycleContext): void | Promise<void>
    onAccountEnd?(context: AccountEndLifecycleContext): void | Promise<void>
    destroy?(): void | Promise<void>
}
```

Plugin names must match the folder or file key listed in `plugins/plugins.jsonc`.

## Context

```ts
export interface PublicPluginContext {
    readonly apiVersion: '1.0.0'
    readonly config: Record<string, unknown>
    readonly settings: Record<string, unknown>   // resolved from the plugin.json schema
    readonly storage: PluginStorage               // scoped, persisted key/value store
    readonly ui: PluginUI                          // this plugin's panel in the Desk
    readonly fetch: PluginFetch                    // brokered https, granted per net:<host>
    readonly log: PluginLogger
    registerSelectors(selectors: Record<string, Record<string, unknown>>): void
    registerDiagnostics(provider: PluginDiagnosticsProvider): void
    registerNotificationSink(sink: PluginNotificationSink): void
}
```

The same `settings`, `storage`, `ui`, `config`, and `log` are also present on every lifecycle context (`onAccountEnd`, etc.), so you can read settings and update storage/panel at any point in the run.

Public plugins do not receive the raw bot instance and cannot register official premium tasks. This prevents third-party plugins from toggling premium-only Core behavior such as unlimited Daily Set quests.

## Capabilities: settings, storage, panel

A plugin declares what it uses in a static `plugin.json` manifest next to `index.js` — read by the Desk without running your code:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "permissions": ["settings", "storage", "ui.panel", "points.read"],
  "settings": [
    { "key": "pointsPerEuro", "type": "number", "label": "Points per €", "default": 1500, "min": 1 }
  ]
}
```

```ts
export type PluginPermission =
    | 'settings' | 'storage' | 'ui.panel' | 'points.read' // default-safe (no prompt)
    | `net:${string}`                                     // ELEVATED: brokered fetch, asks for consent

export interface PluginSettingField {
    key: string
    type: 'number' | 'text' | 'toggle' | 'select'
    label: string
    default?: number | string | boolean
    help?: string
    placeholder?: string
    min?: number; max?: number; step?: number             // number
    options?: ReadonlyArray<{ value: string; label: string }> // select
}

export interface PluginStorage {
    get<T = unknown>(key: string): T | undefined
    set(key: string, value: unknown): void                // JSON-serializable, size-capped
    delete(key: string): void
    keys(): string[]
}

export interface PluginUI {
    panel(data: PluginPanelData): void                    // replaces this plugin's Desk panel
}

export interface PluginPanelData {
    title?: string
    stats?: Array<{ label: string; value: string; hint?: string }>
    lines?: string[]
}
```

- **`ctx.settings`** — the schema defaults, overlaid with `plugins.jsonc` `config`, overlaid with what the user set in the Desk (the winning layer).
- **`ctx.storage`** — persisted under `plugins/.data/<name>/`, scoped to your plugin, JSON only.
- **`ctx.ui.panel(...)`** — a fixed vocabulary (title + labelled stats + text lines), **never HTML**. Plugins render inside their card on the single Desk Plugins page and **cannot** create new pages.

### Network (`net:<host>`) — elevated

`net:<host>` is the one **elevated** permission. Declare each host you need in `permissions` (e.g. `"net:api.example.com"`). It is **denied by default** — the user must turn it on per host in the Desk (a warning is shown). Only then does `ctx.fetch` work for that host.

```ts
export type PluginFetch = (url: string, options?: PluginFetchOptions) => Promise<PluginFetchResponse>

export interface PluginFetchOptions { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }
export interface PluginFetchResponse { ok: boolean; status: number; headers: Record<string, string>; body: string }
```

```js
const res = await ctx.fetch('https://api.example.com/rate', { headers: { accept: 'application/json' } })
if (res.ok) { const data = JSON.parse(res.body) /* … */ }
```

The **host** performs the request, not your plugin — so it is enforced: **https only**, only to a **granted** host, **no redirects**, no IP-literal/loopback/`*.local` targets (SSRF-safe), and the response is size- and time-capped. `ctx.fetch` **rejects** if the host isn't granted.

## Config

`plugins/plugins.jsonc` is the source of truth when it exists:

```jsonc
{
  "my-plugin": {
    "enabled": true,
    "priority": 50,
    "config": {
      "mode": "summary"
    }
  }
}
```

Higher `priority` values load first. Plugins not listed in the file are skipped.

## Logger

```ts
export interface PluginLogger {
    info(source: boolean | 'main', tag: string, message: string, color?: string): void
    warn(source: boolean | 'main', tag: string, message: string): void
    error(source: boolean | 'main', tag: string, message: string | Error): void
    debug(source: boolean | 'main', tag: string, message: string): void
}
```

Use `context.log` instead of writing directly to stdout when possible.

## Lifecycle Data

```ts
export interface AccountResult {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}
```

`onAccountStart` receives `{ email, config, settings, storage, ui, log, apiVersion }`.
`onAccountEnd` receives the same fields plus `result`.

Notification sinks registered with `registerNotificationSink` receive local bot notifications such as run completion summaries. They are for local extensions only; they do not send data anywhere unless the plugin itself does so.

## Example

```ts
import type { IPlugin } from 'microsoft-rewards-bot/plugin-api'

export default class SummaryPlugin implements IPlugin {
    readonly name = 'summary'
    readonly version = '1.0.0'
    readonly botVersionRange = '>=4.0.0'
    readonly capabilities = ['diagnostics'] as const

    register(context) {
        context.log.info('main', 'SUMMARY', `Loaded public plugin API ${context.apiVersion}`)
        context.registerDiagnostics(() => [
            { level: 'info', message: 'Summary plugin is active' }
        ])
    }

    onAccountEnd({ log, result }) {
        log.info(
            'main',
            'SUMMARY',
            `${result.email}: +${result.collectedPoints} points | success=${result.success}`
        )
    }
}
```

## Security Model

Marketplace-installed plugins (`source: "marketplace"`) run **sandboxed** in a V8 isolate with no Node APIs and no access to credentials or the bot object — they exchange only the public API over a JSON bridge, and account emails are tokenized before crossing the boundary. The `settings`, `storage`, and `ui.panel` capabilities are also bridged over that same JSON boundary (the plugin never touches the filesystem itself — the host reads/writes the scoped `plugins/.data/<name>/` files on its behalf and caps their size). A plugin that needs full access must be granted **Trusted Mode** (`trust: "full"`) locally and explicitly; the marketplace can never grant it. A plugin folder you place in `plugins/` yourself runs in-process unless you mark its entry `trust: "sandbox"`. Paid or proprietary plugins must clearly document their own license and support channel.

Related pages:

- [Plugin system overview](./plugins.md) for activation and load order.
- [Create a plugin](./create-plugin.md) for a minimal working example.
- [Plugin publishing](./plugin-marketplace.md) for catalog metadata.
- [Official Core plugin](./core-plugin.md) for the premium plugin boundary.
