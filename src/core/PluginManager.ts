/**
 * Microsoft Rewards Bot — Plugin Manager
 * Copyright (c) 2026 QuestPilot
 *
 * Licensed under the QuestPilot Source Available License 1.0.
 * See LICENSE for full terms.
 */

import crypto from 'crypto'
import cluster from 'cluster'
import fs from 'fs'
import path from 'path'
import { PLUGIN_API_VERSION } from '../plugin-api'
import type { MicrosoftRewardsBot } from '../index'
import type {
    AccountResult,
    IPlugin,
    OfficialCoreContext,
    PluginConfigEntry,
    PluginLogger,
    PremiumTaskMap
} from './InternalPluginAPI'
import type { PluginDiagnosticsProvider, PluginNotification, PluginNotificationSink, PublicPluginContext } from '../plugin-api'

interface OfficialCoreManifest {
    plugin: 'core'
    version: string
    indexSha256?: string
    bytecodeTarget?: {
        node?: string
        platform?: string
        arch?: string
    }
    targets?: Record<string, OfficialCoreTarget>
}

interface OfficialCoreTarget {
    indexSha256?: string
    bytecodeTarget?: {
        node?: string
        platform?: string
        arch?: string
    }
}

interface PluginPackageManifest {
    engines?: {
        node?: string
    }
    msrb?: {
        indexSha256?: string
        bytecodeTarget?: {
            node?: string
            platform?: string
            arch?: string
        }
        targets?: Record<string, OfficialCoreTarget>
    }
}

/** Handle returned by the out-of-process plugin sandbox (scripts/plugin-sandbox.js). */
interface SandboxedPluginHandle {
    name: string | null
    version: string | null
    hooks: { onBotInitialized: boolean; onAccountStart: boolean; onAccountEnd: boolean; destroy: boolean }
    sinkCount: number
    emitNotification(notification: unknown): Promise<void>
    runLifecycle(name: string, payload?: unknown): Promise<void>
    dispose(): void
}

type CreatePluginSandbox = (options: {
    source: string
    config?: Record<string, unknown>
    apiVersion?: string
    log?: PluginLogger
    memoryLimitMb?: number
    timeoutMs?: number
}) => Promise<SandboxedPluginHandle>

/** Downloads a marketplace plugin's raw source by its catalog `installUrl`. */
type MarketplaceFetcher = (url: string) => Promise<Buffer | Uint8Array | string>

/** Pulls the signed catalog { catalog, signature } from core-api. */
type CatalogFetcher = (url: string) => Promise<{ catalog: string; signature: string }>

/** Optional injection seam — tests pass local fetchers; runtime uses HTTPS. */
export interface PluginManagerOptions {
    marketplaceFetcher?: MarketplaceFetcher
    /** Where to pull the signed catalog from (defaults to env MSRB_MARKETPLACE_CATALOG_URL). */
    marketplaceCatalogUrl?: string
    catalogFetcher?: CatalogFetcher
}

export class PluginManager {
    private bot: MicrosoftRewardsBot
    private plugins: IPlugin[] = []
    private pluginConfigs = new WeakMap<IPlugin, Record<string, unknown>>()
    private officialCorePlugins = new WeakSet<IPlugin>()
    private sandboxedPlugins = new WeakSet<IPlugin>()
    private readonly sandboxAccountKey = crypto.randomBytes(32)
    private readonly marketplaceFetcher?: MarketplaceFetcher
    private readonly marketplaceCatalogUrl?: string
    private readonly catalogFetcher?: CatalogFetcher
    private registeredTasks: Partial<PremiumTaskMap> = {}
    private registeredSelectors: Record<string, Record<string, unknown>> = {}
    private diagnosticsProviders: PluginDiagnosticsProvider[] = []
    private notificationSinks: PluginNotificationSink[] = []
    private officialCoreEntitlement = false

    constructor(bot: MicrosoftRewardsBot, options: PluginManagerOptions = {}) {
        this.bot = bot
        this.marketplaceFetcher = options.marketplaceFetcher
        this.marketplaceCatalogUrl = options.marketplaceCatalogUrl
        this.catalogFetcher = options.catalogFetcher
    }

