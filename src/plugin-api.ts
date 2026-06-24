/**
 * Public plugin API for Microsoft Rewards Bot.
 *
 * This file is the stable contract third-party plugin authors should import:
 * `microsoft-rewards-bot/plugin-api`.
 */

export const PLUGIN_API_VERSION = '1.0.0'

export type PluginCapability = 'selector-pack' | 'diagnostics' | 'notifications' | 'query-provider'

export interface PluginMetadata {
    /** Unique plugin identifier. Must match the folder/file key in plugins/plugins.jsonc. */
    readonly name: string
    /** Plugin semantic version. */
    readonly version: string
    /** Supported bot semver range, for marketplace compatibility checks. */
    readonly botVersionRange?: string
    /** Capabilities used by the plugin. */
    readonly capabilities?: readonly PluginCapability[]
    readonly description?: string
    readonly author?: string
    readonly homepage?: string
    readonly license?: string
}

export interface IPlugin extends PluginMetadata {
    /** Called once after the plugin is loaded. */
    register(context: PublicPluginContext): void | Promise<void>
    /** Called after all plugins have registered and the bot is ready to process accounts. */
    onBotInitialized?(context: PluginLifecycleContext): void | Promise<void>
    /** Called before each account run starts. */
    onAccountStart?(context: AccountLifecycleContext): void | Promise<void>
    /** Called after each account run completes. */
    onAccountEnd?(context: AccountEndLifecycleContext): void | Promise<void>
    /** Called when the bot is shutting down. */
    destroy?(): void | Promise<void>
}

export interface PublicPluginContext {
    readonly apiVersion: typeof PLUGIN_API_VERSION
    /** Plugin-specific config loaded from plugins/plugins.jsonc. */
    readonly config: Record<string, unknown>
    /** Logger proxy scoped to the bot log system. */
    readonly log: PluginLogger
    /** Register public selector groups. Premium task registration is intentionally not public. */
    registerSelectors(selectors: Record<string, Record<string, unknown>>): void
    /** Register diagnostics that can be surfaced by the local plugin manager. */
    registerDiagnostics(provider: PluginDiagnosticsProvider): void
    /** Register a non-premium notification sink for summaries or status messages. */
    registerNotificationSink(sink: PluginNotificationSink): void
}

export interface PluginLifecycleContext {
    readonly apiVersion: typeof PLUGIN_API_VERSION
    readonly config: Record<string, unknown>
    readonly log: PluginLogger
}

export interface AccountLifecycleContext extends PluginLifecycleContext {
    readonly email: string
}

export interface AccountEndLifecycleContext extends AccountLifecycleContext {
    readonly result: AccountResult
}

export interface AccountResult {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

export interface PluginLogger {
    info(source: boolean | 'main', tag: string, message: string, color?: string): void
    warn(source: boolean | 'main', tag: string, message: string): void
    error(source: boolean | 'main', tag: string, message: string | Error): void
    debug(source: boolean | 'main', tag: string, message: string): void
}

export interface PluginConfigEntry {
    enabled?: boolean
    priority?: number
    config?: Record<string, unknown>
    /**
     * Isolation/trust level for this plugin:
     *  - `'sandbox'` — run untrusted in a V8 isolate with no Node APIs (the default for
     *    marketplace-sourced plugins).
     *  - `'full'` — Trusted Mode: run in-process with full access. Requires explicit local
     *    user consent and is NEVER set automatically by the marketplace.
     * First-party/local plugins with no `trust` set keep the in-process path.
     */
    trust?: 'full' | 'sandbox'
    /** Provenance. `'marketplace'` plugins are sandboxed unless `trust` is `'full'`. */
    source?: 'local' | 'marketplace'
    /** Pinned version for a marketplace plugin (matched against the signed catalog). */
    version?: string
}

export interface PluginDiagnostic {
    level: 'info' | 'warn' | 'error'
    message: string
    details?: Record<string, unknown>
}

export type PluginDiagnosticsProvider = () => PluginDiagnostic[] | Promise<PluginDiagnostic[]>

export interface PluginNotification {
    title: string
    message: string
    level?: 'info' | 'warn' | 'error'
}

export type PluginNotificationSink = (notification: PluginNotification) => void | Promise<void>
