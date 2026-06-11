import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import readline from 'readline'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import AutomationUtils from './automation/AutomationUtils'
import BrowserManager from './automation/BrowserManager'
import { DESKTOP_BROWSER_VIEWPORT } from './automation/BrowserViewport'
import PageController from './automation/PageController'

import { loadAccounts, loadConfig } from './helpers/ConfigLoader'
import Helpers from './helpers/Helpers'
import { getPackageMetadata } from './helpers/PackageMetadata'
import { checkNodeVersion } from './helpers/SchemaValidator'
import { IpcLog, LogService } from './notifications/LogService'

import { AuthManager } from './automation/auth/AuthManager'
import { executionContext, getCurrentContext } from './context/ExecutionContext'
import ActivityRunner from './core/ActivityRunner'
import { SearchOrchestrator } from './core/SearchOrchestrator'
import { TaskBase } from './core/TaskBase'

import type { AppliedCoupon, DashboardInfo } from './core/InternalPluginAPI'
import { PluginManager } from './core/PluginManager'
import { checkSafetyAdvisory } from './core/SafetyAdvisory'
import { formatScheduledRun, getNextScheduledRun, isSchedulerEnabled, waitUntil } from './core/Scheduler'
import {
    AgentRuntime,
    attachToAgent,
    confirmReplaceExistingAgent,
    isAgentActive,
    stopExistingAgent
} from './core/AgentRuntime'
import {
    ACCOUNT_SAFETY_WARNING_THRESHOLD,
    clearAccountSafetyWarningState,
    createAccountSafetyWarningState,
    isAccountSafetyWarningSuppressed,
    readAccountSafetyWarningState,
    writeAccountSafetyWarningState
} from './helpers/AccountSafetyWarning'
import HttpClient from './helpers/HttpClient'
import { flushDiscordQueue, sendDiscord, sendDiscordEmbed } from './notifications/DiscordWebhook'
import { flushNtfyQueue, sendNtfy } from './notifications/NtfyWebhook'
import type { Account } from './types/Account'
import type { AppDashboardData } from './types/AppDashboardData'
import type { DashboardLog } from './types/Dashboard'
import type { DashboardData } from './types/DashboardData'

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
    coreStats?: CoreRunStats
}

interface CoreRunStats {
    claimPoints: number
    couponsAvailable: number
    couponsApplied: number
    couponPointsDiscount: number
    coupons: AppliedCoupon[]
    featuresUsed: string[]
}

// Re-exported so callers that already import from this module keep working
export { executionContext, getCurrentContext }

const pkg = getPackageMetadata()

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs)])
}

function createEmptyCoreRunStats(): CoreRunStats {
    return {
        claimPoints: 0,
        couponsAvailable: 0,
        couponsApplied: 0,
        couponPointsDiscount: 0,
        coupons: [],
        featuresUsed: []
    }
}

function addCoreFeature(stats: CoreRunStats, feature: string): void {
    if (!stats.featuresUsed.includes(feature)) {
        stats.featuresUsed.push(feature)
    }
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
    dashboardInfo: DashboardInfo | null
    coreStats: CoreRunStats
}

