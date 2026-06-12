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
    readonly log: PluginLogger
    registerSelectors(selectors: Record<string, Record<string, unknown>>): void
    registerDiagnostics(provider: PluginDiagnosticsProvider): void
    registerNotificationSink(sink: PluginNotificationSink): void
}
```

Public plugins do not receive the raw bot instance and cannot register official premium tasks. This prevents third-party plugins from toggling premium-only Core behavior such as unlimited Daily Set quests.

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

`onAccountStart` receives `{ email, config, log, apiVersion }`.
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

Plugins are local code and should be installed only from trusted sources. The marketplace checks metadata and checksums, but it is not a sandbox. Paid or proprietary plugins must clearly document their own license and support channel.

Related pages:

- [Plugin system overview](./plugins.md) for activation and load order.
- [Create a plugin](./create-plugin.md) for a minimal working example.
- [Plugin publishing](./plugin-marketplace.md) for catalog metadata.
- [Official Core plugin](./core-plugin.md) for the premium plugin boundary.
