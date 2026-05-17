import cluster, { Worker } from 'cluster'
import readline from 'readline'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import AutomationUtils from './automation/AutomationUtils'
import BrowserManager from './automation/BrowserManager'
import PageController from './automation/PageController'

import { loadAccounts, loadConfig } from './helpers/ConfigLoader'
import Helpers from './helpers/Helpers'
import { checkNodeVersion } from './helpers/SchemaValidator'
import { IpcLog, LogService } from './notifications/LogService'

import { AuthManager } from './automation/auth/AuthManager'
import { executionContext, getCurrentContext } from './context/ExecutionContext'
import ActivityRunner from './core/ActivityRunner'
import { SearchOrchestrator } from './core/SearchOrchestrator'
import { TaskBase } from './core/TaskBase'

import type { DashboardInfo } from './core/InternalPluginAPI'
import { PluginManager } from './core/PluginManager'
import { checkSafetyAdvisory } from './core/SafetyAdvisory'
import { formatScheduledRun, getNextScheduledRun, isSchedulerEnabled, waitUntil } from './core/Scheduler'
import HttpClient from './helpers/HttpClient'
import { flushDiscordQueue, sendDiscord } from './notifications/DiscordWebhook'
import { flushNtfyQueue, sendNtfy } from './notifications/NtfyWebhook'
import type { Account } from './types/Account'
import type { AppDashboardData } from './types/AppDashboardData'
import type { DashboardData } from './types/DashboardData'
import type { DashboardLog } from './types/Dashboard'

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
}

// Re-exported so callers that already import from this module keep working
export { executionContext, getCurrentContext }

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs)])
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
    dashboardInfo: DashboardInfo | null
}

export class MicrosoftRewardsBot {
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

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: BrowserManager = new BrowserManager(this)
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
            dashboardInfo: null
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
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        await this.warnIfTooManyAccounts()

        // Load plugins from plugins/ directory
        await this.pluginManager.loadPlugins()

        // Install plugin-registered tasks into ActivityRunner
        const tasks = this.pluginManager.getRegisteredTasks()
        this.activities.installPremiumTasks(tasks)

        // Notify plugins that bot is initialized
        await this.pluginManager.notifyBotInitialized()
    }

    async run(): Promise<number> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                return this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
                return 0
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
            return 0
        }
    }

    private async warnIfTooManyAccounts(): Promise<void> {
        if (this.accounts.length <= 4 || cluster.isWorker) return

        this.logger.warn(
            'main',
            'ACCOUNT-SAFETY',
            `You have configured ${this.accounts.length} accounts. Running more than 4 accounts is strongly discouraged and may increase account risk.`
        )

        if (!process.stdin.isTTY) {
            this.logger.warn('main', 'ACCOUNT-SAFETY', 'Continuing in non-interactive mode.')
            return
        }

        await new Promise<void>(resolve => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            rl.question('Press Enter to continue at your own risk, or press Ctrl+C to stop. ', () => {
                rl.close()
                resolve()
            })
        })
    }

    private runMaster(runStartTime: number): Promise<number> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
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

                const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                    account
                ).catch(error => {
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
                        success: true
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
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
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

            await flushAllWebhooks()
        }

        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                // Set a tablet-sized viewport for a comfortable visual while keeping mobile UA
                await this.mainMobilePage.setViewportSize({ width: 768, height: 1024 })

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
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

                // Dashboard Info: collect hero data BEFORE any activities (for before/after comparison)
                if (this.config.workers.doDashboardInfo) {
                    const dashInfo = await this.activities.collectDashboardInfo(this.mainMobilePage)
                    this.userData.dashboardInfo = dashInfo
                }

                if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                if (this.config.workers.doMorePromotions) await this.workers.doMorePromotions(data, this.mainMobilePage)
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

                if (this.config.workers.enforceCoreStreakProtectionGate) {
                    const desiredEnabled = this.pluginManager.hasOfficialCoreEntitlement()
                    await this.activities.syncStreakProtection(this.mainMobilePage, desiredEnabled)
                }

                // Redeem Goal: set auto-redeem goal if configured
                if (this.config.workers.doRedeemGoal && this.config.redeemGoal?.enabled) {
                    await this.activities.doRedeemGoal(this.mainMobilePage, this.config.redeemGoal)
                }

                // Claim Points: claim any "Prêt à réclamer" points before searches
                if (this.config.workers.doClaimPoints) {
                    const claimResult = await this.activities.doClaimPoints(this.mainMobilePage)
                    if (claimResult.claimed) {
                        this.logger.info(
                            'main',
                            'CLAIM-POINTS',
                            `Claimed ${claimResult.pointsClaimed} points | Entries: ${claimResult.entries.length}`
                        )
                    }
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

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
                    collectedPoints: collectedPoints || 0
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
    console.log(' | |_) / _ \\ \\ /\\ / / _` | \'__/ _` / __| |  _ \\ / _ \\| __|')
    console.log(' |  _ <  __/\\ V  V / (_| | | | (_| \\__ \\ | |_) | (_) | |_ ')
    console.log(' |_| \\_\\___| \\_/\\_/ \\__,_|_|  \\__,_|___/ |____/ \\___/ \\__|')
    console.log('\x1b[0m') // Reset color
    console.log(`\x1b[2m v${pkg.version} - Open Source Edition\x1b[0m\n`)

    // Check before doing anything
    checkNodeVersion()

    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void rewardsBot.pluginManager.destroyAll()
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        if (cluster.isWorker) {
            await rewardsBot.run()
            return
        }

        const exitCode = isSchedulerEnabled(rewardsBot.config.scheduler)
            ? await runScheduled(rewardsBot)
            : await runSingle(rewardsBot)

        await rewardsBot.pluginManager.destroyAll()
        await flushAllWebhooks()
        process.exit(exitCode)
    } catch (error) {
        rewardsBot.dashboardRunState = 'error'
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
    }
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
                rewardsBot.logger.info('main', 'SCHEDULER', 'Remote stop requested. Scheduler will stop after the current run.')
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