export class MicrosoftRewardsBot {
    public readonly appVersion = pkg.version
    public logger: LogService
    public config
    public utils: Helpers
    public activities: ActivityRunner = new ActivityRunner(this)
    public pluginManager: PluginManager = new PluginManager(this)
    public browser: { func: PageController; utils: AutomationUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders
    public dashboardEvents: DashboardLog[] = []
    public dashboardRunState: 'idle' | 'checking' | 'running' | 'waiting' | 'finished' | 'blocked' | 'error' = 'idle'
    public dashboardStopRequested = false
    public agentRuntime: AgentRuntime = new AgentRuntime()

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: BrowserManager = new BrowserManager(this)

    async closeAllBrowsers(): Promise<void> {
        await this.browserFactory.closeAll()
    }
    private accounts: Account[]
    private workers: TaskBase
    private login = new AuthManager(this)
    private searchManager: SearchOrchestrator

    public axios!: HttpClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            dashboardInfo: null,
            coreStats: createEmptyCoreRunStats()
        }
        this.logger = new LogService(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Helpers()
        this.workers = new TaskBase(this)
        this.searchManager = new SearchOrchestrator(this)
        this.browser = {
            func: new PageController(this),
            utils: new AutomationUtils(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    pushDashboardLog(entry: DashboardLog): void {
        this.dashboardEvents.push(entry)
        if (this.dashboardEvents.length > 500) {
            this.dashboardEvents.splice(0, this.dashboardEvents.length - 500)
        }
        this.agentRuntime.publishLog(entry)
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        await this.warnIfTooManyAccounts()

        // Load plugins from plugins/ directory
        await this.pluginManager.loadPlugins()
        this.configureActionPacing()

        // Install plugin-registered tasks into ActivityRunner
        const tasks = this.pluginManager.getRegisteredTasks()
        this.activities.installPremiumTasks(tasks)

        // Notify plugins that bot is initialized
        await this.pluginManager.notifyBotInitialized()
    }

    private configureActionPacing(): void {
        if (!this.pluginManager.hasOfficialCoreEntitlement()) {
            this.utils.setRandomDelayMultiplier(4)
        }
    }

    async run(): Promise<number> {
        const enabledAccounts = this.accounts.filter(account => account.enabled !== false)
        const totalAccounts = enabledAccounts.length
        const runStartTime = Date.now()

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.logRunStart(totalAccounts)
                return this.runMaster(enabledAccounts, runStartTime)
            } else {
                this.runWorker(runStartTime)
                return 0
            }
        } else {
            this.logRunStart(totalAccounts)
            await this.runTasks(enabledAccounts, runStartTime)
            return 0
        }
    }

    private logRunStart(totalAccounts: number): void {
        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )
    }

