import { TIMEOUTS } from "../constants";
import type { MicrosoftRewardsBot } from "../index";
import { getErrorMessage } from "../util/core/Utils";
import { log as botLog } from "../util/notifications/Logger";
import { dashboardState } from "./state";

export class BotController {
  private botInstance: MicrosoftRewardsBot | null = null;
  private startTime?: Date;
  private isStarting: boolean = false; // Race condition protection
  private stopRequested: boolean = false; // Stop signal flag
  private botProcess: Promise<void> | null = null; // Track bot execution

  constructor() {
    process.on("exit", () => this.stop());
  }

  private log(message: string, level: "log" | "warn" | "error" = "log"): void {
    botLog("main", "BOT-CONTROLLER", message, level);

    dashboardState.addLog({
      timestamp: new Date().toISOString(),
      level,
      platform: "MAIN",
      title: "BOT-CONTROLLER",
      message,
    });
  }

  public async start(): Promise<{
    success: boolean;
    error?: string;
    pid?: number;
  }> {
    // FIXED: Race condition protection - prevent multiple simultaneous start() calls
    if (this.botInstance) {
      return { success: false, error: "Bot is already running" };
    }

    if (this.isStarting) {
      return {
        success: false,
        error: "Bot is currently starting, please wait",
      };
    }

    try {
      this.isStarting = true;
      this.log("🚀 Starting bot...", "log");

      const { MicrosoftRewardsBot } = await import("../index");

      this.botInstance = new MicrosoftRewardsBot(false);
      this.startTime = new Date();
      dashboardState.setRunning(true);
      dashboardState.setBotInstance(this.botInstance);

      // Run bot asynchronously - don't block the API response
      this.botProcess = (async () => {
        try {
          this.log("✓ Bot initialized, starting execution...", "log");

          await this.botInstance!.initialize();

          // Check for stop signal before running
          if (this.stopRequested) {
            this.log("⚠ Stop requested before execution - aborting", "warn");
            return;
          }

          await this.botInstance!.run();

          this.log("✓ Bot completed successfully", "log");
        } catch (error) {
          // Check if error was due to stop signal
          if (this.stopRequested) {
            this.log("⚠ Bot stopped by user request", "warn");
          } else {
            this.log(`Bot error: ${getErrorMessage(error)}`, "error");
          }
        } finally {
          this.cleanup();
        }
      })();

      // Don't await - return immediately to unblock API
      return { success: true, pid: process.pid };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.log(`Failed to start bot: ${errorMsg}`, "error");
      this.cleanup();
      return { success: false, error: errorMsg };
    } finally {
      this.isStarting = false;
    }
  }

  public async stop(): Promise<{ success: boolean; error?: string }> {
    if (!this.botInstance) {
      return { success: false, error: "Bot is not running" };
    }

    try {
      this.log("🛑 Stopping bot...", "warn");
      this.log("⚠ Bot will complete current task before stopping", "warn");

      // Set stop flag
      this.stopRequested = true;

      // Wait for bot process to finish (with timeout)
      if (this.botProcess) {
        const timeout = new Promise((resolve) => setTimeout(resolve, 10000)); // 10s timeout
        await Promise.race([this.botProcess, timeout]);
      }

      this.cleanup();
      this.log("✓ Bot stopped successfully", "log");
      return { success: true };
    } catch (error) {
      const errorMsg = await getErrorMessage(error);
      this.log(`Error stopping bot: ${errorMsg}`, "error");
      this.cleanup();
      return { success: false, error: errorMsg };
    }
  }

  public async restart(): Promise<{
    success: boolean;
    error?: string;
    pid?: number;
  }> {
    this.log("🔄 Restarting bot...", "log");

    const stopResult = await this.stop();
    if (!stopResult.success && stopResult.error !== "Bot is not running") {
      return { success: false, error: `Failed to stop: ${stopResult.error}` };
    }

    await this.wait(TIMEOUTS.MEDIUM_LONG);

    return await this.start();
  }

  /**
   * Run a single account (for dashboard "run single" feature)
   * FIXED: Actually implement single account execution
   */
  public async runSingle(
    email: string,
  ): Promise<{ success: boolean; error?: string; pid?: number }> {
    if (this.botInstance) {
      return {
        success: false,
        error: "Bot is already running. Stop it first.",
      };
    }

    if (this.isStarting) {
      return {
        success: false,
        error: "Bot is currently starting, please wait",
      };
    }

    try {
      this.isStarting = true;
      this.log(`🚀 Starting bot for single account: ${email}`, "log");

      const { MicrosoftRewardsBot } = await import("../index");
      const { loadAccounts } = await import("../util/state/Load");

      // Load all accounts and filter to just this one
      const allAccounts = loadAccounts();
      const targetAccount = allAccounts.find((a) => a.email === email);

      if (!targetAccount) {
        return {
          success: false,
          error: `Account ${email} not found in accounts.jsonc`,
        };
      }

      this.botInstance = new MicrosoftRewardsBot(false);
      this.startTime = new Date();
      dashboardState.setRunning(true);
      dashboardState.setBotInstance(this.botInstance);

      // Update account status
      dashboardState.updateAccount(email, { status: "running", errors: [] });

      // Run bot asynchronously with single account
      this.botProcess = (async () => {
        try {
          this.log(
            `✓ Bot initialized for ${email}, starting execution...`,
            "log",
          );

          await this.botInstance!.initialize();

          // Check for stop signal
          if (this.stopRequested) {
            this.log(`⚠ Stop requested for ${email} - aborting`, "warn");
            dashboardState.updateAccount(email, { status: "idle" });
            return;
          }

          // Override accounts to run only this one
          this.botInstance!.setAccounts([targetAccount]);

          await this.botInstance!.run();

          this.log(`✓ Bot completed successfully for ${email}`, "log");
          dashboardState.updateAccount(email, { status: "completed" });
        } catch (error) {
          const errMsg = getErrorMessage(error);
          if (this.stopRequested) {
            this.log(`⚠ Bot stopped for ${email} by user request`, "warn");
            dashboardState.updateAccount(email, { status: "idle" });
          } else {
            this.log(`Bot error for ${email}: ${errMsg}`, "error");
            dashboardState.updateAccount(email, {
              status: "error",
              errors: [errMsg],
            });
          }
        } finally {
          this.cleanup();
        }
      })();

      return { success: true, pid: process.pid };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.log(`Failed to start bot for ${email}: ${errorMsg}`, "error");
      dashboardState.updateAccount(email, {
        status: "error",
        errors: [errorMsg],
      });
      this.cleanup();
      return { success: false, error: errorMsg };
    } finally {
      this.isStarting = false;
    }
  }

  private async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public getStatus(): {
    running: boolean;
    pid?: number;
    uptime?: number;
    startTime?: string;
  } {
    return {
      running: !!this.botInstance,
      pid: process.pid,
      uptime: this.startTime
        ? Date.now() - this.startTime.getTime()
        : undefined,
      startTime: this.startTime?.toISOString(),
    };
  }

  private cleanup(): void {
    this.botInstance = null;
    this.startTime = undefined;
    this.stopRequested = false;
    this.botProcess = null;
    dashboardState.setRunning(false);
    dashboardState.setBotInstance(undefined);
  }
}

export const botController = new BotController();
