import type { AxiosRequestConfig } from "axios";
import chalk from "chalk";
import { spawn } from "child_process";
import type { Worker } from "cluster";
import cluster from "cluster";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createInterface } from "readline";
import type { Page } from "rebrowser-playwright";
import { BrowserFunc } from "./browser/BrowserFunc";
import { BrowserUtil } from "./browser/BrowserUtil";
import { Humanizer } from "./util/browser/Humanizer";
import { getMemoryMonitor, stopMemoryMonitor } from "./util/core/MemoryMonitor";
import {
  formatDetailedError,
  getErrorMessage,
  normalizeRecoveryEmail,
  shortErrorMessage,
  Util,
} from "./util/core/Utils";
import { AxiosClient } from "./util/network/Axios";
import { QueryDiversityEngine } from "./util/network/QueryDiversityEngine";
import { log, stopWebhookCleanup } from "./util/notifications/Logger";
import { JobState } from "./util/state/JobState";
import { loadAccounts, loadConfig } from "./util/state/Load";
import { MobileRetryTracker } from "./util/state/MobileRetryTracker";
import { detectBanReason } from "./util/validation/BanDetector";
import { StartupValidator } from "./util/validation/StartupValidator";

import { Activities } from "./functions/Activities";
import { Login } from "./functions/Login";
import { Workers } from "./functions/Workers";

import { DesktopFlow } from "./flows/DesktopFlow";
import { MobileFlow } from "./flows/MobileFlow";
import { SummaryReporter, type AccountResult } from "./flows/SummaryReporter";

import { InternalScheduler } from "./scheduler/InternalScheduler";

import { DISCORD, TIMEOUTS, URLS } from "./constants";
import { Account } from "./interface/Account";
import { FileBootstrap } from "./util/core/FileBootstrap";

// Main bot class
export class MicrosoftRewardsBot {
  public log: typeof log;
  public config;
  public utils: Util;
  public activities: Activities = new Activities(this);
  public login!: Login; // Fixed: Login instance needed by flows
  public browser: {
    func: BrowserFunc;
    utils: BrowserUtil;
  };
  public humanizer: Humanizer;
  public isMobile: boolean;
  public homePage!: Page;
  public currentAccountEmail?: string;
  public currentAccountRecoveryEmail?: string;
  public currentAccountPhoneNumber?: string;
  public queryEngine?: QueryDiversityEngine;
  public compromisedModeActive: boolean = false;
  public compromisedReason?: string;

  private activeWorkers: number;
  private accounts: Account[];
  public workers: Workers; // Made public for DesktopFlow access

  /**
   * Override accounts list (used by dashboard BotController to run a single account)
   */
  public setAccounts(accounts: Account[]): void {
    this.accounts = accounts;
  }

  // Summary collection (per process)
  private accountSummaries: AccountSummary[] = [];
  private runId: string = crypto.randomBytes(6).toString("hex");
  private bannedTriggered: { email: string; reason: string } | null = null;
  private globalStandby: { active: boolean; reason?: string } = {
    active: false,
  };
  private _accountJobState?: JobState;
  private accountRunCounts: Map<string, number> = new Map();

  public axios!: AxiosClient;

  /** Public accessor for the shared JobState instance (used by Workers) */
  get accountJobState(): JobState | undefined {
    return this._accountJobState;
  }

  constructor(isMobile: boolean) {
    this.isMobile = isMobile;
    this.log = log;

    this.accounts = [];
    this.utils = new Util();
    this.config = loadConfig();
    this.enforceHumanization();
    // JobState will be initialized in initialize() method after validation
    this.browser = {
      func: new BrowserFunc(this),
      utils: new BrowserUtil(this),
    };
    this.login = new Login(this); // Fixed: Initialize Login instance
    this.workers = new Workers(this);
    this.humanizer = new Humanizer(this.utils, this.config.humanization);
    this.activeWorkers = this.config.clusters;
  }

  async initialize() {
    this.accounts = loadAccounts();

    // Run comprehensive startup validation
    const validator = new StartupValidator();
    try {
      await validator.validate(this.config, this.accounts);
    } catch (error) {
      // Critical validation errors prevent startup
      const errorMsg = getErrorMessage(error);
      log("main", "VALIDATION", `Fatal validation error: ${errorMsg}`, "error");
      throw error; // Re-throw to stop execution
    }

    // Validation passed - continue with initialization

    // Initialize job state
    if (this.config.jobState?.enabled !== false) {
      this._accountJobState = new JobState(this.config);
    }
  }

  private shouldSkipAccount(email: string, dayKey: string): boolean {
    if (!this.accountJobState) return false;
    if (this.config.jobState?.skipCompletedAccounts === false) return false;
    if ((this.config.passesPerRun ?? 1) > 1) return false;
    if (this.isAccountSkipOverride()) return false;
    return this.accountJobState.isAccountComplete(email, dayKey);
  }

  private persistAccountCompletion(
    email: string,
    dayKey: string,
    summary: AccountSummary,
  ): void {
    if (!this.accountJobState) return;
    if (this.config.jobState?.skipCompletedAccounts === false) return;
    if ((this.config.passesPerRun ?? 1) > 1) return;
    if (this.isAccountSkipOverride()) return;
    this.accountJobState.markAccountComplete(email, dayKey, {
      runId: this.runId,
      totalCollected: summary.totalCollected,
      banned: summary.banned?.status === true,
      errors: summary.errors.length,
    });
  }

  private isAccountSkipOverride(): boolean {
    const value = process.env.REWARDS_DISABLE_ACCOUNT_SKIP;
    if (!value) return false;
    const lower = value.toLowerCase();
    return value === "1" || lower === "true" || lower === "yes";
  }