    /**
     * Scan the `plugins/` directory and load all valid plugins.
     * Called once during `bot.initialize()`.
     */
    async loadPlugins(): Promise<void> {
        const pluginsDir = path.resolve(process.cwd(), 'plugins')

        if (!fs.existsSync(pluginsDir)) {
            this.bot.logger.debug('main', 'PLUGIN-MANAGER', 'No plugins/ directory found - running core only')
            return
        }

        const { config: pluginConfig, hasFile: hasConfigFile } = this.loadPluginConfig()

        // Local offline panic switch: disable every plugin except verified Core.
        // Works without core-api — the incident-response control for a bad plugin.
        const thirdPartyDisabled = process.env.MSRB_DISABLE_PLUGINS === '1'
        if (thirdPartyDisabled && cluster.isPrimary) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                'MSRB_DISABLE_PLUGINS=1 set — loading only verified Core; all other plugins are disabled'
            )
        }

        // Materialize any marketplace-sourced plugins declared in plugins.jsonc
        // BEFORE the directory scan, so a freshly downloaded plugin is picked up in
        // this same run. Primary-only (workers load what the primary installs); the
        // MSRB_DISABLE_PLUGINS panic switch skips it entirely.
        if (!thirdPartyDisabled && cluster.isPrimary) {
            await this.installMarketplacePlugins(pluginConfig)
        }

        const ignoredFiles = new Set([
            'README.md',
            'plugins.jsonc',
            'official-core.json',
            'official-core.sig',
            'catalog.json',
            'marketplace.json',
            'marketplace.sig',
            'marketplace.example.json'
        ])
        const entries = fs
            .readdirSync(pluginsDir, { withFileTypes: true })
            .filter(entry => !entry.name.startsWith('.') && !ignoredFiles.has(entry.name))
            .sort((left, right) => {
                const leftName = this.getPluginEntryName(left)
                const rightName = this.getPluginEntryName(right)
                const leftPriority = pluginConfig[leftName]?.priority ?? 0
                const rightPriority = pluginConfig[rightName]?.priority ?? 0

                if (leftPriority !== rightPriority) {
                    return rightPriority - leftPriority
                }

                return leftName.localeCompare(rightName)
            })

        for (const entry of entries) {
            const entryName = this.getPluginEntryName(entry)
            const entryConfig = pluginConfig[entryName]

            if (thirdPartyDisabled && entryName !== 'core') {
                continue
            }

            if (hasConfigFile) {
                if (!entryConfig) {
                    this.bot.logger.debug(
                        'main',
                        'PLUGIN-MANAGER',
                        `Plugin "${entryName}" not configured in plugins.jsonc (skipped)`
                    )
                    continue
                }

                if (entryConfig.enabled === false) {
                    if (cluster.isWorker) {
                        continue
                    }
                    this.bot.logger.info('main', 'PLUGIN-MANAGER', `Plugin "${entryName}" disabled in plugins.jsonc`)
                    continue
                }
            }

            try {
                if (entry.isDirectory()) {
                    await this.loadDirectoryPlugin(entryName, path.join(pluginsDir, entry.name), entryConfig)
                } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsc')) {
                    await this.loadPluginFile(entryName, path.join(pluginsDir, entry.name), entryConfig)
                }
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Failed to load plugin "${entryName}": ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        if (this.plugins.length > 0 && cluster.isPrimary) {
            this.bot.logger.info(
                'main',
                'PLUGIN-MANAGER',
                `Loaded ${this.plugins.length} plugin(s): ${this.plugins.map(p => `${p.name}@${p.version}`).join(', ')}`
            )
        } else {
            this.bot.logger.debug('main', 'PLUGIN-MANAGER', 'No plugins loaded - running core only')
        }
    }

    /**
     * Download + verify + install any `source: 'marketplace'` plugin declared in
     * plugins.jsonc whose source isn't already present (or is outdated) on disk.
     * Self-healing: runs every startup and re-materializes a plugin that an
     * auto-update or the user may have removed (plugins.jsonc itself is preserved
     * across updates, so the intent to keep the plugin survives). Fail-closed — the
     * signed catalog must verify before anything is fetched, and each plugin's bytes
     * must match the catalog's pinned sha256 (enforced by ensureMarketplacePlugin).
     */
    private async installMarketplacePlugins(pluginConfig: Record<string, PluginConfigEntry>): Promise<void> {
        const marketplaceEntries = Object.entries(pluginConfig).filter(
            ([, entry]) => entry && entry.source === 'marketplace' && entry.enabled !== false
        )
        if (marketplaceEntries.length === 0) return

        // Refresh the signed catalog from core-api first (best-effort): cache it to
        // plugins/marketplace.json(+.sig) so a new publish reaches the bot without a
        // bot update. Offline / failure -> fall back to the cached copy (fail-closed
        // happens later in verify). Only runs when a catalog URL is configured, so
        // tests stay offline.
        const catalogUrl = this.marketplaceCatalogUrl ?? process.env.MSRB_MARKETPLACE_CATALOG_URL
        if (catalogUrl) {
            try {
                await this.syncMarketplaceCatalog(catalogUrl)
            } catch (error) {
                this.bot.logger.warn(
                    'main',
                    'PLUGIN-MANAGER',
                    `Could not refresh the marketplace catalog from ${catalogUrl}; using the cached copy: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        // Lazy-require the network-free verifier + installer (kept off the hot path).
        let mp: {
            verifyMarketplaceCatalog(options: { root?: string; keysDir?: string }): {
                ok: boolean
                reason?: string
                catalog?: unknown
                expired?: boolean
            }
        }
        let installer: {
            ensureMarketplacePlugin(options: {
                root: string
                name: string
                requestedVersion?: string
                catalog: unknown
                fetcher: MarketplaceFetcher
                botVersion?: string
                apiVersion?: string
                now?: string
            }): Promise<{ installed: boolean; reason: string; version?: string }>
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            mp = require('../../scripts/security/marketplace-catalog')
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            installer = require('../../scripts/plugin-installer')
        } catch (error) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                `Marketplace installer unavailable; ${marketplaceEntries.length} marketplace plugin(s) will not be installed: ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const verification = mp.verifyMarketplaceCatalog({
            root: process.cwd(),
            keysDir: process.env.MSRB_MARKETPLACE_KEYS_DIR || undefined
        })
        if (!verification.ok) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                `Marketplace catalog unavailable (${verification.reason}); ${marketplaceEntries.length} marketplace plugin(s) will not be installed`
            )
            return
        }
        if (verification.expired) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                'Marketplace catalog is stale; skipping marketplace plugin installation until it refreshes'
            )
            return
        }

        const fetcher = this.marketplaceFetcher ?? this.defaultMarketplaceFetcher()
        if (!fetcher) {
            this.bot.logger.warn('main', 'PLUGIN-MANAGER', 'Marketplace fetcher unavailable; cannot download marketplace plugins')
            return
        }

        const botVersion = this.readBotVersion()
        for (const [name, entry] of marketplaceEntries) {
            try {
                const result = await installer.ensureMarketplacePlugin({
                    root: process.cwd(),
                    name,
                    requestedVersion: entry.version,
                    catalog: verification.catalog,
                    fetcher,
                    botVersion,
                    apiVersion: PLUGIN_API_VERSION,
                    now: new Date().toISOString()
                })
                this.logMarketplaceInstall(name, result)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Marketplace install failed for "${name}": ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    /** Real runtime fetcher: a hardened HTTPS GET (scripts/marketplace-fetch.js). */
    private defaultMarketplaceFetcher(): MarketplaceFetcher | undefined {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { fetchMarketplaceAsset } = require('../../scripts/marketplace-fetch') as {
                fetchMarketplaceAsset: (url: string) => Promise<Buffer>
            }
            return (url: string) => fetchMarketplaceAsset(url)
        } catch {
            return undefined
        }
    }

    /** Pull the signed catalog from core-api and cache it to plugins/marketplace.json(+.sig). */
    private async syncMarketplaceCatalog(url: string): Promise<void> {
        const fetchCatalog = this.catalogFetcher ?? this.defaultCatalogFetcher()
        if (!fetchCatalog) throw new Error('no catalog fetcher available')
        const { catalog, signature } = await fetchCatalog(url)
        if (typeof catalog !== 'string' || typeof signature !== 'string') {
            throw new Error('catalog response must be { catalog, signature }')
        }
        const dir = path.resolve(process.cwd(), 'plugins')
        fs.mkdirSync(dir, { recursive: true })
        this.atomicWriteFile(path.join(dir, 'marketplace.json'), catalog)
        this.atomicWriteFile(path.join(dir, 'marketplace.sig'), `${signature.trim()}\n`)
    }

    private defaultCatalogFetcher(): CatalogFetcher | undefined {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { fetchSignedCatalog } = require('../../scripts/marketplace-fetch') as {
                fetchSignedCatalog: (url: string) => Promise<{ catalog: string; signature: string }>
            }
            return (url: string) => fetchSignedCatalog(url)
        } catch {
            return undefined
        }
    }

    private atomicWriteFile(filePath: string, data: string): void {
        const tmp = `${filePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
        fs.writeFileSync(tmp, data)
        fs.renameSync(tmp, filePath)
    }

    private readBotVersion(): string | undefined {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
            return typeof pkg.version === 'string' ? pkg.version : undefined
        } catch {
            return undefined
        }
    }

    /** Append every install attempt to .plugins-marketplace.log + surface notable outcomes. */
    private logMarketplaceInstall(name: string, result: { installed: boolean; reason: string; version?: string }): void {
        const line = `${new Date().toISOString()} ${name} installed=${result.installed} reason=${result.reason}${result.version ? ` version=${result.version}` : ''}\n`
        try {
            fs.appendFileSync(path.resolve(process.cwd(), '.plugins-marketplace.log'), line)
        } catch {
            // logging is best-effort
        }
        if (result.installed && result.reason === 'installed') {
            this.bot.logger.info('main', 'PLUGIN-MANAGER', `Installed marketplace plugin: ${name}@${result.version}`)
        } else if (!result.installed) {
            this.bot.logger.warn('main', 'PLUGIN-MANAGER', `Marketplace plugin "${name}" not installed (${result.reason})`)
        }
    }

    /** Returns premium tasks registered by the official Core plugin. */
    getRegisteredTasks(): Partial<PremiumTaskMap> {
        return this.registeredTasks
    }

    /** True only after the verified official Core plugin grants premium entitlement. */
    hasOfficialCoreEntitlement(): boolean {
        return this.officialCoreEntitlement
    }

    /** Returns all selector groups registered by plugins. */
    getSelectors(): Record<string, Record<string, unknown>> {
        return this.registeredSelectors
    }

    /** Get a specific selector group by name. */
    getSelector(name: string): Record<string, unknown> | undefined {
        return this.registeredSelectors[name]
    }

    getDiagnosticsProviders(): PluginDiagnosticsProvider[] {
        return this.diagnosticsProviders
    }

    getNotificationSinks(): PluginNotificationSink[] {
        return this.notificationSinks
    }

    async notify(notification: PluginNotification): Promise<void> {
        for (const sink of this.notificationSinks) {
            try {
                await sink(notification)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Plugin notification sink error: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    async notifyBotInitialized(): Promise<void> {
        for (const plugin of this.plugins) {
            try {
                await plugin.onBotInitialized?.(this.createLifecycleContext(plugin))
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Plugin "${plugin.name}" onBotInitialized error: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    async notifyAccountStart(email: string): Promise<void> {
        for (const plugin of this.plugins) {
            try {
                await plugin.onAccountStart?.({ ...this.createLifecycleContext(plugin), email })
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Plugin "${plugin.name}" onAccountStart error: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    async notifyAccountEnd(email: string, result: AccountResult): Promise<void> {
        for (const plugin of this.plugins) {
            try {
                await plugin.onAccountEnd?.({ ...this.createLifecycleContext(plugin), email, result })
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Plugin "${plugin.name}" onAccountEnd error: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    async destroyAll(): Promise<void> {
        for (const plugin of this.plugins) {
            try {
                await plugin.destroy?.()
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'PLUGIN-MANAGER',
                    `Plugin "${plugin.name}" destroy error: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    private loadPluginConfig(): { config: Record<string, PluginConfigEntry>; hasFile: boolean } {
        const configPath = path.resolve(process.cwd(), 'plugins', 'plugins.jsonc')

        if (!fs.existsSync(configPath)) {
            return { config: {}, hasFile: false }
        }

        try {
            const content = fs.readFileSync(configPath, 'utf-8')
            let jsonContent = content
                .split('\n')
                .map(line => {
                    const commentIndex = line.indexOf('//')
                    if (commentIndex !== -1) {
                        const beforeComment = line.substring(0, commentIndex)
                        const quoteCount = (beforeComment.match(/"/g) || []).length
                        if (quoteCount % 2 === 0) {
                            return beforeComment
                        }
                    }
                    return line
                })
                .join('\n')
                .replace(/\/\*[\s\S]*?\*\//g, '')

            jsonContent = jsonContent.replace(/,(\s*[}\]])/g, '$1')

            return { config: JSON.parse(jsonContent), hasFile: true }
        } catch (error) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                `Failed to load plugins.jsonc: ${error instanceof Error ? error.message : String(error)}`
            )
            return { config: {}, hasFile: true }
        }
    }

    private getPluginEntryName(entry: fs.Dirent): string {
        return entry.isDirectory() ? entry.name : entry.name.replace(/\.(jsc|js)$/i, '')
    }

    private async loadDirectoryPlugin(
        entryName: string,
        dirPath: string,
        entryConfig: PluginConfigEntry | undefined
    ): Promise<void> {
        const jscPath = path.join(dirPath, 'index.jsc')
        const jsPath = path.join(dirPath, 'index.js')

        if (entryName === 'core' && fs.existsSync(jsPath)) {
            await this.loadPluginFile(entryName, jsPath, entryConfig)
        } else if (fs.existsSync(jscPath)) {
            await this.loadPluginFile(entryName, jscPath, entryConfig)
        } else if (fs.existsSync(jsPath)) {
            await this.loadPluginFile(entryName, jsPath, entryConfig)
        }
    }

    private async loadPluginFile(
        entryName: string,
        filePath: string,
        entryConfig: PluginConfigEntry | undefined
    ): Promise<void> {
        const pluginConfig = entryConfig?.config ?? {}

        // Verify the official Core plugin BEFORE loading its bytecode
        const isOfficialCore = this.isVerifiedOfficialCore(entryName, filePath)

        // A marketplace plugin is ALWAYS vouched for by the signed catalog (signature +
        // pinned sha256 + not revoked + not stale) — whether it runs sandboxed OR was
        // locally elevated to Trusted Mode. Trusted Mode skips the sandbox, so verifying
        // here (before any of its code runs) is what keeps an elevated marketplace plugin
        // honest. Fail closed.
        if (!isOfficialCore && entryConfig?.source === 'marketplace') {
            this.assertMarketplaceTrust(entryName, filePath, entryConfig)
        }

        const trust = this.resolvePluginTrust(isOfficialCore, entryConfig)

        // Loud, unmissable warning when a COMMUNITY (marketplace) plugin has been granted
        // full in-process access. It is an explicit local opt-in, so surface it on every
        // run — including headless/CLI, where there is no Desk prompt to remind you.
        if (trust === 'trusted' && entryConfig?.source === 'marketplace' && cluster.isPrimary) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                `⚠ Community plugin "${entryName}" is running in TRUSTED MODE (full access, NOT sandboxed). Only keep this on for plugins you fully trust.`
            )
        }

        // Untrusted third-party plugins run in a V8 isolate with no Node APIs.
        // Core and trusted/first-party plugins keep the in-process require() path.
        if (trust === 'sandboxed') {
            return this.loadSandboxedPlugin(entryName, filePath, entryConfig)
        }

        if (filePath.endsWith('.jsc') || this.isOfficialCoreLoader(entryName, filePath)) {
            this.assertBytecodeTarget(entryName, filePath)
            require('bytenode')
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pluginModule = require(filePath) as Record<string, unknown>
        const exported = (pluginModule.default ?? pluginModule.plugin ?? pluginModule) as
            | IPlugin
            | (new () => IPlugin)
            | (() => IPlugin)

        let plugin: IPlugin

        if (typeof exported === 'function') {
            try {
                plugin = new (exported as new () => IPlugin)()
            } catch {
                plugin = (exported as () => IPlugin)()
            }
        } else {
            plugin = exported
        }

        if (
            !plugin ||
            typeof plugin !== 'object' ||
            typeof plugin.name !== 'string' ||
            typeof plugin.version !== 'string' ||
            typeof plugin.register !== 'function'
        ) {
            throw new Error('Invalid plugin: must export { name: string, version: string, register: Function }')
        }

        if (plugin.name !== entryName) {
            throw new Error(`Plugin name "${plugin.name}" must match configured entry "${entryName}"`)
        }

        const context = isOfficialCore
            ? this.createOfficialCoreContext(pluginConfig)
            : this.createPublicPluginContext(pluginConfig)

        await plugin.register(context)
        this.plugins.push(plugin)
        this.pluginConfigs.set(plugin, pluginConfig)

        if (isOfficialCore) {
            this.officialCorePlugins.add(plugin)
        }

        if (cluster.isPrimary) {
            this.bot.logger.info(
                'main',
                'PLUGIN-MANAGER',
                `Registered ${isOfficialCore ? 'official ' : ''}plugin: ${plugin.name}@${plugin.version}`
            )
        }
    }

    /**
     * Decide how a plugin runs:
     *  - `core`      — the verified official Core plugin (in-process, full trust).
     *  - `sandboxed` — untrusted: marketplace-sourced, or explicitly `trust: 'sandbox'`.
     *  - `trusted`   — in-process: explicit `trust: 'full'` (Trusted Mode), or a local
     *                  first-party plugin with no trust hint (backward compatible).
     */
    private resolvePluginTrust(isOfficialCore: boolean, entryConfig: PluginConfigEntry | undefined): 'core' | 'sandboxed' | 'trusted' {
        if (isOfficialCore) return 'core'
        if (entryConfig?.trust === 'full') return 'trusted'
        if (entryConfig?.trust === 'sandbox' || entryConfig?.source === 'marketplace') return 'sandboxed'
        return 'trusted'
    }

    /**
     * Load an untrusted plugin inside a V8 isolate (no Node APIs, no secrets). The
     * plugin's source is read and handed to scripts/plugin-sandbox.js; the returned
     * handle is adapted to the IPlugin interface so the rest of the manager is
     * agnostic to how the plugin runs. If isolation is unavailable on this platform
     * we FAIL CLOSED (never run untrusted code in-process).
     */
    private async loadSandboxedPlugin(
        entryName: string,
        filePath: string,
        entryConfig: PluginConfigEntry | undefined
    ): Promise<void> {
        if (filePath.endsWith('.jsc')) {
            throw new Error(`Sandboxed plugin "${entryName}" must ship JavaScript source (.js), not bytecode (.jsc)`)
        }

        // Marketplace-sourced plugins are vouched for by the SIGNED catalog up in
        // loadPluginFile (before this runs), so both the sandboxed and Trusted-Mode
        // paths are covered by the same fail-closed check.

        let createPluginSandbox: CreatePluginSandbox
        try {
            // Lazy-require: isolated-vm is a native module. If it can't load here,
            // refuse the plugin rather than run untrusted code unsandboxed.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            ;({ createPluginSandbox } = require('../../scripts/plugin-sandbox') as { createPluginSandbox: CreatePluginSandbox })
        } catch (error) {
            this.bot.logger.warn(
                'main',
                'PLUGIN-MANAGER',
                `Plugin isolation is unavailable (${error instanceof Error ? error.message : String(error)}); refusing to load untrusted plugin "${entryName}" unsandboxed`
            )
            return
        }

        const pluginConfig = entryConfig?.config ?? {}
        const source = fs.readFileSync(filePath, 'utf-8')
        const sandbox = await createPluginSandbox({
            source,
            config: pluginConfig,
            apiVersion: PLUGIN_API_VERSION,
            log: this.createLogger(),
            memoryLimitMb: 64,
            timeoutMs: 5000
        })

        if (typeof sandbox.name !== 'string' || typeof sandbox.version !== 'string') {
            sandbox.dispose()
            throw new Error(`Sandboxed plugin "${entryName}" must export string { name, version }`)
        }
        if (sandbox.name !== entryName) {
            sandbox.dispose()
            throw new Error(`Plugin name "${sandbox.name}" must match configured entry "${entryName}"`)
        }

        // Circuit breaker: if a sandboxed plugin repeatedly throws or times out, disable
        // it for the rest of the run so a flaky/hostile plugin cannot stall the bot.
        // (Catastrophic V8 OOM crashes are a separate, harder problem — see the child-
        // process hosting follow-up; this handles the recoverable failure modes.)
        const breaker = { failures: 0, tripped: false }
        const MAX_FAILURES = 3
        const guard = (action: string, run: () => Promise<void>): Promise<void> => {
            if (breaker.tripped) return Promise.resolve()
            return run().catch((error: unknown) => {
                breaker.failures += 1
                const message = error instanceof Error ? error.message : String(error)
                this.bot.logger.warn(
                    'main',
                    'PLUGIN-MANAGER',
                    `Sandboxed plugin "${entryName}" ${action} failed (${breaker.failures}/${MAX_FAILURES}): ${message}`
                )
                if (breaker.failures >= MAX_FAILURES && !breaker.tripped) {
                    breaker.tripped = true
                    this.bot.logger.error(
                        'main',
                        'PLUGIN-MANAGER',
                        `Sandboxed plugin "${entryName}" disabled after ${MAX_FAILURES} failures`
                    )
                    try { sandbox.dispose() } catch {}
                }
            })
        }

        const adapter: IPlugin = {
            name: sandbox.name,
            version: sandbox.version,
            register: () => {}, // registration already ran inside the isolate
            destroy: () => sandbox.dispose()
        }
        if (sandbox.hooks.onBotInitialized) {
            adapter.onBotInitialized = () => guard('onBotInitialized', () => sandbox.runLifecycle('onBotInitialized'))
        }
        if (sandbox.hooks.onAccountStart) {
            adapter.onAccountStart = context =>
                guard('onAccountStart', () => sandbox.runLifecycle('onAccountStart', { email: this.tokenizeAccount(context.email) }))
        }
        if (sandbox.hooks.onAccountEnd) {
            adapter.onAccountEnd = context =>
                guard('onAccountEnd', () =>
                    sandbox.runLifecycle('onAccountEnd', {
                        email: this.tokenizeAccount(context.email),
                        result: { ...context.result, email: this.tokenizeAccount(context.result.email) }
                    })
                )
        }

        // Forward host notifications into the isolate so the plugin's own sinks fire.
        if (sandbox.sinkCount > 0) {
            this.notificationSinks.push(notification => guard('notify', () => sandbox.emitNotification(notification)))
        }

        this.plugins.push(adapter)
        this.pluginConfigs.set(adapter, pluginConfig)
        this.sandboxedPlugins.add(adapter)

        if (cluster.isPrimary) {
            this.bot.logger.info('main', 'PLUGIN-MANAGER', `Registered sandboxed plugin: ${adapter.name}@${adapter.version}`)
        }
    }

    /**
     * Enforce marketplace trust for a `source: 'marketplace'` plugin: the signed
     * catalog must verify (signature + freshness), list this plugin with a pinned
     * sha256 that matches the on-disk file, and not have revoked it. Throws (fail
     * closed) on any failure — the caller's catch skips the plugin.
     */
    private assertMarketplaceTrust(entryName: string, filePath: string, entryConfig: PluginConfigEntry | undefined): void {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mp = require('../../scripts/security/marketplace-catalog') as {
            verifyMarketplaceCatalog(options: { root?: string; keysDir?: string }): {
                ok: boolean
                reason?: string
                catalog?: unknown
                expired?: boolean
            }
            findEntry(catalog: unknown, name: string, version?: string): { sha256?: string; version?: string } | undefined
            isRevoked(catalog: unknown, opts: { name?: string; version?: string; sha256?: string }): boolean
        }

        const result = mp.verifyMarketplaceCatalog({
            root: process.cwd(),
            keysDir: process.env.MSRB_MARKETPLACE_KEYS_DIR || undefined
        })
        if (!result.ok) {
            throw new Error(`marketplace catalog is not trusted (${result.reason}); refusing "${entryName}"`)
        }
        if (result.expired) {
            throw new Error(`marketplace catalog is stale; refusing "${entryName}"`)
        }
        const entry = mp.findEntry(result.catalog, entryName, entryConfig?.version)
        if (!entry || !entry.sha256) {
            throw new Error(`"${entryName}" is not pinned in the signed marketplace catalog`)
        }
        const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        if (fileHash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
            throw new Error(`"${entryName}" sha256 does not match the signed marketplace catalog`)
        }
        if (mp.isRevoked(result.catalog, { name: entryName, version: entry.version, sha256: entry.sha256 })) {
            throw new Error(`"${entryName}" is revoked by the marketplace catalog`)
        }
    }

    /**
     * Stable opaque token for an account email so untrusted (sandboxed) plugins can
     * correlate per-account state within a run WITHOUT receiving PII. The HMAC key is
     * random per process, so tokens are not linkable across runs/installs. Trusted
     * in-process plugins keep receiving the real email (unchanged public contract).
     */
    private tokenizeAccount(email: string): string {
        return 'acct_' + crypto.createHmac('sha256', this.sandboxAccountKey).update(String(email ?? '')).digest('hex').slice(0, 16)
    }

    private isVerifiedOfficialCore(entryName: string, filePath: string): boolean {
        if (entryName !== 'core' || !['index.jsc', 'index.js'].includes(path.basename(filePath))) {
            return false
        }

        const manifestPath = path.resolve(process.cwd(), 'plugins', 'official-core.json')
        const signaturePath = path.resolve(process.cwd(), 'plugins', 'official-core.sig')
        const publicKeyPath = path.resolve(process.cwd(), 'scripts', 'security', 'core-public-key.pem')
        if (!fs.existsSync(manifestPath)) {
            throw new Error('Official Core manifest missing: plugins/official-core.json')
        }
        if (!fs.existsSync(signaturePath) || !fs.existsSync(publicKeyPath)) {
            throw new Error('Official Core signature or public key is missing')
        }

        const manifestPayload = fs.readFileSync(manifestPath)
        const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64')
        const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath, 'utf8'))
        if (
            signature.length !== 64 ||
            publicKey.asymmetricKeyType !== 'ed25519' ||
            !crypto.verify(null, manifestPayload, publicKey, signature)
        ) {
            throw new Error('Official Core manifest signature verification failed')
        }

        const manifest = JSON.parse(manifestPayload.toString('utf8')) as OfficialCoreManifest
        if (manifest.plugin !== 'core') {
            throw new Error('Official Core manifest is invalid')
        }

        const target = this.resolveOfficialCoreTarget(filePath)
        if (!target?.indexSha256) {
            throw new Error(`Official Core manifest does not contain target ${this.currentCoreTargetId()}`)
        }

        const bytecodePath = this.resolveOfficialCoreBytecodePath(filePath)
        const fileHash = crypto.createHash('sha256').update(fs.readFileSync(bytecodePath)).digest('hex')
        if (fileHash.toLowerCase() !== target.indexSha256.toLowerCase()) {
            throw new Error('Official Core bytecode checksum mismatch')
        }

        return true
    }

    private assertBytecodeTarget(entryName: string, filePath: string): void {
        if (entryName !== 'core' || !['index.jsc', 'index.js'].includes(path.basename(filePath))) {
            return
        }

        const packagePath = path.join(path.dirname(filePath), 'package.json')
        const packageManifest = this.readJsonFile<PluginPackageManifest>(packagePath)
        const target = this.resolveOfficialCoreTarget(filePath) ?? {
            bytecodeTarget: packageManifest?.msrb?.bytecodeTarget
        }
        const requiredNode = target?.bytecodeTarget?.node ?? packageManifest?.engines?.node
        if (requiredNode && requiredNode !== process.versions.node) {
            throw new Error(
                `Official Core bytecode requires Node.js ${requiredNode}; current runtime is ${process.versions.node}`
            )
        }

        if (target?.bytecodeTarget?.platform && target.bytecodeTarget.platform !== process.platform) {
            throw new Error(
                `Official Core bytecode was built for ${target.bytecodeTarget.platform}/${target.bytecodeTarget.arch ?? 'unknown'}; current runtime is ${process.platform}/${process.arch}`
            )
        }

        if (target?.bytecodeTarget?.arch && target.bytecodeTarget.arch !== process.arch) {
            throw new Error(
                `Official Core bytecode was built for ${target.bytecodeTarget.platform ?? 'unknown'}/${target.bytecodeTarget.arch}; current runtime is ${process.platform}/${process.arch}`
            )
        }
    }

    private isOfficialCoreLoader(entryName: string, filePath: string): boolean {
        return entryName === 'core' && path.basename(filePath) === 'index.js'
    }

    private currentCoreTargetId(): string {
        return `${process.platform}-${process.arch}-node-${process.versions.node}`
    }

    private resolveOfficialCoreTarget(filePath: string): OfficialCoreTarget | undefined {
        const packagePath = path.join(path.dirname(filePath), 'package.json')
        const packageManifest = this.readJsonFile<PluginPackageManifest>(packagePath)
        const officialManifest = this.readJsonFile<OfficialCoreManifest>(
            path.resolve(process.cwd(), 'plugins', 'official-core.json')
        )
        const targetId = this.currentCoreTargetId()
        const manifestTarget = officialManifest?.targets?.[targetId]
        const packageTarget = packageManifest?.msrb?.targets?.[targetId]
        if (manifestTarget || packageTarget) {
            return {
                ...packageTarget,
                ...manifestTarget,
                bytecodeTarget: manifestTarget?.bytecodeTarget ?? packageTarget?.bytecodeTarget
            }
        }
        if (officialManifest?.indexSha256 || officialManifest?.bytecodeTarget) {
            return {
                indexSha256: officialManifest.indexSha256,
                bytecodeTarget: officialManifest.bytecodeTarget
            }
        }
        if (packageManifest?.msrb?.indexSha256 || packageManifest?.msrb?.bytecodeTarget) {
            return {
                indexSha256: packageManifest.msrb.indexSha256,
                bytecodeTarget: packageManifest.msrb.bytecodeTarget
            }
        }
        return undefined
    }

    private resolveOfficialCoreBytecodePath(filePath: string): string {
        if (path.basename(filePath) === 'index.jsc') return filePath
        const targetPath = path.join(path.dirname(filePath), 'targets', this.currentCoreTargetId(), 'index.jsc')
        if (!fs.existsSync(targetPath)) {
            throw new Error(`Official Core bytecode target missing: ${this.currentCoreTargetId()}`)
        }
        return targetPath
    }

    private readJsonFile<T>(filePath: string): T | undefined {
        if (!fs.existsSync(filePath)) {
            return undefined
        }

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
        } catch {
            return undefined
        }
    }

    private createPublicPluginContext(pluginConfig: Record<string, unknown>): PublicPluginContext {
        const logger = this.createLogger()

        return {
            apiVersion: PLUGIN_API_VERSION,
            config: pluginConfig,
            log: logger,
            registerSelectors: (selectors: Record<string, Record<string, unknown>>) => {
                Object.assign(this.registeredSelectors, selectors)
            },
            registerDiagnostics: (provider: PluginDiagnosticsProvider) => {
                this.diagnosticsProviders.push(provider)
            },
            registerNotificationSink: (sink: PluginNotificationSink) => {
                this.notificationSinks.push(sink)
            }
        }
    }

    private createOfficialCoreContext(pluginConfig: Record<string, unknown>): OfficialCoreContext {
        return {
            ...this.createPublicPluginContext(pluginConfig),
            bot: this.bot,
            registerPremiumTasks: (tasks: Partial<PremiumTaskMap>) => {
                Object.assign(this.registeredTasks, tasks)
            },
            grantOfficialCoreEntitlement: () => {
                this.officialCoreEntitlement = true
            }
        }
    }

    private createLifecycleContext(plugin: IPlugin) {
        const base = {
            apiVersion: PLUGIN_API_VERSION as typeof PLUGIN_API_VERSION,
            config: this.pluginConfigs.get(plugin) ?? {},
            log: this.createLogger()
        }

        if (this.officialCorePlugins.has(plugin)) {
            return { ...base, bot: this.bot }
        }

        return base
    }

    private createLogger(): PluginLogger {
        return {
            info: (source, tag, message, color?) =>
                this.bot.logger.info(
                    source,
                    tag,
                    message,
                    color as 'green' | 'yellow' | 'red' | 'blue' | 'cyan' | 'magenta' | 'gray' | undefined
                ),
            warn: (source, tag, message) => this.bot.logger.warn(source, tag, message),
            error: (source, tag, message) => this.bot.logger.error(source, tag, message),
            debug: (source, tag, message) => this.bot.logger.debug(source, tag, message)
        }
    }
}
