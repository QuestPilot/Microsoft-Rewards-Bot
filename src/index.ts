import childProcess from 'child_process'
import cluster, { Worker } from 'cluster'
import fs from 'fs'
import path from 'path'
import type { BrowserContext, Cookie, Page } from 'patchright'
import readline from 'readline'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import AutomationUtils from './automation/AutomationUtils'
import BrowserManager from './automation/BrowserManager'
import { DESKTOP_BROWSER_VIEWPORT } from './automation/BrowserViewport'
import PageController from './automation/PageController'

import { loadAccounts, loadConfig, resolveConfigPath } from './helpers/ConfigLoader'
import { dataRoot, runDataCleanup } from './helpers/DataManager'
import { markDirHidden } from './helpers/HiddenDir'
import Helpers from './helpers/Helpers'
import { readAccountSummary, recordAccountBan, recordAccountRun, recordRunComplete } from './helpers/StatsRecorder'
import { AvatarFetcher } from './helpers/AvatarFetcher'

import { getPackageMetadata } from './helpers/PackageMetadata'
import { checkNodeVersion } from './helpers/SchemaValidator'
import { IpcLog, LogService } from './notifications/LogService'

import { AuthManager } from './automation/auth/AuthManager'
import { AccountLockedError } from './automation/auth/AuthErrors'
import { executionContext, getCurrentContext } from './context/ExecutionContext'
import ActivityRunner from './core/ActivityRunner'
import { SearchOrchestrator } from './core/SearchOrchestrator'
import { TaskBase } from './core/TaskBase'

import type { AppliedCoupon, DashboardCaptureResult, DashboardInfo } from './core/InternalPluginAPI'
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
import { flushDiscordQueue, sendDiscord } from './notifications/DiscordWebhook'
import { flushNtfyQueue, sendNtfy } from './notifications/NtfyWebhook'
import { AnalyticsService } from './notifications/AnalyticsService'
import { reportError, type ErrorReportInput } from './notifications/ErrorReport'
import type { Account } from './types/Account'
import type { AppDashboardData } from './types/AppDashboardData'
import type { DashboardLog, DashboardVariant } from './types/Dashboard'
import type { DashboardData } from './types/DashboardData'
import type { DashboardActions } from './automation/dashboard/DashboardActions'
import { getDashboardActions } from './automation/dashboard/DashboardActionsFactory'

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface StarBonusInfo {
    activeLevelName: string
    monthlyProgress: number
    monthlyMax: number
    weeklyProgress: number
    weeklyState: string
    levelBonusProgress: number
    levelBonusMax: number
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
    starBonus?: StarBonusInfo
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
    starBonus?: StarBonusInfo
    /** `-getTimezoneOffset()` as a string (e.g. "60"). Used by the legacy report payloads. */
    timezoneOffset: string
}