  private async promptResetJobState(): Promise<boolean> {
    // Check if auto-reset is enabled in config (for scheduled tasks)
    if (this.config.jobState?.autoResetOnComplete === true) {
      log(
        "main",
        "TASK",
        "Auto-reset enabled (jobState.autoResetOnComplete=true) - resetting and rerunning all accounts",
        "log",
        "green",
      );
      return true;
    }

    // Check environment variable override
    const envAutoReset = process.env.REWARDS_AUTO_RESET_JOBSTATE;
    if (envAutoReset === "1" || envAutoReset?.toLowerCase() === "true") {
      log(
        "main",
        "TASK",
        "Auto-reset enabled (REWARDS_AUTO_RESET_JOBSTATE) - resetting and rerunning all accounts",
        "log",
        "green",
      );
      return true;
    }

    // Detect non-interactive environments more reliably
    const isNonInteractive =
      !process.stdin.isTTY ||
      process.env.CI === "true" ||
      process.env.DOCKER === "true" ||
      process.env.SCHEDULED_TASK === "true";

    if (isNonInteractive) {
      log(
        "main",
        "TASK",
        "Non-interactive environment detected - keeping job state (set jobState.autoResetOnComplete=true to auto-rerun)",
        "warn",
      );
      return false;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<boolean>((resolve) => {
      rl.question(
        "\nâš ï¸  Reset job state and run all accounts again? (y/N): ",
        (answer) => {
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          resolve(trimmed === "y" || trimmed === "yes");
        },
      );
    });
  }

  private resetAllJobStates(): void {
    if (!this.accountJobState) return;

    const jobStateDir = this.accountJobState.getJobStateDir();
    if (!fs.existsSync(jobStateDir)) return;

    const files = fs
      .readdirSync(jobStateDir)
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(jobStateDir, file));
      } catch {
        // Expected: File may be locked or already deleted - non-critical
      }
    }
  }

  private enforceHumanization(): void {
    const allowDisable = process.env.ALLOW_HUMANIZATION_OFF === "1";
    if (this.config?.humanization?.enabled === false && !allowDisable) {
      log(
        "main",
        "HUMANIZATION",
        "Humanization disabled in config; forcing it on for anti-detection safety (set ALLOW_HUMANIZATION_OFF=1 to override).",
        "warn",
      );
      this.config.humanization = { ...this.config.humanization, enabled: true };
    }
  }

  private buildQueryEngine(): QueryDiversityEngine | undefined {
    if (!this.config.queryDiversity?.enabled) {
      return undefined;
    }

    const proxyHttpClient = {
      request: (config: AxiosRequestConfig) => this.axios.request(config),
    };

    const logger = (
      source: string,
      message: string,
      level: "info" | "warn" | "error" = "info",
    ) => {
      const mapped =
        level === "error" ? "error" : level === "warn" ? "warn" : "log";
      this.log(this.isMobile, source, message, mapped);
    };

    return new QueryDiversityEngine(
      {
        sources: this.config.queryDiversity.sources,
        maxQueriesPerSource: this.config.queryDiversity.maxQueriesPerSource,
        cacheMinutes: this.config.queryDiversity.cacheMinutes,
      },
      logger,
      proxyHttpClient,
    );
  }

  /**
   * Get the Rewards base URL for post-login navigation.
   * Always returns the real Microsoft Rewards URL.
   * config.baseURL is used ONLY for the initial tracking visit in Login.ts.
   */
  getRewardsBaseURL(): string {
    return URLS.REWARDS_BASE;
  }

  async run() {
    this.printBanner();
    log(
      "main",
      "MAIN",
      `Bot started with ${this.config.clusters} worker(s) (1 bot, ${this.config.clusters} parallel browser${this.config.clusters > 1 ? "s" : ""})`,
    );

    // Only cluster when there's more than 1 cluster demanded
    if (this.config.clusters > 1) {
      if (cluster.isPrimary) {
        await this.runMaster();
      } else if (cluster.worker) {
        await this.runWorker();
      } else {
        // Neither primary nor worker - something's wrong with clustering
        log(
          "main",
          "MAIN",
          "ERROR: Cluster mode failed - neither primary nor worker! Falling back to single-process mode.",
          "error",
        );
        const passes = this.config.passesPerRun ?? 1;
        for (let pass = 1; pass <= passes; pass++) {
          if (passes > 1) {
            log("main", "MAIN", `Starting pass ${pass}/${passes}`);
          }
          await this.runTasks(this.accounts, pass, passes);
          if (pass < passes) {
            log(
              "main",
              "MAIN",
              `Completed pass ${pass}/${passes}. Waiting before next pass...`,
            );
            await this.utils.wait(TIMEOUTS.ONE_MINUTE);
          }
        }
        return;
      }
    } else {
      const passes = this.config.passesPerRun ?? 1;
      for (let pass = 1; pass <= passes; pass++) {
        if (passes > 1) {
          log("main", "MAIN", `Starting pass ${pass}/${passes}`);
        }
        await this.runTasks(this.accounts, pass, passes);
        if (pass < passes) {
          log(
            "main",
            "MAIN",
            `Completed pass ${pass}/${passes}. Waiting before next pass...`,
          );
          await this.utils.wait(TIMEOUTS.ONE_MINUTE);
        }
      }
    }
  }
  private printBanner() {
    if (this.config.clusters > 1 && !cluster.isPrimary) return;

    const version = this.getVersion();

    // ASCII-safe banner for Windows PowerShell compatibility
    console.log("");
    console.log(
      chalk.cyan("  ================================================"),
    );
    console.log(chalk.cyan("           Microsoft Rewards Bot"));
    console.log(
      chalk.cyan("  ================================================"),
    );
    console.log("");
    console.log(chalk.gray("  Version:       ") + chalk.white(`v${version}`));
    console.log(chalk.gray("  Process ID:    ") + chalk.white(process.pid));
    console.log(
      chalk.gray("  Workers:       ") + chalk.white(this.config.clusters),
    );
    console.log(chalk.gray("  Node.js:       ") + chalk.white(process.version));
    console.log(
      chalk.gray("  Platform:      ") +
        chalk.white(`${process.platform} ${process.arch}`),
    );
    console.log("");
    console.log(
      chalk.cyan("  ================================================"),
    );
    console.log("");
  }

  private getVersion(): string {
    const DEFAULT_VERSION = "3.62.5";
    try {
      const pkgPath = path.join(__dirname, "../", "package.json");
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        return pkg.version || DEFAULT_VERSION;
      }
    } catch (error) {
      // Ignore: Fall back to default version if package.json is unavailable
    }
    return DEFAULT_VERSION;
  }

  // Return summaries (used when clusters==1)
  public getSummaries() {
    return this.accountSummaries;
  }

  private runMaster(): Promise<void> {
    return new Promise((resolve) => {
      log("main", "MAIN-PRIMARY", "Primary process started");

      const totalAccounts = this.accounts.length;

      // Validate accounts exist
      if (totalAccounts === 0) {
        log(
          "main",
          "MAIN-PRIMARY",
          "No accounts found to process. Nothing to do.",
          "warn",
        );
        resolve();
        return;
      }

      // If user over-specified clusters (e.g. 10 clusters but only 2 accounts), don't spawn useless idle workers.
      const workerCount = Math.min(this.config.clusters, totalAccounts);
      const accountChunks = this.utils.chunkArray(this.accounts, workerCount);
      // Reset activeWorkers to actual spawn count (constructor used raw clusters)
      this.activeWorkers = workerCount;

      // Store worker-to-chunk mapping for crash recovery
      const workerChunkMap = new Map<number, Account[]>();

      let resolved = false;
      const finishRun = async () => {
        if (resolved) return;
        resolved = true;
        try {
          await this.sendConclusion(this.accountSummaries);
        } catch (e) {
          log(
            "main",
            "CONCLUSION",
            `Failed to send conclusion: ${getErrorMessage(e)}`,

            "warn",
          );
        }
        log(
          "main",
          "MAIN-WORKER",
          "All workers destroyed. Run complete.",
          "warn",
        );
        resolve();
      };

      for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork();
        const chunk = accountChunks[i] || [];

        // Validate chunk has accounts
        if (chunk.length === 0) {
          log(
            "main",
            "MAIN-PRIMARY",
            `Warning: Worker ${i} received empty account chunk`,
            "warn",
          );
        }

        // Store chunk mapping for crash recovery
        if (worker.id) {
          workerChunkMap.set(worker.id, chunk);
        }

        // FIXED: Proper type checking before calling send
        if (worker.send && typeof worker.send === "function") {
          worker.send({ chunk });
        } else {
          log(
            "main",
            "MAIN-PRIMARY",
            `ERROR: Worker ${i} does not have a send function!`,
            "error",
          );
        }
        worker.on("message", (msg: unknown) => {
          // IMPROVED: Using type-safe interface and type guard
          if (isWorkerMessage(msg)) {
            this.accountSummaries.push(...msg.data);
          }
        });
      }

      cluster.on("exit", (worker: Worker, code: number) => {
        this.activeWorkers -= 1;

        log(
          "main",
          "MAIN-WORKER",
          `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`,
          "warn",
        );

        // Optional: restart crashed worker (basic heuristic) if crashRecovery allows
        const cr = this.config.crashRecovery;
        if (cr?.restartFailedWorker && code !== 0 && worker.id) {
          const attempts =
            (worker as { _restartAttempts?: number })._restartAttempts || 0;
          if (attempts < (cr.restartFailedWorkerAttempts ?? 1)) {
            (worker as { _restartAttempts?: number })._restartAttempts =
              attempts + 1;
            log(
              "main",
              "CRASH-RECOVERY",
              `Respawning worker (attempt ${attempts + 1})`,
              "warn",
            );

            const originalChunk = workerChunkMap.get(worker.id);
            const newW = cluster.fork();

            if (originalChunk && originalChunk.length > 0 && newW.id) {
              (newW as { send?: (m: { chunk: Account[] }) => void }).send?.({
                chunk: originalChunk,
              });
              workerChunkMap.set(newW.id, originalChunk);
              workerChunkMap.delete(worker.id);
              log(
                "main",
                "CRASH-RECOVERY",
                `Assigned ${originalChunk.length} account(s) to respawned worker`,
              );
            } else {
              log(
                "main",
                "CRASH-RECOVERY",
                "Warning: Could not reassign accounts to respawned worker",
                "warn",
              );
            }

            newW.on("message", (msg: unknown) => {
              // IMPROVED: Using type-safe interface and type guard
              if (isWorkerMessage(msg)) {
                this.accountSummaries.push(...msg.data);
              }
            });
          }
        }

        // Check if all workers have exited
        if (this.activeWorkers === 0) {
          void finishRun();
        }
      });
    });
  }

  private async runWorker() {
    log("main", "MAIN-WORKER", `Worker ${process.pid} spawned`);

    // Wait for chunk (either already received during init, or will arrive soon)
    const chunk = await new Promise<Account[]>((resolve) => {
      if (global.__workerChunk) {
        const bufferedChunk = global.__workerChunk;
        global.__workerChunk = undefined;
        resolve(bufferedChunk);
        return;
      }

      const handleMessage = (message: unknown): void => {
        if (isWorkerChunkMessage(message)) {
          process.off("message", handleMessage);
          resolve(message.chunk);
        }
      };

      process.on("message", handleMessage);
    });

    if (!chunk || chunk.length === 0) {
      log(
        "main",
        "MAIN-WORKER",
        `ERROR: Worker ${process.pid} received empty or undefined chunk!`,
        "error",
      );
      return;
    }

    const passes = this.config.passesPerRun ?? 1;
    for (let pass = 1; pass <= passes; pass++) {
      if (passes > 1) {
        log("main", "MAIN-WORKER", `Starting pass ${pass}/${passes}`);
      }
      await this.runTasks(chunk, pass, passes);
      if (pass < passes) {
        log(
          "main",
          "MAIN-WORKER",
          `Completed pass ${pass}/${passes}. Waiting before next pass...`,
        );
        await this.utils.wait(TIMEOUTS.ONE_MINUTE);
      }
    }
  }

  private async runTasks(
    accounts: Account[],
    currentPass: number = 1,
    totalPasses: number = 1,
  ) {
    // Check if all accounts are already completed and prompt user
    // BUT skip this check for multi-pass runs (passes > 1) OR if not on first pass
    const accountDayKey = this.utils.getFormattedDate();
    const allCompleted = accounts.every((acc) =>
      this.shouldSkipAccount(acc.email, accountDayKey),
    );

    // Only check completion on first pass and if not doing multiple passes
    if (
      allCompleted &&
      accounts.length > 0 &&
      currentPass === 1 &&
      totalPasses === 1
    ) {
      log(
        "main",
        "TASK",
        `All accounts already completed on ${accountDayKey}`,
        "warn",
        "yellow",
      );
      const shouldReset = await this.promptResetJobState();
      if (shouldReset) {
        this.resetAllJobStates();
        log(
          "main",
          "TASK",
          "Job state reset - proceeding with all accounts",
          "log",
          "green",
        );
      } else {
        log("main", "TASK", "Keeping existing job state - exiting", "log");
        return;
      }
    } else if (allCompleted && accounts.length > 0 && currentPass > 1) {
      // Multi-pass mode: clear job state for this pass to allow re-running
      log(
        "main",
        "TASK",
        `Pass ${currentPass}/${totalPasses}: Clearing job state to allow account re-run`,
        "log",
        "cyan",
      );
      this.resetAllJobStates();
    }

    for (const account of accounts) {
      // If a global standby is active due to security/banned, stop processing further accounts
      if (this.globalStandby.active) {
        log(
          "main",
          "SECURITY",
          `Global standby active (${this.globalStandby.reason || "security-issue"}). Not proceeding to next accounts until resolved.`,
          "warn",
          "yellow",
        );
        break;
      }
      // Optional global stop after first ban
      if (
        this.config?.humanization?.stopOnBan === true &&
        this.bannedTriggered
      ) {
        log(
          "main",
          "TASK",
          `Stopping remaining accounts due to ban on ${this.bannedTriggered.email}: ${this.bannedTriggered.reason}`,
          "warn",
        );
        break;
      }
      const currentDayKey = this.utils.getFormattedDate();
      // Note: shouldSkipAccount already returns false for multi-pass runs (passesPerRun > 1)
      if (this.shouldSkipAccount(account.email, currentDayKey)) {
        log(
          "main",
          "TASK",
          `Skipping account ${account.email}: already completed on ${currentDayKey} (job-state resume)`,
          "warn",
        );
        continue;
      }

      // Log pass info for multi-pass runs
      if (totalPasses > 1) {
        log(
          "main",
          "TASK",
          `[Pass ${currentPass}/${totalPasses}] Processing account ${account.email}`,
          "log",
          "cyan",
        );
      }
      // Reset compromised state per account
      this.compromisedModeActive = false;
      this.compromisedReason = undefined;

      // If humanization allowed windows are configured, wait until within a window
      try {
        const windows: string[] | undefined =
          this.config?.humanization?.allowedWindows;
        if (Array.isArray(windows) && windows.length > 0) {
          const waitMs = this.computeWaitForAllowedWindow(windows);
          if (waitMs > 0) {
            log(
              "main",
              "HUMANIZATION",
              `Waiting ${Math.ceil(waitMs / 1000)}s until next allowed window before starting ${account.email}`,
              "warn",
            );
            await new Promise<void>((r) => setTimeout(r, waitMs));
          }
        }
      } catch {
        /* ignore */
      }
      this.currentAccountEmail = account.email;
      // IMPROVED: Use centralized recovery email validation utility
      this.currentAccountRecoveryEmail = normalizeRecoveryEmail(
        account.recoveryEmail,
      );
      this.currentAccountPhoneNumber = account.phoneNumber;
      const runNumber = (this.accountRunCounts.get(account.email) ?? 0) + 1;
      this.accountRunCounts.set(account.email, runNumber);
      log("main", "MAIN-WORKER", `Started tasks for account ${account.email}`);

      const accountStart = Date.now();
      let desktopInitial = 0;
      let mobileInitial = 0;
      let desktopCollected = 0;
      let mobileCollected = 0;
      const errors: string[] = [];
      const banned = { status: false, reason: "" };

      this.axios = new AxiosClient(account.proxy);
      this.queryEngine = this.buildQueryEngine();
      const verbose = process.env.DEBUG_REWARDS_VERBOSE === "1";

      if (this.config.dryRun) {
        log(
          "main",
          "DRY-RUN",
          `Dry run: skipping automation for ${account.email}`,
        );
        const summary: AccountSummary = {
          email: account.email,
          durationMs: 0,
          desktopCollected: 0,
          mobileCollected: 0,
          totalCollected: 0,
          initialTotal: 0,
          endTotal: 0,
          errors: [],
          banned,
        };
        this.accountSummaries.push(summary);
        this.persistAccountCompletion(account.email, accountDayKey, summary);
        continue;
      }

      if (this.config.parallel) {
        const mobileInstance = new MicrosoftRewardsBot(true);
        mobileInstance.axios = this.axios;
        mobileInstance.queryEngine = this.queryEngine;

        // IMPROVED: Shared state to track desktop issues for early mobile abort consideration
        let desktopDetectedIssue = false;

        // Run both and capture results with detailed logging
        const desktopPromise = this.Desktop(account).catch((e: unknown) => {
          const msg = getErrorMessage(e);
          log(
            false,
            "TASK",
            `Desktop flow failed early for ${account.email}: ${msg}`,
            "error",
          );
          const bd = detectBanReason(e);
          if (bd.status) {
            desktopDetectedIssue = true; // Track issue for logging
            banned.status = true;
            banned.reason = bd.reason.substring(0, 200);
            void this.handleImmediateBanAlert(account.email, banned.reason);
          }
          errors.push(formatFullError("desktop", e, verbose));
          return null;
        });
        const mobilePromise = mobileInstance
          .Mobile(account)
          .catch((e: unknown) => {
            const msg = getErrorMessage(e);
            log(
              true,
              "TASK",
              `Mobile flow failed early for ${account.email}: ${msg}`,
              "error",
            );
            const bd = detectBanReason(e);
            if (bd.status) {
              banned.status = true;
              banned.reason = bd.reason.substring(0, 200);
              void this.handleImmediateBanAlert(account.email, banned.reason);
            }
            errors.push(formatFullError("mobile", e, verbose));
            return null;
          });
        const [desktopResult, mobileResult] = await Promise.allSettled([
          desktopPromise,
          mobilePromise,
        ]);

        // Log if desktop detected issue (helps identify when both flows ran despite ban)
        if (desktopDetectedIssue) {
          log(
            "main",
            "TASK",
            `Desktop detected security issue for ${account.email} during parallel execution. Future enhancement: implement AbortController for early mobile cancellation.`,
            "warn",
          );
        }

        // Handle desktop result
        if (desktopResult.status === "fulfilled" && desktopResult.value) {
          desktopInitial = desktopResult.value.initialPoints;
          desktopCollected = desktopResult.value.collectedPoints;
        } else if (desktopResult.status === "rejected") {
          log(
            false,
            "TASK",
            `Desktop promise rejected unexpectedly: ${shortErr(desktopResult.reason)}`,
            "error",
          );
          errors.push(
            formatFullError("desktop-rejected", desktopResult.reason, verbose),
          );
        }

        // Handle mobile result
        if (mobileResult.status === "fulfilled" && mobileResult.value) {
          mobileInitial = mobileResult.value.initialPoints;
          mobileCollected = mobileResult.value.collectedPoints;
        } else if (mobileResult.status === "rejected") {
          log(
            true,
            "TASK",
            `Mobile promise rejected unexpectedly: ${shortErr(mobileResult.reason)}`,
            "error",
          );
          errors.push(
            formatFullError("mobile-rejected", mobileResult.reason, verbose),
          );
        }
      } else {
        // Sequential execution with safety checks
        this.isMobile = false;
        const desktopResult = await this.Desktop(account).catch((e) => {
          const msg = getErrorMessage(e);
          log(
            false,
            "TASK",
            `Desktop flow failed early for ${account.email}: ${msg}`,
            "error",
          );
          const bd = detectBanReason(e);
          if (bd.status) {
            banned.status = true;
            banned.reason = bd.reason.substring(0, 200);
            void this.handleImmediateBanAlert(account.email, banned.reason);
          }
          errors.push(formatFullError("desktop", e, verbose));
          return null;
        });
        if (desktopResult) {
          desktopInitial = desktopResult.initialPoints;
          desktopCollected = desktopResult.collectedPoints;
        }

        if (!banned.status && !this.compromisedModeActive) {
          this.isMobile = true;
          const mobileResult = await this.Mobile(account).catch(
            (e: unknown) => {
              const msg = getErrorMessage(e);
              log(
                true,
                "TASK",
                `Mobile flow failed early for ${account.email}: ${msg}`,
                "error",
              );
              const bd = detectBanReason(e);
              if (bd.status) {
                banned.status = true;
                banned.reason = bd.reason.substring(0, 200);
                void this.handleImmediateBanAlert(account.email, banned.reason);
              }
              errors.push(formatFullError("mobile", e, verbose));
              return null;
            },
          );
          if (mobileResult) {
            mobileInitial = mobileResult.initialPoints;
            mobileCollected = mobileResult.collectedPoints;
          }
        } else {
          const why = banned.status ? "banned status" : "compromised status";
          log(
            true,
            "TASK",
            `Skipping mobile flow for ${account.email} due to ${why}`,
            "warn",
          );
        }
      }

      const accountEnd = Date.now();
      const durationMs = accountEnd - accountStart;
      const totalCollected = desktopCollected + mobileCollected;

      // Sequential mode: desktop runs first, mobile starts with desktop's end points
      // Parallel mode: both start from same baseline, take minimum to avoid double-count
      const initialTotal = this.config.parallel
        ? Math.min(desktopInitial || Infinity, mobileInitial || Infinity)
        : desktopInitial || mobileInitial || 0;

      const endTotal = initialTotal + totalCollected;

      const summary: AccountSummary = {
        email: account.email,
        durationMs,
        desktopCollected,
        mobileCollected,
        totalCollected,
        initialTotal,
        endTotal,
        errors,
        banned,
      };

      this.accountSummaries.push(summary);
      this.persistAccountCompletion(account.email, accountDayKey, summary);

      // Track banned accounts for later security alert (after conclusion webhook)
      if (banned.status) {
        this.bannedTriggered = { email: account.email, reason: banned.reason };
        // Enter global standby mode flag (will be processed after sending conclusion)
        this.globalStandby = {
          active: true,
          reason: `banned:${banned.reason}`,
        };
      }

      await log(
        "main",
        "MAIN-WORKER",
        `Completed tasks for account ${account.email}`,
        "log",
        "green",
      );
    }

    await log(
      this.isMobile,
      "MAIN-PRIMARY",
      "Completed tasks for ALL accounts",
      "log",
      "green",
    );
    // Extra diagnostic summary when verbose
    if (process.env.DEBUG_REWARDS_VERBOSE === "1") {
      for (const summary of this.accountSummaries) {
        log(
          "main",
          "SUMMARY-DEBUG",
          `Account ${summary.email} collected D:${summary.desktopCollected} M:${summary.mobileCollected} TOTAL:${summary.totalCollected} ERRORS:${summary.errors.length ? summary.errors.join(";") : "none"}`,
        );
      }
    }

    // IMPROVED: Always send conclusion webhook first (with results), then handle security alerts
    // This ensures we get the summary even if bans are detected
    if (this.config.clusters > 1 && !cluster.isPrimary) {
      // Worker mode: send summaries to primary
      if (process.send) {
        process.send({ type: "summary", data: this.accountSummaries });
      }
    } else {
      // Single process mode: send conclusion with all results (including banned accounts)
      await this.sendConclusion(this.accountSummaries);
    }

    // After sending conclusion, handle security standby if needed
    if (this.compromisedModeActive || this.globalStandby.active) {
      // Send security alert AFTER conclusion webhook
      if (this.bannedTriggered) {
        await this.sendGlobalSecurityStandbyAlert(
          this.bannedTriggered.email,
          `Ban detected: ${this.bannedTriggered.reason || "unknown"}`,
        );
      }

      log(
        "main",
        "SECURITY",
        "Security alert active. Process kept alive for manual review. Press CTRL+C to exit when done.",
        "warn",
        "yellow",
      );
      // Periodic heartbeat with cleanup on exit
      const standbyInterval = setInterval(
        () => {
          log(
            "main",
            "SECURITY",
            "Standby mode active: sessions kept open for review...",
            "warn",
            "yellow",
          );
        },
        5 * 60 * 1000,
      );

      // Cleanup on process exit
      process.once("SIGINT", () => {
        clearInterval(standbyInterval);
        process.exit(0);
      });
      process.once("SIGTERM", () => {
        clearInterval(standbyInterval);
        process.exit(0);
      });
      return;
    }

    // Don't exit here - let the caller decide (enables scheduler mode)
    // For one-time runs, the caller (bootstrap) will exit after run() returns
    // For scheduled mode, the scheduler keeps the process alive
    return;
  }

  /**
   * Send immediate ban alert if configured (deprecated in favor of conclusion webhook)
   * IMPROVED: This is now only used for real-time alerts during execution
   * The main security alert is sent AFTER conclusion webhook to avoid missing results
   */
  private async handleImmediateBanAlert(
    email: string,
    reason: string,
  ): Promise<void> {
    try {
      const h = this.config?.humanization;
      // Only send immediate alert if explicitly enabled (default: false to avoid duplicates)
      if (!h || h.immediateBanAlert !== true) return;

      const { sendSummaryWebhook } =
        await import("./util/notifications/ConclusionWebhook");
      await sendSummaryWebhook(
        this.config,
        "🚫 Ban Detected (Real-time)",
        `**Account:** ${email}\n**Reason:** ${reason || "detected by heuristics"}\n\n*Full summary will be sent after completion*`,
        undefined,
        DISCORD.COLOR_RED,
      );
    } catch (e) {
      log(
        "main",
        "ALERT",
        `Failed to send immediate ban alert: ${getErrorMessage(e)}`,

        "warn",
      );
    }
  }

  /**
   * Compute milliseconds to wait until within one of the allowed windows (HH:mm-HH:mm).
   * IMPROVED: Better documentation and validation
   *
   * @param windows - Array of time window strings in format "HH:mm-HH:mm"
   * @returns Milliseconds to wait (0 if already inside a window)
   *
   * @example
   * computeWaitForAllowedWindow(['09:00-17:00']) // Wait until 9 AM if outside window
   * computeWaitForAllowedWindow(['22:00-02:00']) // Handles midnight crossing
   */
  private computeWaitForAllowedWindow(windows: string[]): number {
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    let nextStartMins: number | null = null;

    for (const w of windows) {
      const [start, end] = w.split("-");
      if (!start || !end) continue;

      const pStart = start.split(":").map((v) => parseInt(v, 10));
      const pEnd = end.split(":").map((v) => parseInt(v, 10));
      if (pStart.length !== 2 || pEnd.length !== 2) continue;

      const sh = pStart[0]!,
        sm = pStart[1]!;
      const eh = pEnd[0]!,
        em = pEnd[1]!;

      // Validate hours and minutes ranges
      if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) continue;
      if (sh < 0 || sh > 23 || eh < 0 || eh > 23) continue;
      if (sm < 0 || sm > 59 || em < 0 || em > 59) continue;

      const s = sh * 60 + sm;
      const e = eh * 60 + em;

      if (s <= e) {
        // Same-day window (e.g., 09:00-17:00)
        if (minsNow >= s && minsNow <= e) return 0;
        if (minsNow < s) nextStartMins = Math.min(nextStartMins ?? s, s);
      } else {
        // Wraps past midnight (e.g., 22:00-02:00)
        if (minsNow >= s || minsNow <= e) return 0;
        nextStartMins = Math.min(nextStartMins ?? s, s);
      }
    }

    const msPerMin = 60 * 1000;
    if (nextStartMins != null) {
      const targetTodayMs = (nextStartMins - minsNow) * msPerMin;
      return targetTodayMs > 0
        ? targetTodayMs
        : (24 * 60 + nextStartMins - minsNow) * msPerMin;
    }

    // No valid windows parsed -> do not block
    return 0;
  }

  async Desktop(account: Account) {
    log(false, "FLOW", "Desktop() - delegating to DesktopFlow module");
    const desktopFlow = new DesktopFlow(this);
    return await desktopFlow.run(account);
  }

  async Mobile(
    account: Account,
    retryTracker = new MobileRetryTracker(
      this.config.searchSettings.retryMobileSearchAmount,
    ),
  ): Promise<{ initialPoints: number; collectedPoints: number }> {
    log(true, "FLOW", "Mobile() - delegating to MobileFlow module");
    const mobileFlow = new MobileFlow(this);
    return await mobileFlow.run(account, retryTracker);
  }

  private async sendConclusion(summaries: AccountSummary[]) {
    if (summaries.length === 0) return;

    // Convert AccountSummary to AccountResult format with full statistics
    const accountResults: AccountResult[] = summaries.map((s) => ({
      email: s.email,
      pointsEarned: s.totalCollected,
      runDuration: s.durationMs,
      initialPoints: s.initialTotal,
      finalPoints: s.endTotal,
      desktopPoints: s.desktopCollected,
      mobilePoints: s.mobileCollected,
      errors: s.errors.length > 0 ? s.errors : undefined,
      banned: s.banned?.status ?? false,
    }));

    const startTime = new Date(
      Date.now() - summaries.reduce((sum, s) => sum + s.durationMs, 0),
    );
    const endTime = new Date();

    // Use SummaryReporter for modern reporting (with account history tracking)
    const reporter = new SummaryReporter(this.config, this.accounts);
    const summary = reporter.createSummary(accountResults, startTime, endTime);

    // Generate console output and send notifications (webhooks, ntfy, job state)
    await reporter.generateReport(summary);
  }

  /**
   * Run optional auto-update script based on configuration flags
   * IMPROVED: Added better documentation and error handling
   *
   * @returns Exit code (0 = success, non-zero = error)
   */
  async runAutoUpdate(): Promise<number> {
    const upd = this.config.update;
    if (!upd) return 0;

    // Check if updates are enabled
    if (upd.enabled === false) {
      log(
        "main",
        "UPDATE",
        "Updates disabled in config (update.enabled = false)",
      );
      return 0;
    }

    const scriptRel = upd.scriptPath || "scripts/installer/update.mjs";
    const scriptAbs = path.join(process.cwd(), scriptRel);

    if (!fs.existsSync(scriptAbs)) {
      log("main", "UPDATE", `Update script not found: ${scriptAbs}`, "warn");
      return 0;
    }

    // New update.mjs uses GitHub API only and takes no CLI arguments
    log("main", "UPDATE", `Running update script: ${scriptRel}`, "log");

    // Run update script as a child process and capture exit code
    return new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [scriptAbs], { stdio: "inherit" });
      child.on("close", (code) => {
        log(
          "main",
          "UPDATE",
          `Update script exited with code ${code ?? 0}`,
          code === 0 ? "log" : "warn",
        );
        resolve(code ?? 0);
      });
      child.on("error", (err) => {
        log("main", "UPDATE", `Update script error: ${err.message}`, "error");
        resolve(1);
      });
    });
  }

  /**
   * Engage global security standby mode (halts all automation)
   * IMPROVED: Enhanced documentation
   *
   * Public entry-point to engage global security standby from other modules.
   * This method is idempotent - calling it multiple times has no additional effect.
   *
   * @param reason - Reason for standby (e.g., 'banned', 'recovery-mismatch')
   * @param email - Optional email of the affected account
   *
   * @example
   * await bot.engageGlobalStandby('recovery-mismatch', 'user@example.com')
   */
  public async engageGlobalStandby(
    reason: string,
    email?: string,
  ): Promise<void> {
    try {
      // Idempotent: don't re-engage if already active
      if (this.globalStandby.active) return;

      this.globalStandby = { active: true, reason };
      const who = email || this.currentAccountEmail || "unknown";
      await this.sendGlobalSecurityStandbyAlert(who, reason);
    } catch (error) {
      // Fail silently - standby engagement is a best-effort security measure
      log(
        "main",
        "STANDBY",
        `Failed to engage standby: ${getErrorMessage(error)}`,

        "warn",
      );
    }
  }

  /** Send a strong alert to all channels and mention @everyone when entering global security standby. */
  private async sendGlobalSecurityStandbyAlert(
    email: string,
    reason: string,
  ): Promise<void> {
    try {
      const { sendSummaryWebhook } =
        await import("./util/notifications/ConclusionWebhook");
      await sendSummaryWebhook(
        this.config,
        "🚨 Critical Security Alert",
        `**Account:** ${email}\n**Issue:** ${reason}\n**Status:** All accounts paused pending review`,
        undefined,
        DISCORD.COLOR_RED,
      );
    } catch (e) {
      log(
        "main",
        "ALERT",
        `Failed to send alert: ${getErrorMessage(e)}`,

        "warn",
      );
    }
  }
}

