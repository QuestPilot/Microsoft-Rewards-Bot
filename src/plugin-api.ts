/**
 * Public plugin API for Microsoft Rewards Bot.
 *
 * This file is the stable contract third-party plugin authors should import:
 * `microsoft-rewards-bot/plugin-api`.
 */

export const PLUGIN_API_VERSION = '1.0.0'

export type PluginCapability = 'selector-pack' | 'diagnostics' | 'notifications' | 'query-provider'

/**
 * Declared, consent-gated capabilities a plugin may use. Everything except the
 * `net:*` family is a "default-safe" capability (no OS/filesystem/network reach) and
 * is granted without a prompt; `net:<host>` is an ELEVATED capability that the user
 * must approve in the Desk. Declared in the plugin's `plugin.json` manifest so the
 * Desk can show them and render a settings panel WITHOUT running the plugin.
 */
export type PluginPermission =
    | 'settings'    // declare a settings schema -> the Desk renders inputs
    | 'storage'     // a small key/value store scoped to this plugin, persisted across runs
    | 'ui.panel'    // push read-only data to this plugin's panel in the Desk plugins page
    | 'points.read' // receive per-account point results (already delivered via lifecycle hooks)
    | `net:${string}` // ELEVATED: brokered fetch limited to the named host (Phase 2b)

/** One field in a plugin's settings schema — rendered by the Desk into a form. */
export interface PluginSettingField {
    /** Key the value is stored under (a-z0-9._-). Read back via ctx.settings[key]. */
    key: string
    type: 'number' | 'text' | 'toggle' | 'select'
    label: string
    default?: number | string | boolean
    help?: string
    placeholder?: string
    /** number only */
    min?: number
    max?: number
    step?: number
    /** select only */
    options?: ReadonlyArray<{ value: string; label: string }>
}

/**
 * A plugin's static manifest (plugins/<name>/plugin.json). Source of truth for the
 * Desk's settings panel + declared permissions — read from disk, never executed.
 */
export interface PluginManifest {
    name: string
    version: string
    description?: string
    author?: string
    permissions?: PluginPermission[]
    settings?: PluginSettingField[]
}

/** One labelled figure shown in the plugin's Desk panel. */
export interface PluginPanelStat {
    label: string
    value: string
    hint?: string
}

/** Read-only data a plugin pushes to its panel in the Desk plugins page. */
export interface PluginPanelData {
    title?: string
    stats?: PluginPanelStat[]
    lines?: string[]
}

/** A small key/value store scoped to one plugin, persisted across runs (JSON-only). */
export interface PluginStorage {
    get<T = unknown>(key: string): T | undefined
    set(key: string, value: unknown): void
    delete(key: string): void
    keys(): string[]
}

/** The plugin's slice of the Desk plugins page (no arbitrary DOM/pages — a fixed vocabulary). */
export interface PluginUI {
    /** Replace this plugin's panel contents. Capped in size; plain JSON only. */
    panel(data: PluginPanelData): void
}

export interface PluginFetchOptions {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
}

export interface PluginFetchResponse {
    ok: boolean
    status: number
    /** A small, safe subset of response headers (e.g. content-type). */
    headers: Record<string, string>
    /** Response body as text, size-capped by the host broker. */
    body: string
}

/**
 * Brokered HTTPS fetch. ELEVATED capability: it is the HOST that performs the request
 * (the isolate has no network), and only to a host the plugin declared as `net:<host>`
 * in its manifest AND the user consented to in the Desk. Rejects otherwise. https only,
 * no redirects, no private/loopback targets, response size- and time-capped.
 */
export type PluginFetch = (url: string, options?: PluginFetchOptions) => Promise<PluginFetchResponse>

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
    /**
     * Resolved settings values: the plugin's `settings` schema defaults, overlaid with
     * plugins.jsonc `config`, overlaid with the values the user set in the Desk. Read
     * your settings from here (e.g. ctx.settings.pointsPerEuro).
     */
    readonly settings: Record<string, unknown>
    /** A small key/value store scoped to this plugin (requires the `storage` permission). */
    readonly storage: PluginStorage
    /** This plugin's panel in the Desk plugins page (requires the `ui.panel` permission). */
    readonly ui: PluginUI
    /** Brokered HTTPS fetch, limited to granted `net:<host>` permissions (rejects otherwise). */
    readonly fetch: PluginFetch
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
    readonly settings: Record<string, unknown>
    readonly storage: PluginStorage
    readonly ui: PluginUI
    readonly fetch: PluginFetch
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
    /**
     * Auto-update policy for an UNPINNED marketplace plugin. Default (omitted/true):
     * the bot installs the latest approved version on each start. `false` holds it at
     * the installed version. A pinned `version` always wins (never auto-updates), and
     * Trusted-Mode (`trust: 'full'`) plugins are held back regardless (manual update only).
     */
    autoUpdate?: boolean
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