export class MicrosoftRewardsBot {
    public readonly appVersion = pkg.version
    public readonly runtimeMode: 'normal' | 'harvester'
    public logger: LogService
    public config
    public utils: Helpers
    public activities: ActivityRunner = new ActivityRunner(this)
    public pluginManager: PluginManager = new PluginManager(this, {
        // Real runs pull the signed catalog from production by default so a published
        // plugin reaches the bot automatically (no env var needed). Overridable for
        // local/staging via MSRB_MARKETPLACE_CATALOG_URL. Tests construct their own
        // PluginManager without this, so they stay offline.
        marketplaceCatalogUrl: process.env.MSRB_MARKETPLACE_CATALOG_URL || 'https://bot.lgtw.tf/api/marketplace/catalog'
    })
    public browser: { func: PageController; utils: AutomationUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public accessToken = ''
    public requestToken = ''
    /**
     * Detected Microsoft Rewards dashboard variant per device, resolved once at
     * login (Next.js first, else legacy). `null` until detected → treated as 'next'.
     * Reset between accounts by {@link resetDashboardState}.
     */
    private dashboardVariantByDevice: { mobile: DashboardVariant | null; desktop: DashboardVariant | null } = {
        mobile: null,
        desktop: null
    }
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders
    public dashboardEvents: DashboardLog[] = []
    public dashboardRunState: 'idle' | 'checking' | 'running' | 'waiting' | 'finished' | 'blocked' | 'error' = 'idle'
    public dashboardStopRequested = false
    public agentRuntime: AgentRuntime = new AgentRuntime()

    private pointsCanCollect = 0
    // Public so sibling modules (Search, scheduler/update runners) can emit telemetry.
    public analytics!: AnalyticsService

    private activeWorkers: number
    private exitedWorkers: number[]
    // Public so SearchOrchestrator (a sibling module, not a subclass) can reach these
    // without bypassing access control via bracket-notation (`bot['browserFactory']`).
    public browserFactory: BrowserManager = new BrowserManager(this)

    async closeAllBrowsers(): Promise<void> {
        await this.browserFactory.closeAll()
    }

    private async ensureLiveMobilePage(context: BrowserContext, reason: string): Promise<Page> {
        if (this.mainMobilePage && !this.mainMobilePage.isClosed()) return this.mainMobilePage

        const recoveredPage = context.pages().find(candidate => !candidate.isClosed()) ?? (await context.newPage())
        await recoveredPage.setViewportSize(DESKTOP_BROWSER_VIEWPORT).catch(() => {})
        this.mainMobilePage = recoveredPage
        this.logger.warn('main', 'BROWSER', `Recovered mobile page after ${reason}; previous tab was closed`)
        return recoveredPage
    }

    private accounts: Account[]
    private workers: TaskBase
    public login = new AuthManager(this)
    private searchManager: SearchOrchestrator

    public axios!: HttpClient

    constructor() {
        this.runtimeMode =
            process.argv[2] === 'harvester' || process.env.MSRB_EPHEMERAL_RUN === '1' ? 'harvester' : 'normal'
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            dashboardInfo: null,
            coreStats: createEmptyCoreRunStats(),
            timezoneOffset: String(-new Date().getTimezoneOffset())
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
        this.analytics = new AnalyticsService(!this.isHarvesterMode && (this.config.analytics?.enabled ?? true))
        this.activeWorkers = this.config.core?.clusters ?? 1
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    get isHarvesterMode(): boolean {
        return this.runtimeMode === 'harvester'
    }

    /**
     * The Microsoft Rewards dashboard variant for the current device. Defaults to
     * 'next' until login detection records it (see AuthManager.getRewardsSession).
     */
    get dashboardVariant(): DashboardVariant {
        const detected = this.isMobile ? this.dashboardVariantByDevice.mobile : this.dashboardVariantByDevice.desktop
        return detected ?? 'next'
    }

    /** Record the detected dashboard variant for the current device. */
    setDashboardVariant(variant: DashboardVariant): void {
        if (this.isMobile) this.dashboardVariantByDevice.mobile = variant
        else this.dashboardVariantByDevice.desktop = variant
    }

    /**
     * The variant-specific report strategy (legacy axios vs next Server Action).
     * Tasks call `bot.dashboard.reportActivity(...)` / `reportQuizOnce(...)` and
     * never branch on the variant themselves.
     */
    get dashboard(): DashboardActions {
        return getDashboardActions(this)
    }

    /**
     * Reset per-account dashboard state. Accounts run sequentially in one process,
     * so without this a legacy account after a next account (or vice-versa) would
     * inherit the previous account's variant, CSRF token and "JSON API dead" memo.
     */
    resetDashboardState(): void {
        this.dashboardVariantByDevice = { mobile: null, desktop: null }
        this.requestToken = ''
        this.userData.timezoneOffset = String(-new Date().getTimezoneOffset())
        this.browser.func.resetDashboardApiState()
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
        if (!this.isHarvesterMode) {
            await this.warnIfTooManyAccounts()
            this.logUsageTips()
            this.hideInternalDirs()

            void runDataCleanup(msg => this.logger.debug('main', 'DATA-CLEANUP', msg))
        }

        // Load plugins from plugins/ directory
        await this.pluginManager.loadPlugins()

        // Account-safety: opt-in extra-safe pacing. Multiplies every randomized delay
        // (default 1 = full speed). Lets cautious / large-fleet users slow the bot down.
        this.utils.setRandomDelayMultiplier(this.config.searchSettings.delayMultiplier ?? 1)

        // Install plugin-registered tasks into ActivityRunner
        const tasks = this.pluginManager.getRegisteredTasks()
        this.activities.installPremiumTasks(tasks)

        // Notify plugins that bot is initialized
        await this.pluginManager.notifyBotInitialized()
    }

    async run(): Promise<number> {
        const enabledAccounts = this.accounts.filter(account => account.enabled !== false)
        // Account-safety: randomize order each run (opt-out via searchSettings.shuffleAccounts:false)
        // so the same account isn't always processed first/last. Done here (not in runMaster) so
        // cluster chunks inherit the shuffled order too.
        if (this.config.searchSettings.shuffleAccounts !== false && enabledAccounts.length > 1) {
            this.utils.shuffleArray(enabledAccounts)
        }
        const totalAccounts = enabledAccounts.length
        const runStartTime = Date.now()

        if (!cluster.isWorker) {
            this.analytics.track(
                'run_started',
                this.analytics.withContext({
                    account_count: totalAccounts,
                    clusters: this.config.core?.clusters ?? 1,
                    has_core: this.pluginManager.hasOfficialCoreEntitlement(),
                    // Environment/config snapshot: lets ban rate, zero-point rate and
                    // failure rate be segmented by setup (docker vs desktop, headless,
                    // proxies, scheduler) instead of guessing which configs break.
                    docker: BrowserManager.isDocker(),
                    headless: this.config.headless === true,
                    scheduler_enabled: this.config.scheduler?.enabled === true,
                    accounts_with_proxy: enabledAccounts.filter(a => !!a.proxy?.url).length,
                    workers_enabled: Object.entries(this.config.workers)
                        .filter(([, v]) => v === true)
                        .map(([k]) => k)
                })
            )
        }

        if ((this.config.core?.clusters ?? 1) > 1) {
            if (cluster.isPrimary) {
                this.logRunStart(totalAccounts)
                return this.runMaster(enabledAccounts, runStartTime)
            } else {
                this.runWorker(runStartTime)
                return 0
            }
        } else {
            this.logRunStart(totalAccounts)
            try {
                await this.runTasks(enabledAccounts, runStartTime)
            } catch (error) {
                void this.reportRunError({
                    kind: 'run_fatal',
                    error: error instanceof Error ? error.message : String(error),
                    hasCore: this.pluginManager.hasOfficialCoreEntitlement()
                })
                throw error
            }
            return 0
        }
    }

    private logRunStart(totalAccounts: number): void {
        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.core?.clusters ?? 1}`
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
            `You have configured ${this.accounts.length} accounts. Running more than 6 accounts is strongly discouraged (Household limit is 6) and may increase account risk.`
        )
        this.logger.warn(
            'main',
            'ACCOUNT-SAFETY',
            'For safety, accounts are spaced out and shuffled. The new 2026 anti-bot system is strict. Avoid generic searches to qualify for the Bing Star Bonus, use high-quality mobile proxies like Decodo, and do not use datacenter proxies.'
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

    /**
     * Passive, non-blocking usage tips logged once per run start. Unlike
     * warnIfTooManyAccounts (an interactive prompt gated at 6+ accounts), these
     * catch config-derived ban-risk signals that matter well below that threshold —
     * several accounts sharing this machine's real IP, or an obviously roboticized
     * search cadence, are both real 2026 Bing anti-bot signals regardless of account
     * count. Plain log lines only (never interactive), so the Desk console (which
     * pipes this process's stdout/stderr) and a plain terminal both see them —
     * a Desk-only tip would leave terminal/headless users with no equivalent.
     */
    private logUsageTips(): void {
        if (cluster.isWorker) return

        // A handful of accounts sharing this machine's real IP is normal (a household
        // rarely needs a proxy at all). Only worth a tip once the count is already
        // past the household-limit threshold — same line where warnIfTooManyAccounts
        // starts caring — otherwise this fires on every completely ordinary small setup.
        if (this.accounts.length > ACCOUNT_SAFETY_WARNING_THRESHOLD && this.accounts.every(account => !account.proxy?.url)) {
            this.logger.warn(
                'main',
                'USAGE-TIP',
                `${this.accounts.length} accounts (above the household limit) are all running from this machine's real IP with no proxy configured. Microsoft's 2026 anti-bot system correlates accounts by IP and device signals — consider a mobile proxy per account beyond the household limit, or turn on Strict proxy mode (Settings > Behavior > Browser) to catch any account missing one.`
            )
        }

        try {
            const minDelayMs = this.utils.stringToNumber(this.config.searchSettings.searchDelay.min)
            if (minDelayMs < 8000) {
                this.logger.warn(
                    'main',
                    'USAGE-TIP',
                    `Search delay is set very low (min ${this.config.searchSettings.searchDelay.min}). Fast, consistent-interval searching is one of the timing signals the anti-bot system profiles — widening searchSettings.searchDelay makes each run's cadence look less scripted.`
                )
            }
        } catch {
            // Malformed delay strings are already caught by config validation elsewhere — never let a tip crash the run.
        }
    }

    /**
     * Cosmetic-only, best-effort: mark the bot's internal-state folders as OS-hidden
     * (Windows/macOS) so they don't clutter Explorer/Finder next to the user's own
     * files. Deliberately does NOT rename anything (data/sessions keep their exact
     * names) — a rename would orphan every existing user's saved sessions/stats on
     * update; the hidden ATTRIBUTE achieves the same visual goal with zero path
     * changes and zero migration risk. Safe to call every startup: creating an
     * already-existing dir is a no-op, and re-hiding an already-hidden one is too.
     */
    private hideInternalDirs(): void {
        if (cluster.isWorker) return

        const dirs = [dataRoot(), path.resolve(process.cwd(), this.config.sessionPath || 'sessions'), path.resolve(process.cwd(), '.tools')]
        for (const dir of dirs) {
            try {
                fs.mkdirSync(dir, { recursive: true })
                markDirHidden(dir)
            } catch {
                // Cosmetic only — never let this affect the run.
            }
        }
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

        const rawChunks = this.utils.chunkArray(accounts, this.config.core?.clusters ?? 1)
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

                // Each worker emits BOTH 'disconnect' and 'exit'. Decrement only AFTER the
                // per-pid dedup guard so activeWorkers drops exactly once per unique worker —
                // otherwise it can fall <=0 while a worker is still running, finalizing the
                // run (summary/flush) too early and dropping the in-flight worker's __stats.
                if (!pid || this.exitedWorkers.includes(pid)) {
                    return
                } else {
                    this.exitedWorkers.push(pid)
                }

                this.activeWorkers -= 1

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
                await this.reportRunError({
                    kind: 'run_fatal',
                    error: error instanceof Error ? error.message : String(error),
                    hasCore: this.pluginManager.hasOfficialCoreEntitlement()
                })
                await Promise.allSettled([flushAllWebhooks(), this.analytics.flush()])
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

                // Per-account override of the global kill-switch: 'require' forces strict
                // mode on for this account even if the global setting is off; 'exempt'
                // opts this account out even if the global setting is on. 'auto' (or
                // unset) just follows the global setting.
                const strictProxyOverride = account.strictProxy ?? 'auto'
                const strictProxyForAccount =
                    strictProxyOverride === 'require' ||
                    (strictProxyOverride === 'auto' && this.config.proxy?.strictMode === true)
                if (strictProxyForAccount && !account.proxy?.url) {
                    this.logger.error('main', 'PROXY-STRICT', `Strict proxy mode is enabled, but no proxy is configured for ${accountEmail}. Skipping account to prevent IP leak.`)
                    continue
                }

                this.axios = new HttpClient(account.proxy)

                let mainFlowError = ''
                let banError: AccountLockedError | null = null
                const result:
                    | {
                          initialPoints: number
                          collectedPoints: number
                          searchPointsGained: number
                          countersAvailable: boolean
                          coreStats: CoreRunStats
                          starBonus?: StarBonusInfo
                      }
                    | undefined = await this.Main(account).catch(error => {
                    if (error instanceof AccountLockedError) banError = error
                    mainFlowError = error instanceof Error ? error.message : String(error)
                    void this.logger.error(true, 'FLOW', `Mobile flow failed for ${accountEmail}: ${mainFlowError}`)
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
                        coreStats: result.coreStats,
                        starBonus: result.starBonus
                    })

                    void recordAccountRun({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        durationSeconds: parseFloat(durationSeconds),
                        success: true,
                        coreStats: result.coreStats
                            ? {
                                  claimPoints: result.coreStats.claimPoints,
                                  couponsApplied: result.coreStats.couponsApplied,
                                  couponPointsDiscount: result.coreStats.couponPointsDiscount
                              }
                            : undefined,
                        starBonus: result.starBonus
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

                    this.analytics.track(
                        'account_completed',
                        this.analytics.withContext({
                            success: true,
                            points_gained: collectedPoints,
                            // Diagnostic split for zero-point runs: a 0 balance delta with a
                            // positive search gain means the balance READ failed (measurement
                            // bug); 0 on both means the searches genuinely earned nothing.
                            initial_points: accountInitialPoints,
                            final_points: accountFinalPoints,
                            search_points_gained: result.searchPointsGained,
                            counters_available: result.countersAvailable,
                            duration_ms: Math.round(parseFloat(durationSeconds) * 1000),
                            has_core: this.pluginManager.hasOfficialCoreEntitlement()
                        })
                    )

                    // A run that finished cleanly but earned 0 points is the signature
                    // of the "rewards logged in but Bing search session anonymous" issue.
                    if (collectedPoints <= 0) {
                        void this.reportRunError({
                            kind: 'account_zero_points',
                            email: accountEmail,
                            error: `Run completed but collected 0 points (balance ${accountInitialPoints} → ${accountFinalPoints})`,
                            hasCore: this.pluginManager.hasOfficialCoreEntitlement(),
                            durationSeconds: parseFloat(durationSeconds),
                            analyticsProps: {
                                initial_points: accountInitialPoints,
                                final_points: accountFinalPoints,
                                search_points_gained: result.searchPointsGained,
                                counters_available: result.countersAvailable
                            }
                        })
                    }
                } else {
                    const errorDetail = mainFlowError || 'Flow failed (no error detail captured)'
                    const failedResult = {
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: errorDetail
                    }
                    accountStats.push({
                        ...failedResult
                    })
                    void recordAccountRun({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        durationSeconds: parseFloat(durationSeconds),
                        success: false,
                        error: errorDetail
                    })
                    await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)

                    this.analytics.track(
                        'account_completed',
                        this.analytics.withContext({
                            success: false,
                            points_gained: 0,
                            duration_ms: Math.round(parseFloat(durationSeconds) * 1000),
                            has_core: this.pluginManager.hasOfficialCoreEntitlement()
                        })
                    )
                    if (banError) {
                        void this.reportAccountBanned(account, banError, parseFloat(durationSeconds))
                    } else {
                        void this.reportRunError({
                            kind: 'account_failed',
                            email: accountEmail,
                            error: failedResult.error,
                            hasCore: this.pluginManager.hasOfficialCoreEntitlement(),
                            durationSeconds: parseFloat(durationSeconds)
                        })
                    }
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
                void recordAccountRun({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    durationSeconds: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
                await this.pluginManager.notifyAccountEnd(accountEmail, failedResult)

                this.analytics.track(
                    'account_completed',
                    this.analytics.withContext({
                        success: false,
                        points_gained: 0,
                        duration_ms: Math.round(parseFloat(durationSeconds) * 1000),
                        has_core: this.pluginManager.hasOfficialCoreEntitlement()
                    })
                )
                void this.reportRunError({
                    kind: 'account_failed',
                    email: accountEmail,
                    error: failedResult.error,
                    hasCore: this.pluginManager.hasOfficialCoreEntitlement(),
                    durationSeconds: parseFloat(durationSeconds)
                })
            }

            // Account-safety pacing: pause a randomized interval before the next account so a
            // multi-account run doesn't hit Microsoft back-to-back from one machine. Scales with
            // searchSettings.delayMultiplier (via randomDelay). Skipped after the last account.
            if (account !== accounts[accounts.length - 1]) {
                const pauseMs = this.utils.randomDelay(
                    this.config.searchSettings.accountDelay?.min ?? '40sec',
                    this.config.searchSettings.accountDelay?.max ?? '4min'
                )
                this.logger.info(
                    'main',
                    'ACCOUNT-PACING',
                    `Waiting ${Math.round(pauseMs / 1000)}s before the next account`
                )
                await this.utils.wait(pauseMs)
            }
        }

        if ((this.config.core?.clusters ?? 1) <= 1 && !cluster.isWorker) {
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
            await Promise.allSettled([flushAllWebhooks(), this.analytics.flush()])
        }

        return accountStats
    }

    /**
     * Run a single worker/activity with telemetry: times it, emits `worker_executed`
     * (success or failure with duration), and preserves the exact return value / rethrows
     * on error so control flow is completely unchanged. Telemetry is fire-and-forget and
     * can never break a run.
     */
    private async trackWorker<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const startedAt = Date.now()
        try {
            const result = await fn()
            this.analytics.track('worker_executed', this.analytics.withContext({
                worker: name,
                success: true,
                duration_ms: Date.now() - startedAt,
                has_core: this.pluginManager.hasOfficialCoreEntitlement()
            }))
            return result
        } catch (error) {
            this.analytics.track('worker_executed', this.analytics.withContext({
                worker: name,
                success: false,
                duration_ms: Date.now() - startedAt,
                has_core: this.pluginManager.hasOfficialCoreEntitlement()
            }))
            throw error
        }
    }

    /**
     * Report a run/account failure to the maintainer through both telemetry channels,
     * gated by the single `analytics.enabled` switch:
     *   - PostHog `error_occurred` — anonymous & structured, for trend analysis (no
     *     email or error text leaves the machine; only the failure kind + context).
     *   - Discord relay (Core-API) — a human-readable alert with a masked email and a
     *     redacted error string, so a regression is visible in real time.
     * Returns once the Discord report has been enqueued so callers on an exit path
     * (e.g. a crashing cluster worker about to process.exit) can await delivery; most
     * callers fire-and-forget with `void`. Never throws — telemetry can't break a run.
     */
    private async reportRunError(input: ErrorReportInput): Promise<void> {
        this.analytics.track(
            'error_occurred',
            this.analytics.withContext({
                kind: input.kind,
                has_core: input.hasCore,
                // The error text makes the event actionable in PostHog (top failure
                // modes, per-version regressions). AnalyticsService.scrubProps strips
                // emails/keys/IPs/URLs/paths and caps it at 255 chars before sending.
                ...(input.error ? { error_message: input.error } : {}),
                ...(input.durationSeconds != null ? { duration_seconds: input.durationSeconds } : {}),
                ...(input.analyticsProps ?? {})
            })
        )
        if (this.analytics.isEnabled) {
            await reportError(input)
        }
    }

    /**
     * Dedicated reporting for a Microsoft account ban/lock (detected at login via
     * the service-abuse landing page). Sends the run configuration that preceded the
     * ban so we can correlate ban rate with setups (proxy on/off, cluster count,
     * parallel search, account age, prior run count). Three sinks, all anonymous:
     *   - PostHog `account_banned` — for aggregate "what configs get banned" analysis
     *   - Discord relay — real-time alert to the maintainer
     *   - Local `data/stats/bans/` log + `banned` flag on the account file
     * Fire-and-forget; never throws.
     */
    private async reportAccountBanned(
        account: Account,
        error: AccountLockedError,
        durationSeconds: number
    ): Promise<void> {
        const hasProxy = !!account.proxy?.url
        const hasCore = this.pluginManager.hasOfficialCoreEntitlement()

        // Local ban log (+ marks the per-account file as banned)
        void recordAccountBan({
            email: account.email,
            reason: error.reason,
            isMobile: this.isMobile,
            hasProxy,
            hasCore,
            detail: error.message
        })

        // Pull prior history to answer "how long had this account been running?"
        const summary = await readAccountSummary(account.email).catch(() => null)
        let accountAgeDays: number | undefined
        if (summary?.firstSeenAt) {
            const ageMs = Date.now() - new Date(summary.firstSeenAt).getTime()
            if (Number.isFinite(ageMs) && ageMs >= 0) accountAgeDays = Math.round(ageMs / 86_400_000)
        }

        // PostHog — anonymous, but config-rich for correlation analysis
        this.analytics.track(
            'account_banned',
            this.analytics.withContext({
                reason: error.reason,
                device: this.isMobile ? 'mobile' : 'desktop',
                has_core: hasCore,
                has_proxy: hasProxy,
                clusters: this.config.core?.clusters ?? 1,
                headless: this.config.headless === true,
                parallel_search: this.config.searchSettings?.parallelSearching === true,
                geo_locale: account.geoLocale,
                duration_seconds: durationSeconds,
                account_total_runs: summary?.totalRuns,
                account_failed_runs: summary?.totalFailedRuns,
                account_age_days: accountAgeDays
            })
        )

        // Discord alert (same single analytics gate)
        if (this.analytics.isEnabled) {
            void reportError({
                kind: 'account_banned',
                email: account.email,
                error: `Account locked (${error.reason}) after ${durationSeconds}s — prior runs: ${summary?.totalRuns ?? 0}, proxy: ${hasProxy}, clusters: ${this.config.core?.clusters ?? 1}, parallel: ${this.config.searchSettings?.parallelSearching === true}`,
                hasCore,
                durationSeconds
            })
        }
    }

    private async sendRunSummary(accountStats: AccountStats[], runStartTime: number): Promise<void> {
        // Persist local run stats (JSON files in data/)
        void recordRunComplete({
            accountStats: accountStats.map(s => ({
                email: s.email,
                initialPoints: s.initialPoints,
                finalPoints: s.finalPoints,
                collectedPoints: s.collectedPoints,
                durationSeconds: s.duration,
                success: s.success,
                error: s.error,
                coreStats: s.coreStats
                    ? {
                          claimPoints: s.coreStats.claimPoints,
                          couponsApplied: s.coreStats.couponsApplied,
                          couponPointsDiscount: s.coreStats.couponPointsDiscount
                      }
                    : undefined,
                starBonus: s.starBonus
            })),
            runStartTime
        })

        if (cluster.isWorker) return

        const totalPoints = accountStats.reduce((s, a) => s + a.collectedPoints, 0)
        const okCount = accountStats.filter(a => a.success).length

        this.analytics.track(
            'run_completed',
            this.analytics.withContext({
                duration_ms: Date.now() - runStartTime,
                accounts_total: accountStats.length,
                accounts_ok: okCount,
                accounts_failed: accountStats.length - okCount,
                points_total: totalPoints,
                points_avg: accountStats.length > 0 ? Math.round(totalPoints / accountStats.length) : 0,
                has_core: this.pluginManager.hasOfficialCoreEntitlement()
            })
        )
    }

    async runHarvester(): Promise<number> {
        const account = this.accounts.find(candidate => candidate.enabled !== false)
        if (!account) {
            this.logger.error('main', 'HARVESTER', 'No enabled account is available for authenticated page analysis.')
            return 1
        }
        if (!this.pluginManager.hasOfficialCoreEntitlement()) {
            this.logger.error('main', 'HARVESTER', 'The official Core plugin and a valid license are required.')
            return 1
        }

        const startedAt = Date.now()
        this.userData.userName = this.utils.getEmailUsername(account.email)
        this.resetDashboardState()
        this.axios = new HttpClient(account.proxy)

        try {
            const result = await executionContext.run({ isMobile: true, account }, async () => {
                const session = await this.browserFactory.createBrowser(account)
                this.mainMobilePage = await session.context.newPage()
                await this.mainMobilePage.setViewportSize(DESKTOP_BROWSER_VIEWPORT)
                await this.login.login(this.mainMobilePage, account)
                await this.ensureLiveMobilePage(session.context, 'login verification')
                return this.activities.doCaptureDashboardPages(this.mainMobilePage)
            })

            this.printHarvesterReport(result, Date.now() - startedAt)
            return result.captured > 0 && (result.failures?.length ?? 0) === 0 ? 0 : 1
        } catch (error) {
            this.logger.error(
                'main',
                'HARVESTER',
                `Analysis failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return 1
        } finally {
            await this.closeAllBrowsers()
        }
    }

    private printHarvesterReport(result: DashboardCaptureResult, elapsedMs: number): void {
        const analyses = result.analyses ?? []
        const failures = result.failures ?? []
        const width = 78

        console.log(`\n${'='.repeat(width)}`)
        console.log('HARVESTER — TERMINAL REPORT')
        console.log('='.repeat(width))
        console.log(
            `Dashboard: ${this.dashboardVariant} | Routes analyzed: ${result.captured} | Duration: ${(elapsedMs / 1000).toFixed(1)}s`
        )
        console.log(
            `Artifacts: ${result.outputDir ?? 'none'} | Analytics: disabled | Webhooks: disabled | Dashboard sync: disabled`
        )

        for (const analysis of analyses) {
            const matched = analysis.selectorChecks.filter(check => check.valid && check.matches > 0).length
            const invalid = analysis.selectorChecks.filter(check => !check.valid)
            const missingRequired = analysis.selectorChecks.filter(check => check.required && check.matches === 0)
            const missingOptional = analysis.selectorChecks.filter(
                check => check.valid && !check.required && check.matches === 0
            )
            const status = analysis.problems.length === 0 ? 'OK' : 'WARNING'

            console.log(`\n[${status}] ${analysis.name} — ${analysis.title || analysis.url}`)
            console.log(
                `  Data: ${Math.round(analysis.flightBytes / 1024)}KB | Offers: ${analysis.offerIds} | Models: ${analysis.modelTypes.join(', ') || 'none'} | Action IDs: ${analysis.actionIds}`
            )
            const navigation = [
                analysis.httpStatus ? `HTTP ${analysis.httpStatus}` : null,
                analysis.finalUrl && analysis.finalUrl !== analysis.url ? `Final URL: ${analysis.finalUrl}` : null,
                analysis.navigationError ? `Navigation note: ${analysis.navigationError}` : null
            ].filter(Boolean)
            if (navigation.length) console.log(`  Navigation: ${navigation.join(' | ')}`)
            const domSize = analysis.domBytes === undefined ? '?' : `${Math.round(analysis.domBytes / 1024)}KB`
            console.log(
                `  DOM: ${analysis.elementCount ?? '?'} elements, ${analysis.classTokenCount ?? '?'} classes, ${analysis.stableIdCount ?? '?'} stable IDs, ${domSize} | switches=${analysis.switches}, disclosures=${analysis.disclosures}, dialogs=${analysis.dialogs}`
            )
            console.log(
                `  Selectors: ${matched}/${analysis.selectorChecks.length} matched across initial/expanded states | Inventory: ${analysis.inventoryFile ?? 'unavailable'}${analysis.domFingerprint ? ` | fingerprint=${analysis.domFingerprint.slice(0, 12)}` : ''}`
            )
            if (missingRequired.length) {
                console.log(
                    `  Required selectors missing: ${missingRequired.map(check => `${check.group}.${check.key}`).join(', ')}`
                )
            }
            if (invalid.length) {
                console.log(
                    `  Invalid selectors: ${invalid.map(check => `${check.group}.${check.key} (${check.error})`).join(', ')}`
                )
            }
            if (missingOptional.length) {
                console.log(
                    `  Optional/conditional selectors absent: ${missingOptional.map(check => `${check.group}.${check.key}`).join(', ')}`
                )
            }
            for (const problem of analysis.problems) console.log(`  ! ${problem}`)
        }

        for (const failure of failures) {
            console.log(`\n[FAILED] ${failure.name} — ${failure.url}`)
            console.log(`  ${failure.error}`)
        }

        console.log(`\nSummary: ${result.problems.length} warning(s), ${failures.length} failure(s).`)
        console.log('Only Page/ artifacts were persisted; configuration, statistics, sessions, analytics, and logs were not.')
        console.log(`${'='.repeat(width)}\n`)
    }

    async Main(account: Account): Promise<{
        initialPoints: number
        collectedPoints: number
        searchPointsGained: number
        countersAvailable: boolean
        coreStats: CoreRunStats
        starBonus?: StarBonusInfo
    }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)
        this.userData.coreStats = createEmptyCoreRunStats()
        // Clear any dashboard state carried over from the previous account.
        this.resetDashboardState()

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
                await this.ensureLiveMobilePage(initialContext, 'login verification')

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

                this.userData.starBonus = undefined
                
                // Fetch profile avatar in the background
                AvatarFetcher.fetchAvatarIfNeeded(initialContext, account).catch(() => {})

                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()

                // Capture STAR Bonus and monthly tier bonus from the new dashboard
                const li = data.userStatus.levelInfo
                if (li && ((li.bingStarMonthlyBonusMaximum ?? 0) > 0 || (li.monthlyLevelBonusMaximum ?? 0) > 0)) {
                    this.userData.starBonus = {
                        activeLevelName: li.activeLevelName ?? '',
                        monthlyProgress: li.bingStarMonthlyBonusProgress ?? 0,
                        monthlyMax: li.bingStarMonthlyBonusMaximum ?? 0,
                        weeklyProgress: li.bingStarBonusWeeklyProgress ?? 0,
                        weeklyState: li.bingStarBonusWeeklyState ?? '',
                        levelBonusProgress: li.monthlyLevelBonusProgress ?? 0,
                        levelBonusMax: li.monthlyLevelBonusMaximum ?? 0
                    }
                }

                // Set geo
                this.userData.geoLocale =
                    account.geoLocale === 'auto'
                        ? (data.userProfile.attributes.country ?? 'US')
                        : account.geoLocale.toLowerCase()
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

                this.pointsCanCollect =
                    browserEarnable.totalEarnablePoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Total: ${this.pointsCanCollect} | Desktop search: ${
                        browserEarnable.desktopSearchPoints
                    } | Mobile search: ${browserEarnable.mobileSearchPoints} | Promotions: ${
                        browserEarnable.dailySetPoints + browserEarnable.morePromotionsPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                // Core diagnostic harvester (opt-in via core.captureDashboardPages). Runs
                // FIRST — before coupons/claim mutate the dashboard — so the claim card and
                // coupon state are captured pristine. Wipes & repopulates the Page/ folder
                // with full-fidelity snapshots (HTML + RSC flight + screenshots) for offline
                // selector maintenance. No-op stub without Core; next-only.
                if (this.config.core?.captureDashboardPages) {
                    const capture = await this.activities.doCaptureDashboardPages(this.mainMobilePage)
                    if (capture.captured > 0) {
                        this.logger.info(
                            'main',
                            'DASHBOARD-CAPTURE',
                            `Harvested ${capture.captured} page(s) → ${capture.outputDir}` +
                                (capture.problems.length ? ` | ${capture.problems.length} problem(s) flagged` : '')
                        )
                        // Auto-disable: write false back to config.json so the Desk toggle
                        // resets automatically. The user must re-enable it for each new capture.
                        this.config.core!.captureDashboardPages = false
                        // Primary/single-worker only: cluster workers must not race each other
                        // (or the primary) writing the shared config file. Resolve the path the
                        // SAME way loadConfig does instead of hardcoding src/config.json (which
                        // is wrong once the bot runs from dist/).
                        if (cluster.isPrimary) {
                            try {
                                const cfgPath = resolveConfigPath()
                                const cfgRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
                                if (cfgRaw?.core) {
                                    cfgRaw.core.captureDashboardPages = false
                                    fs.writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 4) + '\n', 'utf8')
                                }
                            } catch {
                                /* config write is best-effort */
                            }
                        }
                    }
                }

                if (this.config.workers.doApplyCoupons) {
                    const couponResult = await this.trackWorker('applyCoupons', () => this.activities.doApplyCoupons(this.mainMobilePage))
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
                    const claimResult = await this.trackWorker('claimPoints', () => this.activities.doClaimPoints(this.mainMobilePage))
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
                    const dashInfo = await this.trackWorker('dashboardInfo', () => this.activities.collectDashboardInfo(this.mainMobilePage))
                    this.userData.dashboardInfo = dashInfo
                }

                if (this.config.workers.doAppPromotions) await this.trackWorker('appPromotions', () => this.workers.doAppPromotions(appData))
                if (this.config.workers.doDailySet) await this.trackWorker('dailySet', () => this.workers.doDailySet(data, this.mainMobilePage))
                if (this.config.workers.doSpecialPromotions) await this.trackWorker('specialPromotions', () => this.workers.doSpecialPromotions(data))
                if (this.config.workers.doMorePromotions) {
                    await this.trackWorker('morePromotions', () => this.workers.doMorePromotions(data, this.mainMobilePage))
                    if (
                        this.pluginManager.hasOfficialCoreEntitlement() &&
                        this.config.core?.temporaryPunchcards !== false
                    ) {
                        await this.activities.doTemporaryPunchcards(this.mainMobilePage)
                    }
                }
                // Classic punch cards (legacy dashboard; no-op on next where punchCards is empty).
                if (this.config.workers.doPunchCards) {
                    await this.trackWorker('punchCards', () => this.workers.doPunchCards(data, this.mainMobilePage))
                }
                if (this.accessToken) {
                    if (this.config.workers.doDailyCheckIn) await this.trackWorker('dailyCheckIn', () => this.activities.doDailyCheckIn())
                    if (this.config.workers.doReadToEarn) await this.trackWorker('readToEarn', () => this.activities.doReadToEarn())
                } else if (this.config.workers.doDailyCheckIn || this.config.workers.doReadToEarn) {
                    this.logger.warn(
                        'main',
                        'APP-ACTIVITIES',
                        'Skipping app-only activities because the mobile access token was not available'
                    )
                }

                // Daily Streak: expand progression, activate protection, read bonus info
                if (this.config.workers.doDailyStreak) {
                    const streakInfo = await this.trackWorker('dailyStreak', () => this.activities.doDailyStreak(this.mainMobilePage))
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

                // Set Rewards goal: auto-discover the first eligible gift card and set it
                // as the active goal when no goal is currently active. Skipped automatically
                // for 30 days after a run that finds no eligible card. Opt-in (false by default).
                if (this.pluginManager.hasOfficialCoreEntitlement() && this.config.core?.setGoal === true) {
                    await this.activities.doSetGoal(this.mainMobilePage)
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                // Defensive fallback: the legacy JSON API (/api/getuserinfo?type=1) normally
                // DOES expose pcSearch/mobileSearch counters even on the Next.js dashboard, but
                // if that fetch ever degrades to the HTML-scrape path the counters are absent and
                // missingSearchPoints reports 0 — which would make the search manager skip every
                // search. When the counters are absent, schedule searches with an estimated
                // target — the search task measures real gains from the balance and stops at
                // Microsoft's daily cap, so the estimate only needs to be positive.
                const countersAvailable = this.browser.func.hasSearchCounters(searchPoints)
                if (!countersAvailable) {
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
                const measuredPoints = finalPoints - initialPoints
                // Points only ever go UP during a run. A negative or non-finite delta means
                // getCurrentPoints() failed to read the live balance (it fell back to 0/NaN) —
                // a measurement failure, NOT a real loss. Fall back to the directly-measured
                // search gain so we never record impossible negative points (which would corrupt
                // the dashboard totals and the PostHog analytics aggregates).
                let collectedPoints = measuredPoints
                if (!Number.isFinite(measuredPoints) || measuredPoints < 0) {
                    this.logger.warn(
                        'main',
                        'POINTS',
                        `Balance read looks wrong (initial=${initialPoints} → final=${finalPoints} = ${measuredPoints}); falling back to measured search gain ${mobilePoints + desktopPoints}`
                    )
                    collectedPoints = Math.max(0, mobilePoints + desktopPoints)
                }

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0,
                    searchPointsGained: Math.max(0, mobilePoints + desktopPoints),
                    countersAvailable,
                    coreStats: this.userData.coreStats,
                    starBonus: this.userData.starBonus
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
    console.log(`\x1b[2m v${pkg.version} - Open Source Edition\x1b[0m`)
    console.log(`\x1b[33m ⭐ Support us with a Star on GitHub: \x1b[0m\x1b[36mhttps://github.com/QuestPilot/Microsoft-Rewards-Bot\x1b[0m\n`)

    // Check before doing anything
    checkNodeVersion()

    const harvesterMode = process.argv[2] === 'harvester' || process.env.MSRB_EPHEMERAL_RUN === '1'

    if (!harvesterMode) {
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
    }

    const rewardsBot = new MicrosoftRewardsBot()
    rewardsBot.agentRuntime.setRunHandler(() => runSingle(rewardsBot))
    rewardsBot.agentRuntime.setStopHandler(() => {
        rewardsBot.dashboardStopRequested = true
    })

    // Long-lived modes (scheduler loop / background agent) must survive a stray
    // unhandledRejection/uncaughtException instead of tearing down a multi-day
    // process. One-shot modes (single run / harvester) still fail fast.
    const isLongLivedMode =
        !rewardsBot.isHarvesterMode &&
        (isSchedulerEnabled(rewardsBot.config.scheduler) || process.argv.includes('--background'))
    // Re-entrancy guard: a SIGINT during SIGTERM cleanup (or a second fatal error)
    // must not run the async cleanup twice concurrently.
    let shuttingDown = false
    let beforeExitHandled = false

    process.on('beforeExit', () => {
        // beforeExit fires when the event loop drains. Do NOT schedule new async work
        // here — doing so resurrects the loop and re-fires this handler. Graceful
        // cleanup is owned by the explicit SIGINT/SIGTERM and main() exit paths.
        if (beforeExitHandled) return
        beforeExitHandled = true
    })
    process.on('SIGINT', async () => {
        if (shuttingDown) return
        shuttingDown = true
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        if (shuttingDown) return
        shuttingDown = true
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        // Keep a long-lived process alive (log-and-continue); the scheduler/agent loop
        // recovers on the next iteration rather than dying on one bad tick.
        if (isLongLivedMode) return
        if (shuttingDown) return
        shuttingDown = true
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        if (isLongLivedMode) return
        if (shuttingDown) return
        shuttingDown = true
        await rewardsBot.closeAllBrowsers()
        await rewardsBot.agentRuntime.stop()
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        if (!rewardsBot.isHarvesterMode && rewardsBot.config.backgroundAgent?.enabled !== false) {
            await rewardsBot.agentRuntime.start()
        }
        await rewardsBot.initialize()
        if (cluster.isWorker) {
            await rewardsBot.run()
            return
        }

        const exitCode = rewardsBot.isHarvesterMode
            ? await rewardsBot.runHarvester()
            : process.argv.includes('--background') && !isSchedulerEnabled(rewardsBot.config.scheduler)
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
        // A fatal error must surface as a non-zero exit (match the harvester/single
        // paths and the top-level main().catch) — previously this fell through to a
        // misleading exit code 0.
        process.exit(1)
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

// Exit code the scheduler loop returns when it applied an update while running
// under Desk supervision (see checkForUpdateAndRestart below). Keep in sync with
// UPDATE_RESTART_EXIT_CODE in scripts/desk/app-window.js.
const SUPERVISED_UPDATE_EXIT_CODE = 75

/**
 * Check for a published update before a scheduled run and, if one is applied,
 * hand off to a fresh process on the new version.
 *
 * A long-lived scheduler process otherwise stays pinned to whatever version it
 * booted on, because the launcher (`scripts/start.js`) only runs the updater
 * once at startup. We call the same UpdateManager here so each scheduled run
 * starts on the latest code.
 *
 * Two ways to hand off, depending on who is supervising this process:
 *   - Standalone (terminal/CLI, `--background`): nothing else is watching this
 *     process, so we self-detach — spawn `start.js` (which rebuilds dist and
 *     re-enters the scheduler) as an independent, unref'd process and exit 0.
 *   - Under Desk (`MSRB_UI_CHILD=1`): Desk tracks this process as `botProcess`
 *     to show logs and own the Stop button. Self-detaching here would orphan an
 *     invisible, unmanaged process outside Desk's control — no way to see its
 *     logs or stop it, and a real risk of a second run starting on the same
 *     accounts if the user clicks Start again while the orphan keeps going. So
 *     instead we exit with SUPERVISED_UPDATE_EXIT_CODE and let Desk's own exit
 *     handler relaunch through `start.js` as a new, still-tracked child.
 *
 * @returns the exit code the caller should stop the loop and return, or `false`
 * if no update was applied (the loop should continue as normal).
 */
async function checkForUpdateAndRestart(rewardsBot: MicrosoftRewardsBot): Promise<number | false> {
    try {
        const updaterPath = path.join(process.cwd(), 'scripts', 'updater', 'UpdateManager.js')
        // UpdateManager is a launcher-side CommonJS module that lives outside the
        // compiled bundle, so it is resolved at runtime rather than imported.
        const { UpdateManager } = require(updaterPath) as {
            UpdateManager: new () => { run(): Promise<{ status: string; remote?: { version?: string } }> }
        }
        const result = await new UpdateManager().run()
        if (result.status !== 'updated') return false

        // bot_version (from withContext) is the version we're leaving; to_version is the target.
        rewardsBot.analytics.track(
            'update_applied',
            rewardsBot.analytics.withContext({
                to_version: result.remote?.version ?? null
            })
        )

        await rewardsBot.closeAllBrowsers()
        await rewardsBot.pluginManager.destroyAll()
        // Flush analytics too — the process restarts right after, so a queued event would be lost.
        await Promise.allSettled([flushAllWebhooks(), rewardsBot.analytics.flush()])

        if (process.env.MSRB_UI_CHILD === '1') {
            rewardsBot.logger.info(
                'main',
                'SCHEDULER',
                `Update to ${result.remote?.version ?? 'a new version'} applied. Handing off to the Desk to restart.`
            )
            return SUPERVISED_UPDATE_EXIT_CODE
        }

        rewardsBot.logger.info(
            'main',
            'SCHEDULER',
            `Update to ${result.remote?.version ?? 'a new version'} applied. Restarting in this terminal...`
        )

        // Mirror start.js launchPostUpdateRestart: same console (stdio inherit),
        // detached + unref so this process can exit, and MSRB_POST_UPDATE_RESTART
        // so the launcher rebuilds dist and skips a redundant update check.
        const child = childProcess.spawn(
            process.execPath,
            [path.join(process.cwd(), 'scripts', 'start.js'), ...process.argv.slice(2)],
            {
                cwd: process.cwd(),
                detached: true,
                stdio: 'inherit',
                windowsHide: false,
                env: { ...process.env, MSRB_POST_UPDATE_RESTART: '1' }
            }
        )
        child.unref()
        return 0
    } catch (error) {
        rewardsBot.logger.warn(
            'main',
            'SCHEDULER',
            `Pre-run update check failed, continuing on the current version: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
    }
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
    // The launcher already ran the updater moments ago, so the first startup run
    // skips the check. Every later scheduled run re-checks first.
    let bootChecked = true

    while (true) {
        if (shouldRunNow) {
            if (!bootChecked) {
                const restartExitCode = await checkForUpdateAndRestart(rewardsBot)
                if (restartExitCode !== false) return restartExitCode
            }

            rewardsBot.analytics.track(
                'scheduler_triggered',
                rewardsBot.analytics.withContext({
                    on_startup: bootChecked, // true only for the first (runOnStartup) iteration
                    timezone: scheduler.timezone
                })
            )
            bootChecked = false

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
        } else {
            bootChecked = false
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