    private async warnIfTooManyAccounts(): Promise<void> {
        if (this.accounts.length <= ACCOUNT_SAFETY_WARNING_THRESHOLD || cluster.isWorker) return

        const storedWarningState = await readAccountSafetyWarningState()
        if (isAccountSafetyWarningSuppressed(storedWarningState)) return
        if (storedWarningState) {
            await clearAccountSafetyWarningState().catch(() => {})
        }

        this.logger.warn(
            'main',
            'ACCOUNT-SAFETY',
            `You have configured ${this.accounts.length} accounts. Running more than 4 accounts is strongly discouraged and may increase account risk.`
        )

        const schedulerEnabled = isSchedulerEnabled(this.config.scheduler)

        if (!process.stdin.isTTY) {
            if (schedulerEnabled) {
                try {
                    await writeAccountSafetyWarningState(createAccountSafetyWarningState(new Date(), 'permanent'))
                    this.logger.warn(
                        'main',
                        'ACCOUNT-SAFETY',
                        'Scheduler is enabled. This warning will stay hidden on future runs.'
                    )
                } catch (error) {
                    this.logger.warn(
                        'main',
                        'ACCOUNT-SAFETY',
                        `Could not save warning suppression state: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            this.logger.warn('main', 'ACCOUNT-SAFETY', 'Continuing in non-interactive mode.')
            return
        }

        const shouldDismiss = await this.promptAccountSafetyWarning(schedulerEnabled)
        if (!shouldDismiss) return

        try {
            await writeAccountSafetyWarningState(
                createAccountSafetyWarningState(new Date(), schedulerEnabled ? 'permanent' : 'temporary')
            )
        } catch (error) {
            this.logger.warn(
                'main',
                'ACCOUNT-SAFETY',
                `Could not save warning suppression state: ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        this.logger.warn(
            'main',
            'ACCOUNT-SAFETY',
            schedulerEnabled
                ? 'This warning will stay hidden while the scheduler is enabled.'
                : 'This warning will stay hidden for 30 days.'
        )
    }

    private async promptAccountSafetyWarning(schedulerEnabled: boolean): Promise<boolean> {
        const prompt = schedulerEnabled
            ? 'Type "don\'t show again" to hide this warning permanently while the scheduler is enabled, or press Enter to continue once. '
            : 'Type "don\'t show again" to hide this warning for 30 days, or press Enter to continue once. '

        const answer = await new Promise<string>(resolve => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            rl.question(prompt, value => {
                rl.close()
                resolve(value)
            })
        })

        const normalizedAnswer = this.utils.normalizeString(answer).replace(/\s+/g, ' ')
        return (
            normalizedAnswer === 'dont show again' ||
            normalizedAnswer === 'do not show again' ||
            normalizedAnswer === 'no longer show' ||
            normalizedAnswer === 'never show again'
        )
    }

    private runMaster(accounts: Account[], runStartTime: number): Promise<number> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []

        if (accountChunks.length === 0) {
            this.logger.warn('main', 'CLUSTER-PRIMARY', 'No account chunks to process')
            return Promise.resolve(0)
        }

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog

                if (log && typeof log.content === 'string') {
                    const config = this.config
                    const webhook = config.webhook
                    const content = log.content
                    const level = log.level
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })
        }

        return new Promise(resolve => {
            const onWorkerDone = async (label: 'exit' | 'disconnect', worker: Worker, code?: number): Promise<void> => {
                const { pid } = worker.process
                this.activeWorkers -= 1

                if (!pid || this.exitedWorkers.includes(pid)) {
                    return
                } else {
                    this.exitedWorkers.push(pid)
                }

                this.logger.warn(
                    'main',
                    `CLUSTER-WORKER-${label.toUpperCase()}`,
                    `Worker ${worker.process?.pid ?? '?'} ${label} | Code: ${code ?? 'n/a'} | Active workers: ${this.activeWorkers}`
                )
                if (this.activeWorkers <= 0) {
                    const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                    const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                    const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                    const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                    this.logger.info(
                        'main',
                        'RUN-END',
                        `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                        'green'
                    )
                    await this.pluginManager.notify({
                        title: 'Run complete',
                        message: `Processed ${allAccountStats.length} account(s), collected +${totalCollectedPoints} points in ${totalDurationMinutes}min.`,
                        level: 'info'
                    })
                    await this.sendRunSummary(allAccountStats, runStartTime)
                    await flushAllWebhooks()
                    resolve(code ?? 0)
                }
            }

            cluster.on('exit', (worker, code) => {
                void onWorkerDone('exit', worker, code)
            })
            cluster.on('disconnect', worker => {
                void onWorkerDone('disconnect', worker, undefined)
            })
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)
        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} account(s) — launching browser, please wait...`
            )
            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())
                if (process.send) {
                    process.send({ __stats: stats })
                }

                process.disconnect()
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )
                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
                )

                await this.pluginManager.notifyAccountStart(accountEmail)

                this.axios = new HttpClient(account.proxy)

                const result:
                    | { initialPoints: number; collectedPoints: number; coreStats: CoreRunStats }
                    | undefined = await this.Main(account).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true,
                        coreStats: result.coreStats
                    })

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
                        'green'
                    )

                    await this.pluginManager.notifyAccountEnd(accountEmail, {
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true
                    })
                } else {
                    const failedResult = {
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    }
                    accountStats.push({
                        ...failedResult
                    })
                    await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const failedResult = {
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                }
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    ...failedResult
                })
                await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)
            }
        }

        if (this.config.clusters <= 1 && !cluster.isWorker) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )

            await this.pluginManager.notify({
                title: 'Run complete',
                message: `Processed ${accountStats.length} account(s), collected +${totalCollectedPoints} points in ${totalDurationMinutes}min.`,
                level: 'info'
            })

            await this.sendRunSummary(accountStats, runStartTime)
            await flushAllWebhooks()
        }

        return accountStats
    }

    private async sendRunSummary(accountStats: AccountStats[], runStartTime: number): Promise<void> {
        const summaryConfig = this.config.webhook.runSummary
        if (!summaryConfig?.enabled || cluster.isWorker) return

        const includeCoreComparison =
            summaryConfig.includeCoreComparison ?? summaryConfig.includeCorePitch ?? true
        const message = this.buildRunSummaryMessage(accountStats, runStartTime, includeCoreComparison)

        const sends: Promise<void>[] = []
        if (summaryConfig.discordUrl) {
            sends.push(
                sendDiscordEmbed(
                    summaryConfig.discordUrl,
                    this.buildRunSummaryEmbed(accountStats, runStartTime, includeCoreComparison)
                )
            )
        }
        if (this.config.webhook.ntfy?.enabled && this.config.webhook.ntfy.url) {
            sends.push(sendNtfy(this.config.webhook.ntfy, message, 'info'))
        }

        await Promise.allSettled(sends)
    }

    private buildRunSummaryEmbed(
        accountStats: AccountStats[],
        runStartTime: number,
        includeCoreComparison: boolean
    ) {
        const totalCollectedPoints = accountStats.reduce((sum, stats) => sum + stats.collectedPoints, 0)
        const successfulAccounts = accountStats.filter(stats => stats.success).length
        const failedAccounts = accountStats.length - successfulAccounts
        const totalInitialPoints = accountStats.reduce((sum, stats) => sum + stats.initialPoints, 0)
        const totalFinalPoints = accountStats.reduce((sum, stats) => sum + stats.finalPoints, 0)
        const runtimeMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
        const coreStats = this.aggregateCoreStats(accountStats)
        const hasCore = this.pluginManager.hasOfficialCoreEntitlement()
        const accountFields = accountStats.slice(0, 20).map(stats => {
            const accountCore = stats.coreStats
            const coreLine =
                accountCore && (accountCore.claimPoints || accountCore.couponsApplied)
                    ? `\nCore: +${accountCore.claimPoints} claimed | ${accountCore.couponsApplied} coupon(s)`
                    : ''
            return {
                name: `${stats.success ? 'Completed' : 'Failed'} - ${stats.email}`.slice(0, 256),
                value: stats.success
                    ? `**+${stats.collectedPoints} points**\n${stats.initialPoints} -> ${stats.finalPoints} | ${(stats.duration / 60).toFixed(1)} min${coreLine}`
                    : `**Run failed**\n${String(stats.error || 'Unknown error').slice(0, 500)}`,
                inline: true
            }
        })

        const fields = [
            {
                name: 'Run totals',
                value: `**${successfulAccounts}/${accountStats.length} accounts completed**\n+${totalCollectedPoints} points | ${totalInitialPoints} -> ${totalFinalPoints}\nRuntime: ${runtimeMinutes} min`,
                inline: false
            },
            ...accountFields
        ]

        if (includeCoreComparison) {
            fields.push({
                name: hasCore ? 'Core impact' : 'Core comparison',
                value: hasCore
                    ? `+${coreStats.claimPoints} dashboard points claimed\n${coreStats.couponsApplied}/${coreStats.couponsAvailable} coupons handled\n${coreStats.couponPointsDiscount} estimated coupon-discount points`
                    : 'Core was inactive. Ready-to-claim dashboard points, coupon handling, app rewards, streak details, goals, punchcards, and remote control were not included.',
                inline: false
            })
            if (hasCore && coreStats.coupons.length) {
                fields.push({
                    name: 'Coupons handled',
                    value: this.formatCouponSummary(coreStats.coupons).slice(0, 1024),
                    inline: false
                })
            }
        }

        if (accountStats.length > 20) {
            fields.push({
                name: 'Additional accounts',
                value: `${accountStats.length - 20} more account(s) are included in the totals above.`,
                inline: false
            })
        }

        return {
            title: failedAccounts ? 'Rewards run completed with warnings' : 'Rewards run complete',
            description: failedAccounts
                ? `${failedAccounts} account(s) require attention.`
                : 'All configured accounts finished successfully.',
            color: failedAccounts ? 0xf7c85c : 0x2fd27d,
            fields,
            footer: { text: 'Microsoft Rewards Bot - local run summary' },
            timestamp: new Date().toISOString()
        }
    }

    private buildRunSummaryMessage(
        accountStats: AccountStats[],
        runStartTime: number,
        includeCoreComparison: boolean
    ): string {
        const totalAccounts = accountStats.length
        const successfulAccounts = accountStats.filter(s => s.success).length
        const failedAccounts = totalAccounts - successfulAccounts
        const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
        const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
        const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
        const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
        const coreStats = this.aggregateCoreStats(accountStats)
        const hasCore = this.pluginManager.hasOfficialCoreEntitlement()

        const lines = [
            'Microsoft Rewards Bot run complete',
            `Accounts: ${totalAccounts} | Success: ${successfulAccounts} | Failed: ${failedAccounts}`,
            `Points collected: +${totalCollectedPoints}`,
            `Balance: ${totalInitialPoints} -> ${totalFinalPoints}`,
            `Runtime: ${totalDurationMinutes}min`
        ]

        if (includeCoreComparison) {
            if (hasCore) {
                lines.push(
                    `Core impact: +${coreStats.claimPoints} claimed points | ${coreStats.couponsApplied}/${coreStats.couponsAvailable} coupon(s) handled | ${coreStats.couponPointsDiscount} estimated coupon-discount points`
                )
                if (coreStats.coupons.length) {
                    lines.push(`Core coupons: ${this.formatCouponSummary(coreStats.coupons)}`)
                }
                lines.push(
                    `Core features used: ${coreStats.featuresUsed.length ? coreStats.featuresUsed.join(', ') : 'none available this run'}`
                )
            } else {
                lines.push(
                    'Core inactive: premium dashboard scan unavailable, so ready-to-claim points and coupon savings were not handled.'
                )
                lines.push(
                    'With Core, this summary can include claimed dashboard points, applied coupon names, coupon savings, app rewards, streak details, goals, punchcards, and remote dashboard control.'
                )
            }
        }

        return lines.join('\n')
    }

    private aggregateCoreStats(accountStats: AccountStats[]): CoreRunStats {
        const aggregate = createEmptyCoreRunStats()
        for (const account of accountStats) {
            const stats = account.coreStats
            if (!stats) continue
            aggregate.claimPoints += stats.claimPoints
            aggregate.couponsAvailable += stats.couponsAvailable
            aggregate.couponsApplied += stats.couponsApplied
            aggregate.couponPointsDiscount += stats.couponPointsDiscount
            aggregate.coupons.push(...stats.coupons)
            for (const feature of stats.featuresUsed) {
                addCoreFeature(aggregate, feature)
            }
        }
        return aggregate
    }

    private formatCouponSummary(coupons: AppliedCoupon[]): string {
        const visibleCoupons = coupons.slice(0, 5).map(coupon => {
            const title = coupon.title || 'coupon'
            const discount = coupon.pointsDiscount !== null ? `${coupon.pointsDiscount} pts` : 'discount unknown'
            const expires = coupon.expiresText ? `, ${coupon.expiresText}` : ''
            return `${title} (${discount}${expires})`
        })

        const remaining = coupons.length - visibleCoupons.length
        return remaining > 0 ? `${visibleCoupons.join('; ')}; +${remaining} more` : visibleCoupons.join('; ')
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number; coreStats: CoreRunStats }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)
        this.userData.coreStats = createEmptyCoreRunStats()

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                // Keep a full desktop-sized visual surface even when the run uses mobile attribution.
                await this.mainMobilePage.setViewportSize(DESKTOP_BROWSER_VIEWPORT)

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                const needsAppAccessToken =
                    this.config.workers.doAppPromotions ||
                    this.config.workers.doDailyCheckIn ||
                    this.config.workers.doReadToEarn

                if (needsAppAccessToken) {
                    try {
                        this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, account)
                    } catch (error) {
                        this.logger.error(
                            'main',
                            'FLOW',
                            `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                } else {
                    this.logger.debug(
                        'main',
                        'GET-APP-TOKEN',
                        'Skipping mobile access token: no app-only workers enabled'
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()

                // Set geo
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`
                    )
                }

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${
                        browserEarnable.mobileSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                if (this.config.workers.doApplyCoupons) {
                    const couponResult = await this.activities.doApplyCoupons(this.mainMobilePage)
                    this.userData.coreStats.couponsAvailable += couponResult.available
                    this.userData.coreStats.couponsApplied += couponResult.applied
                    this.userData.coreStats.couponPointsDiscount += couponResult.totalPointsDiscount
                    this.userData.coreStats.coupons.push(...couponResult.coupons)
                    if (couponResult.applied > 0) {
                        addCoreFeature(this.userData.coreStats, 'Coupons')
                        this.logger.info(
                            'main',
                            'COUPONS',
                            `Applied ${couponResult.applied}/${couponResult.available} coupon(s) | Estimated discount: ${couponResult.totalPointsDiscount} points`
                        )
                    }
                }

                // Claim ready dashboard points before spending time on other activities.
                if (this.config.workers.doClaimPoints) {
                    const claimResult = await this.activities.doClaimPoints(this.mainMobilePage)
                    if (claimResult.claimed) {
                        this.userData.coreStats.claimPoints += claimResult.pointsClaimed
                        addCoreFeature(this.userData.coreStats, 'Claimable point cards')
                        this.logger.info(
                            'main',
                            'CLAIM-POINTS',
                            `Claimed ${claimResult.pointsClaimed} points | Entries: ${claimResult.entries.length}`
                        )
                    }
                }

                // Dashboard Info: collect hero data BEFORE any activities (for before/after comparison)
                if (this.config.workers.doDashboardInfo) {
                    const dashInfo = await this.activities.collectDashboardInfo(this.mainMobilePage)
                    this.userData.dashboardInfo = dashInfo
                }

                if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                if (this.config.workers.doMorePromotions) {
                    await this.workers.doMorePromotions(data, this.mainMobilePage)
                    if (this.pluginManager.hasOfficialCoreEntitlement()) {
                        await this.activities.doTemporaryPunchcards(this.mainMobilePage)
                    }
                }
                if (this.accessToken) {
                    if (this.config.workers.doDailyCheckIn) await this.activities.doDailyCheckIn()
                    if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()
                } else if (this.config.workers.doDailyCheckIn || this.config.workers.doReadToEarn) {
                    this.logger.warn(
                        'main',
                        'APP-ACTIVITIES',
                        'Skipping app-only activities because the mobile access token was not available'
                    )
                }

                // Daily Streak: expand progression, activate protection, read bonus info
                if (this.config.workers.doDailyStreak) {
                    const streakInfo = await this.activities.doDailyStreak(this.mainMobilePage)
                    if (streakInfo) {
                        this.logger.info(
                            'main',
                            'DAILY-STREAK',
                            `Streak: ${streakInfo.streakDays} days | Protection: ${streakInfo.streakProtectionEnabled ? 'ON' : 'OFF'} | Bonus: ${streakInfo.bonusText ?? 'N/A'} (${streakInfo.bonusStarsFilled}/${streakInfo.bonusStarsTotal} stars)`
                        )
                    }
                }

                // Streak protection is managed exclusively by Core. The open-source
                // edition never toggles the user's streak protection switch — when Core
                // is entitled it enables/maintains protection through its own task (which
                // also honours the Core `streakProtection` config flag). Without Core the
                // switch is left untouched.
                if (this.pluginManager.hasOfficialCoreEntitlement()) {
                    await this.activities.syncStreakProtection(this.mainMobilePage, true)
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                // Microsoft's Next.js dashboard no longer exposes the search-point counters,
                // so missingSearchPoints reports 0 and the search manager would skip every
                // search. When the counters are absent, schedule searches with an estimated
                // target — the search task measures real gains from the balance and stops at
                // Microsoft's daily cap, so the estimate only needs to be positive.
                if (!this.browser.func.hasSearchCounters(searchPoints)) {
                    missingSearchPoints.mobilePoints = missingSearchPoints.mobilePoints || 90
                    missingSearchPoints.desktopPoints = missingSearchPoints.desktopPoints || 90
                    this.logger.warn(
                        'main',
                        'POINTS',
                        'Search counters unavailable — scheduling searches with estimated targets (real gains measured by balance)'
                    )
                }

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail
                )

                mobileContextClosed = true

                this.userData.gainedPoints = mobilePoints + desktopPoints

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0,
                    coreStats: this.userData.coreStats
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

async function main(): Promise<void> {
    // Display ASCII art banner
    console.log('\x1b[36m') // Cyan color
    console.log('  ____                            _       ____        _   ')
    console.log(' |  _ \\ _____      ____ _ _ __ __| |___  | __ )  ___ | |_ ')
    console.log(" | |_) / _ \\ \\ /\\ / / _` | '__/ _` / __| |  _ \\ / _ \\| __|")
    console.log(' |  _ <  __/\\ V  V / (_| | | | (_| \\__ \\ | |_) | (_) | |_ ')
    console.log(' |_| \\_\\___| \\_/\\_/ \\__,_|_|  \\__,_|___/ |____/ \\___/ \\__|')
    console.log('\x1b[0m') // Reset color
    console.log(`\x1b[2m v${pkg.version} - Open Source Edition\x1b[0m\n`)

    // Check before doing anything
    checkNodeVersion()

    if (process.argv.includes('--attach')) {
        process.exit(await attachToAgent())
    }

    if (await isAgentActive()) {
        if (process.argv.includes('--stop-existing')) {
            const stopped = await stopExistingAgent()
            if (!stopped) {
                console.error('[AGENT] Existing instance did not stop in time.')
                process.exit(1)
            }
        } else if (await confirmReplaceExistingAgent()) {
            const stopped = await stopExistingAgent()
            if (!stopped) {
                console.error('[AGENT] Existing instance did not stop in time.')
                process.exit(1)
            }
        } else {
            console.log('[AGENT] Existing instance left running. Exiting this launch.')
            process.exit(0)
        }
    }

    const rewardsBot = new MicrosoftRewardsBot()
    rewardsBot.agentRuntime.setRunHandler(() => runSingle(rewardsBot))
    rewardsBot.agentRuntime.setStopHandler(() => {
        rewardsBot.dashboardStopRequested = true
    })

    process.on('beforeExit', () => {
        void rewardsBot.agentRuntime.stop()
        void rewardsBot.pluginManager.destroyAll()
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        if (rewardsBot.config.backgroundAgent?.enabled !== false) {
            await rewardsBot.agentRuntime.start()
        }
        await rewardsBot.initialize()
        if (cluster.isWorker) {
            await rewardsBot.run()
            return
        }

        const exitCode = process.argv.includes('--background') && !isSchedulerEnabled(rewardsBot.config.scheduler)
            ? await runBackgroundAgent(rewardsBot)
            : isSchedulerEnabled(rewardsBot.config.scheduler)
            ? await runScheduled(rewardsBot)
            : await runSingle(rewardsBot)

        await rewardsBot.agentRuntime.stop()
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(exitCode)
    } catch (error) {
        rewardsBot.dashboardRunState = 'error'
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
    }
}

async function runBackgroundAgent(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    if (!rewardsBot.pluginManager.hasOfficialCoreEntitlement()) {
        rewardsBot.logger.warn('main', 'AGENT', 'Background agent requires Core with a valid license.')
        return 0
    }

    rewardsBot.dashboardRunState = 'idle'
    rewardsBot.logger.info('main', 'AGENT', 'Background agent connected. Waiting for dashboard commands.')
    await new Promise<void>(() => undefined)
    return 0
}

async function runSingle(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    rewardsBot.dashboardRunState = 'checking'
    const canRun = await checkSafetyAdvisory(rewardsBot)
    if (!canRun) {
        rewardsBot.dashboardRunState = 'blocked'
        return 1
    }

    rewardsBot.dashboardRunState = 'running'
    const exitCode = await rewardsBot.run()
    rewardsBot.dashboardRunState = exitCode === 0 ? 'finished' : 'error'
    return exitCode
}

async function runScheduled(rewardsBot: MicrosoftRewardsBot): Promise<number> {
    const scheduler = rewardsBot.config.scheduler
    if (!scheduler) return runSingle(rewardsBot)

    rewardsBot.logger.info(
        'main',
        'SCHEDULER',
        `Scheduler enabled | timezone=${scheduler.timezone} | startTime=${scheduler.startTime} | runOnStartup=${scheduler.runOnStartup}`
    )

    let shouldRunNow = scheduler.runOnStartup

    while (true) {
        if (shouldRunNow) {
            const exitCode = await runSingle(rewardsBot)
            if (exitCode !== 0) return exitCode
            if (rewardsBot.dashboardStopRequested) {
                rewardsBot.logger.info(
                    'main',
                    'SCHEDULER',
                    'Remote stop requested. Scheduler will stop after the current run.'
                )
                return 0
            }
        }

        const nextRun = getNextScheduledRun(scheduler)
        rewardsBot.dashboardRunState = 'waiting'
        rewardsBot.logger.info(
            'main',
            'SCHEDULER',
            `Next run scheduled for ${formatScheduledRun(nextRun, scheduler.timezone)}`
        )

        await waitUntil(nextRun.target)
        shouldRunNow = true
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