interface AccountSummary {
  email: string;
  durationMs: number;
  desktopCollected: number;
  mobileCollected: number;
  totalCollected: number;
  initialTotal: number;
  endTotal: number;
  errors: string[];
  banned?: { status: boolean; reason: string };
}

/**
 * IMPROVED: Type-safe worker message interface
 * Replaces inline type assertion for better type safety
 */
interface WorkerMessage {
  type: "summary";
  data: AccountSummary[];
}

/**
 * Type guard to validate worker message structure
 */
function isWorkerMessage(msg: unknown): msg is WorkerMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Partial<WorkerMessage>;
  return m.type === "summary" && Array.isArray(m.data);
}

interface WorkerChunkMessage {
  chunk: Account[];
}

function isWorkerChunkMessage(message: unknown): message is WorkerChunkMessage {
  if (!message || typeof message !== "object") return false;
  return Array.isArray((message as WorkerChunkMessage).chunk);
}

declare global {
  // eslint-disable-next-line no-var
  var __workerChunk: Account[] | undefined;
}

// Use utility functions from Utils.ts
const shortErr = shortErrorMessage;
const formatFullError = formatDetailedError;

async function main(): Promise<void> {
  // FIX: Set up message listener early to prevent race condition
  // Workers initialize for ~2 seconds before reaching runWorker(), so messages
  // sent by primary during initialization would be lost without this early listener
  if (!cluster.isPrimary && cluster.worker) {
    const bufferChunk = (message: unknown): void => {
      if (isWorkerChunkMessage(message)) {
        global.__workerChunk = message.chunk;
        process.off("message", bufferChunk);
      }
    };

    process.on("message", bufferChunk);
  }

  // Check for dashboard mode flag (standalone dashboard)
  if (cluster.isPrimary && process.argv.includes("-dashboard")) {
    const { startDashboardServer } = await import("./dashboard/server");
    const { dashboardState } = await import("./dashboard/state");
    log("main", "DASHBOARD", "Starting standalone dashboard server...");

    // Load and initialize accounts
    try {
      const accounts = loadAccounts();
      dashboardState.initializeAccounts(accounts.map((a) => a.email));
      log(
        "main",
        "DASHBOARD",
        `Initialized ${accounts.length} accounts in dashboard`,
      );
    } catch (error) {
      log(
        "main",
        "DASHBOARD",
        `Could not load accounts: ${getErrorMessage(error)}`,
        "warn",
      );
    }

    startDashboardServer();
    return;
  }

  const rewardsBot = new MicrosoftRewardsBot(false);

  const crashState = { restarts: 0 };
  const config = rewardsBot.config;

  // Scheduler instance (initialized in bootstrap if enabled)
  let scheduler: InternalScheduler | null = null;

  // Auto-start dashboard if enabled in config
  if (cluster.isPrimary && config.dashboard?.enabled) {
    const { DashboardServer } = await import("./dashboard/server");
    const { dashboardState } = await import("./dashboard/state");
    const port = config.dashboard.port || 3000;
    const host = config.dashboard.host || "127.0.0.1";

    // Override env vars with config values
    process.env.DASHBOARD_PORT = String(port);
    process.env.DASHBOARD_HOST = host;

    // Initialize dashboard with accounts
    const accounts = loadAccounts();
    dashboardState.initializeAccounts(accounts.map((a) => a.email));

    const dashboardServer = new DashboardServer();
    dashboardServer.start();
    log(
      "main",
      "DASHBOARD",
      `Auto-started dashboard on http://${host}:${port}`,
    );
  }

  /**
   * Attach global error handlers for graceful shutdown
   * IMPROVED: Added error handling documentation
   */
  const attachHandlers = () => {
    process.on("unhandledRejection", (reason: unknown) => {
      const errorMsg = getErrorMessage(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      log(
        "main",
        "FATAL",
        `UnhandledRejection: ${errorMsg}${stack ? `\nStack: ${stack.split("\n").slice(0, 3).join(" | ")}` : ""}`,
        "error",
      );
      scheduler?.stop(); // Stop scheduler before exit
      stopWebhookCleanup();
      gracefulExit(1);
    });
    process.on("uncaughtException", (err: Error) => {
      log(
        "main",
        "FATAL",
        `UncaughtException: ${err.message}${err.stack ? `\nStack: ${err.stack.split("\n").slice(0, 3).join(" | ")}` : ""}`,
        "error",
      );
      scheduler?.stop(); // Stop scheduler before exit
      stopWebhookCleanup();
      stopMemoryMonitor(); // Stop memory monitoring before exit
      gracefulExit(1);
    });
    process.on("SIGTERM", () => {
      log(
        "main",
        "SHUTDOWN",
        "Received SIGTERM, shutting down gracefully...",
        "log",
      );
      scheduler?.stop(); // Stop scheduler before exit
      stopWebhookCleanup();
      stopMemoryMonitor(); // Stop memory monitoring before exit
      gracefulExit(0);
    });
    process.on("SIGINT", () => {
      log(
        "main",
        "SHUTDOWN",
        "Received SIGINT (Ctrl+C), shutting down gracefully...",
        "log",
      );
      scheduler?.stop(); // Stop scheduler before exit
      stopWebhookCleanup();
      stopMemoryMonitor(); // Stop memory monitoring before exit
      gracefulExit(0);
    });
  };

  const gracefulExit = (code: number) => {
    if (config?.crashRecovery?.autoRestart && code !== 0) {
      const max = config.crashRecovery.maxRestarts ?? 2;
      if (crashState.restarts < max) {
        const backoff =
          (config.crashRecovery.backoffBaseMs ?? 2000) *
          (crashState.restarts + 1);
        log(
          "main",
          "CRASH-RECOVERY",
          `Scheduling restart in ${backoff}ms (attempt ${crashState.restarts + 1}/${max})`,
          "warn",
          "yellow",
        );
        setTimeout(() => {
          crashState.restarts++;
          bootstrap();
        }, backoff);
        return;
      }
    }
    process.exit(code);
  };

  /**
   * Detect if running in Docker container
   */
  const isDockerEnvironment = (): boolean => {
    try {
      // Check /.dockerenv file
      if (fs.existsSync("/.dockerenv")) return true;

      // Check /proc/1/cgroup
      if (fs.existsSync("/proc/1/cgroup")) {
        const content = fs.readFileSync("/proc/1/cgroup", "utf8");
        if (content.includes("docker") || content.includes("/kubepods/"))
          return true;
      }

      // Check environment variables
      if (
        process.env.DOCKER === "true" ||
        process.env.CONTAINER === "docker" ||
        process.env.KUBERNETES_SERVICE_HOST
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  const bootstrap = async () => {
    try {
      // STEP 1: Bootstrap configuration files (copy .example.jsonc if needed)
      log(
        "main",
        "BOOTSTRAP",
        "Checking configuration files...",
        "log",
        "cyan",
      );
      const createdFiles = FileBootstrap.bootstrap();

      if (createdFiles.length > 0) {
        FileBootstrap.displayStartupMessage(createdFiles);

        // If accounts file was just created, it will be empty
        // User needs to configure before running
        if (createdFiles.includes("Accounts")) {
          log(
            "main",
            "BOOTSTRAP",
            "Please configure your accounts in src/accounts.jsonc before running the bot.",
            "warn",
            "yellow",
          );
          process.exit(0);
        }
      } else {
        // Files already exist - check for new options from .example.jsonc
        const mergeResult = FileBootstrap.smartMerge();
        if (mergeResult.messages.length > 0) {
          log(
            "main",
            "CONFIG",
            "Configuration updated with new options:",
            "log",
            "cyan",
          );
          mergeResult.messages.forEach((msg) =>
            log("main", "CONFIG", msg, "log", "cyan"),
          );
        }
      }

      // Check for updates BEFORE initializing and running tasks
      const updateMarkerPath = path.join(process.cwd(), ".update-happened");
      const isDocker = isDockerEnvironment();

      try {
        const updateResult = await rewardsBot.runAutoUpdate().catch((e) => {
          log(
            "main",
            "UPDATE",
            `Auto-update check failed: ${getErrorMessage(e)}`,

            "warn",
          );
          return -1;
        });

        if (updateResult === 0) {
          // Check if update marker exists (created by update.mjs when version changed)
          const updateHappened = fs.existsSync(updateMarkerPath);

          if (updateHappened) {
            // Remove marker file
            try {
              fs.unlinkSync(updateMarkerPath);
            } catch {
              // Ignore cleanup errors
            }

            if (isDocker) {
              // Docker mode: exit cleanly to let container restart
              log(
                "main",
                "UPDATE",
                "Update complete - exiting for container restart",
                "log",
                "green",
              );
              process.exit(0);
            } else {
              // Host mode: reload in same process
              // Clear Node's require cache to reload updated modules
              Object.keys(require.cache).forEach((key) => {
                // Only clear cache for project files, not node_modules
                if (key.includes("dist") || key.includes("src")) {
                  delete require.cache[key];
                }
              });

              // Recursive restart in same process
              log("main", "UPDATE", "Reloading with new version...");
              setTimeout(() => {
                bootstrap().catch((e) => {
                  log(
                    "main",
                    "MAIN-ERROR",
                    `Fatal after update: ${getErrorMessage(e)}`,
                    "error",
                  );
                  process.exit(1);
                });
              }, 500);
              return;
            }
          }
        }
      } catch (updateError) {
        log(
          "main",
          "UPDATE",
          `Update check failed (continuing): ${getErrorMessage(updateError)}`,

          "warn",
        );
      }

      // Check if scheduling is enabled
      if (config.scheduling?.enabled) {
        // IMPROVED: Start scheduler FIRST to show schedule info immediately, THEN run tasks
        // This gives users instant confirmation of the cron schedule without waiting for long execution
        log(
          "main",
          "MAIN",
          "Scheduling enabled - activating scheduler, then executing immediate run",
          "log",
          "cyan",
        );

        // Start memory monitoring for long-running scheduled sessions
        const memoryMonitor = getMemoryMonitor({
          warningThresholdMB: 500,
          criticalThresholdMB: 1024,
          leakRateMBPerHour: 50,
          samplingIntervalMs: 60000, // Sample every minute
        });
        memoryMonitor.start();

        // Initialize and start scheduler first
        scheduler = new InternalScheduler(config, async () => {
          try {
            await rewardsBot.initialize();
            await rewardsBot.run();
          } catch (error) {
            log(
              "main",
              "SCHEDULER-TASK",
              `Scheduled run failed: ${getErrorMessage(error)}`,

              "error",
            );
            throw error; // Re-throw for scheduler retry logic
          }
        });

        const schedulerStarted = scheduler.start();

        if (!schedulerStarted) {
          log("main", "MAIN", "Scheduler failed to start. Exiting.", "error");
          gracefulExit(1);
          return;
        }

        log(
          "main",
          "MAIN",
          "Bot running in scheduled mode. Process will stay alive.",
          "log",
          "green",
        );
        log(
          "main",
          "MAIN",
          "Press CTRL+C to stop the scheduler and exit.",
          "log",
          "cyan",
        );

        // Now run initial execution (scheduler already active for future runs)
        try {
          await rewardsBot.initialize();
          await rewardsBot.run();
          log(
            "main",
            "MAIN",
            "✓ Initial run completed successfully",
            "log",
            "green",
          );
        } catch (error) {
          log(
            "main",
            "MAIN",
            `Initial run failed: ${getErrorMessage(error)}`,

            "error",
          );
          // Scheduler still active - will retry at next scheduled time
        }

        // Keep process alive - scheduler handles future executions
        return;
      }

      // One-time execution (scheduling disabled)
      await rewardsBot.initialize();
      await rewardsBot.run();

      // Explicit exit for one-time runs (no scheduler to keep alive)
      log("main", "MAIN", "One-time run completed. Exiting.", "log", "green");
      gracefulExit(0);
    } catch (e) {
      log(
        "main",
        "MAIN-ERROR",
        `Fatal during run: ${getErrorMessage(e)}`,
        "error",
      );
      gracefulExit(1);
    }
  };

  attachHandlers();
  await bootstrap();
}

// Start the bots
if (require.main === module) {
  main().catch((error) => {
    log("main", "MAIN-ERROR", `Error running bots: ${error}`, "error");
    process.exit(1);
  });
}
