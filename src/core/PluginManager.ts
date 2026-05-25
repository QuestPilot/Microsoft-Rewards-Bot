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
    indexSha256: string
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
        bytecodeTarget?: {
            node?: string
            platform?: string
            arch?: string
        }
    }
}

export class PluginManager {
    private bot: MicrosoftRewardsBot
    private plugins: IPlugin[] = []
    private pluginConfigs = new WeakMap<IPlugin, Record<string, unknown>>()
    private officialCorePlugins = new WeakSet<IPlugin>()
    private registeredTasks: Partial<PremiumTaskMap> = {}
    private registeredSelectors: Record<string, Record<string, unknown>> = {}
    private diagnosticsProviders: PluginDiagnosticsProvider[] = []
    private notificationSinks: PluginNotificationSink[] = []
    private officialCoreEntitlement = false

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
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

        const ignoredFiles = new Set(['README.md', 'plugins.jsonc', 'official-core.json', 'catalog.json'])
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
                    await this.loadDirectoryPlugin(entryName, path.join(pluginsDir, entry.name), entryConfig?.config ?? {})
                } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsc')) {
                    await this.loadPluginFile(entryName, path.join(pluginsDir, entry.name), entryConfig?.config ?? {})
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
        pluginConfig: Record<string, unknown>
    ): Promise<void> {
        const jscPath = path.join(dirPath, 'index.jsc')
        const jsPath = path.join(dirPath, 'index.js')

        if (fs.existsSync(jscPath)) {
            await this.loadPluginFile(entryName, jscPath, pluginConfig)
        } else if (fs.existsSync(jsPath)) {
            await this.loadPluginFile(entryName, jsPath, pluginConfig)
        }
    }

    private async loadPluginFile(
        entryName: string,
        filePath: string,
        pluginConfig: Record<string, unknown>
    ): Promise<void> {
        if (filePath.endsWith('.jsc')) {
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

        const isOfficialCore = this.isVerifiedOfficialCore(entryName, filePath)
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

    private isVerifiedOfficialCore(entryName: string, filePath: string): boolean {
        if (entryName !== 'core' || path.basename(filePath) !== 'index.jsc') {
            return false
        }

        const manifestPath = path.resolve(process.cwd(), 'plugins', 'official-core.json')
        if (!fs.existsSync(manifestPath)) {
            throw new Error('Official Core manifest missing: plugins/official-core.json')
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as OfficialCoreManifest
        if (manifest.plugin !== 'core' || typeof manifest.indexSha256 !== 'string') {
            throw new Error('Official Core manifest is invalid')
        }

        const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        if (fileHash.toLowerCase() !== manifest.indexSha256.toLowerCase()) {
            throw new Error('Official Core bytecode checksum mismatch')
        }

        return true
    }

    private assertBytecodeTarget(entryName: string, filePath: string): void {
        if (entryName !== 'core' || path.basename(filePath) !== 'index.jsc') {
            return
        }

        const packagePath = path.join(path.dirname(filePath), 'package.json')
        const packageManifest = this.readJsonFile<PluginPackageManifest>(packagePath)
        const officialManifest = this.readJsonFile<OfficialCoreManifest>(
            path.resolve(process.cwd(), 'plugins', 'official-core.json')
        )

        const target = officialManifest?.bytecodeTarget ?? packageManifest?.msrb?.bytecodeTarget
        const requiredNode = target?.node ?? packageManifest?.engines?.node
        if (requiredNode && requiredNode !== process.versions.node) {
            throw new Error(
                `Official Core bytecode requires Node.js ${requiredNode}; current runtime is ${process.versions.node}`
            )
        }

        if (target?.platform && target.platform !== process.platform) {
            throw new Error(
                `Official Core bytecode was built for ${target.platform}/${target.arch ?? 'unknown'}; current runtime is ${process.platform}/${process.arch}`
            )
        }

        if (target?.arch && target.arch !== process.arch) {
            throw new Error(
                `Official Core bytecode was built for ${target.platform ?? 'unknown'}/${target.arch}; current runtime is ${process.platform}/${process.arch}`
            )
        }
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
