import { Request, Response, Router } from "express";
import fs from "fs";
import path from "path";
import { getErrorMessage } from "../util/core/Utils";
import { AccountHistory } from "../util/state/AccountHistory";
import { getConfigPath, loadAccounts, loadConfig } from "../util/state/Load";
import { botController } from "./BotController";
import { dashboardState } from "./state";
import { statsManager } from "./StatsManager";

export const apiRouter = Router();

// Initialize account history tracker (lazy loaded)
let accountHistoryInstance: AccountHistory | null = null;

function getAccountHistory(): AccountHistory {
  if (!accountHistoryInstance) {
    const accounts = loadAccounts();
    accountHistoryInstance = new AccountHistory(accounts);
  }
  return accountHistoryInstance;
}

// Short alias for the centralized error message extractor
const getErr = getErrorMessage;

// Helper to load accounts if not already loaded
function ensureAccountsLoaded(): void {
  const accounts = dashboardState.getAccounts();
  if (accounts.length === 0) {
    try {
      const loadedAccounts = loadAccounts();
      dashboardState.initializeAccounts(loadedAccounts.map((a) => a.email));
    } catch {
      // Silently ignore: accounts loading is optional for API fallback
    }
  }
}

// GET /api/status - Bot status
apiRouter.get("/status", (_req: Request, res: Response) => {
  try {
    ensureAccountsLoaded();
    res.json(dashboardState.getStatus());
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/accounts - List all accounts with masked emails
apiRouter.get("/accounts", (_req: Request, res: Response) => {
  try {
    ensureAccountsLoaded();
    res.json(dashboardState.getAccounts());
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/logs - Recent logs
apiRouter.get("/logs", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const logs = dashboardState.getLogs(Math.min(limit, 500));
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// DELETE /api/logs - Clear logs
apiRouter.delete("/logs", (_req: Request, res: Response) => {
  try {
    dashboardState.clearLogs();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/history - Recent run summaries
apiRouter.get("/history", (_req: Request, res: Response): void => {
  try {
    const reportsDir = path.join(process.cwd(), "reports");
    if (!fs.existsSync(reportsDir)) {
      res.json([]);
      return;
    }

    const days = fs
      .readdirSync(reportsDir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse()
      .slice(0, 7);
    const summaries: unknown[] = [];

    for (const day of days) {
      const dayDir = path.join(reportsDir, day);
      const files = fs
        .readdirSync(dayDir)
        .filter((f) => f.startsWith("summary_") && f.endsWith(".json"));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dayDir, file), "utf-8");
          summaries.push(JSON.parse(content));
        } catch {
          continue;
        }
      }
    }

    res.json(summaries.slice(0, 50));
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/config - Current config (tokens masked)
apiRouter.get("/config", (_req: Request, res: Response) => {
  try {
    // CRITICAL: Load raw config.jsonc to preserve comments
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      res.status(404).json({ error: "Config file not found" });
      return;
    }

    // Read raw JSONC content (preserves comments)
    const rawConfig = fs.readFileSync(configPath, "utf-8");

    // Parse and sanitize for display
    const config = loadConfig();
    const safe = JSON.parse(JSON.stringify(config));

    // Mask sensitive data (but keep structure)
    if (safe.webhook?.url) safe.webhook.url = maskUrl(safe.webhook.url);
    if (safe.conclusionWebhook?.url)
      safe.conclusionWebhook.url = maskUrl(safe.conclusionWebhook.url);
    if (safe.ntfy?.authToken) safe.ntfy.authToken = "***";

    // WARNING: Show user this is read-only view
    res.json({
      config: safe,
      warning:
        "This is a simplified view. Direct file editing recommended for complex changes.",
      rawPreview: rawConfig.split("\n").slice(0, 10).join("\n") + "\n...", // First 10 lines
    });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// POST /api/config - Update config (DISABLED - manual editing only)
apiRouter.post("/config", (req: Request, res: Response): void => {
  // DISABLED: Config editing via API is unsafe (loses JSONC comments)
  // Users should edit config.jsonc manually
  res.status(403).json({
    error: "Config editing via dashboard is disabled to preserve JSONC format.",
    hint: "Please edit src/config.jsonc manually with a text editor.",
  });
});

// POST /api/start - Start bot in background
apiRouter.post(
  "/start",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = botController.getStatus();
      if (status.running) {
        sendError(res, 400, `Bot already running (PID: ${status.pid})`);
        return;
      }

      const result = await botController.start();

      if (result.success) {
        sendSuccess(res, {
          message: "Bot started successfully",
          pid: result.pid,
        });
      } else {
        sendError(res, 500, result.error || "Failed to start bot");
      }
    } catch (error) {
      sendError(res, 500, getErr(error));
    }
  },
);

// POST /api/stop - Stop bot
apiRouter.post("/stop", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await botController.stop();

    if (result.success) {
      sendSuccess(res, { message: "Bot stopped successfully" });
    } else {
      sendError(res, 400, result.error || "Failed to stop bot");
    }
  } catch (error) {
    sendError(res, 500, getErr(error));
  }
});

// POST /api/restart - Restart bot
apiRouter.post(
  "/restart",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await botController.restart();

      if (result.success) {
        sendSuccess(res, {
          message: "Bot restarted successfully",
          pid: result.pid,
        });
      } else {
        sendError(res, 500, result.error || "Failed to restart bot");
      }
    } catch (error) {
      sendError(res, 500, getErr(error));
    }
  },
);

// POST /api/run-single - Run a single account (dashboard feature)
apiRouter.post(
  "/run-single",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { email } = req.body;

      if (!email) {
        sendError(res, 400, "Email is required");
        return;
      }

      const status = botController.getStatus();
      if (status.running) {
        sendError(
          res,
          400,
          `Bot already running (PID: ${status.pid}). Stop it first.`,
        );
        return;
      }

      const result = await botController.runSingle(email);

      if (result.success) {
        sendSuccess(res, {
          message: `Started bot for account ${email}`,
          pid: result.pid,
        });
      } else {
        sendError(res, 500, result.error || "Failed to start bot for account");
      }
    } catch (error) {
      sendError(res, 500, getErr(error));
    }
  },
);

// GET /api/metrics - Basic metrics
apiRouter.get("/metrics", (_req: Request, res: Response) => {
  try {
    const accounts = dashboardState.getAccounts();
    const totalPoints = accounts.reduce((sum, a) => sum + (a.points || 0), 0);
    const accountsWithErrors = accounts.filter(
      (a) => a.errors && a.errors.length > 0,
    ).length;
    const avgPoints =
      accounts.length > 0 ? Math.round(totalPoints / accounts.length) : 0;

    // Load persistent stats
    const globalStats = statsManager.loadGlobalStats();
    const todayStats = statsManager.loadDailyStats(
      new Date().toISOString().slice(0, 10),
    );

    res.json({
      // Current session metrics
      totalAccounts: accounts.length,
      totalPoints,
      avgPoints,
      accountsWithErrors,
      accountsRunning: accounts.filter((a) => a.status === "running").length,
      accountsCompleted: accounts.filter((a) => a.status === "completed")
        .length,
      accountsIdle: accounts.filter((a) => a.status === "idle").length,
      accountsError: accounts.filter((a) => a.status === "error").length,

      // Persistent stats
      globalStats: {
        totalRunsAllTime: globalStats.totalRunsAllTime,
        totalPointsAllTime: globalStats.totalPointsAllTime,
        averagePointsPerDay: globalStats.averagePointsPerDay,
        lastRunDate: globalStats.lastRunDate,
        firstRunDate: globalStats.firstRunDate,
      },

      // Today's stats
      todayStats: todayStats || {
        totalPoints: 0,
        accountsCompleted: 0,
        accountsWithErrors: 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/stats/history/:days - Get stats history
apiRouter.get("/stats/history/:days", (req: Request, res: Response) => {
  try {
    const daysParam = req.params.days;
    if (!daysParam) {
      res.status(400).json({ error: "Days parameter required" });
      return;
    }
    const days = Math.min(parseInt(daysParam, 10) || 7, 90);
    const history = statsManager.getLastNDays(days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// POST /api/stats/record - Record new stats (called by bot after run)
apiRouter.post("/stats/record", (req: Request, res: Response) => {
  try {
    const {
      pointsEarned,
      accountsCompleted,
      accountsWithErrors,
      totalSearches,
      totalActivities,
      runDuration,
    } = req.body;

    const today = new Date().toISOString().slice(0, 10);
    const existingStats = statsManager.loadDailyStats(today);

    // Merge with existing stats if run multiple times today
    const dailyStats = {
      date: today,
      totalPoints: (existingStats?.totalPoints || 0) + (pointsEarned || 0),
      accountsCompleted:
        (existingStats?.accountsCompleted || 0) + (accountsCompleted || 0),
      accountsWithErrors:
        (existingStats?.accountsWithErrors || 0) + (accountsWithErrors || 0),
      totalSearches: (existingStats?.totalSearches || 0) + (totalSearches || 0),
      totalActivities:
        (existingStats?.totalActivities || 0) + (totalActivities || 0),
      runDuration: (existingStats?.runDuration || 0) + (runDuration || 0),
    };

    statsManager.saveDailyStats(dailyStats);
    statsManager.incrementGlobalStats(pointsEarned || 0);

    res.json({ success: true, stats: dailyStats });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/account/:email - Get specific account details
apiRouter.get("/account/:email", (req: Request, res: Response): void => {
  try {
    const { email } = req.params;
    if (!email) {
      res.status(400).json({ error: "Email parameter required" });
      return;
    }

    const account = dashboardState.getAccount(email);

    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    res.json(account);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// POST /api/account/:email/reset - Reset account status
apiRouter.post("/account/:email/reset", (req: Request, res: Response): void => {
  try {
    const { email } = req.params;
    if (!email) {
      res.status(400).json({ error: "Email parameter required" });
      return;
    }

    const account = dashboardState.getAccount(email);

    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    dashboardState.updateAccount(email, {
      status: "idle",
      errors: [],
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// POST /api/reset-state - Reset all job states for today
apiRouter.post("/reset-state", (_req: Request, res: Response): void => {
  try {
    const jobStatePath = path.join(process.cwd(), "sessions", "job-state");

    if (!fs.existsSync(jobStatePath)) {
      res.json({ success: true, message: "No job state to reset" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    let resetCount = 0;

    // Read all job state files and reset today's entries
    const files = fs
      .readdirSync(jobStatePath)
      .filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const filePath = path.join(jobStatePath, file);
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        // Reset today's completed activities
        if (content[today]) {
          delete content[today];
          fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
          resetCount++;
        }
      } catch {
        // Continue processing other files if one fails
        continue;
      }
    }

    // Reset account statuses in dashboard state
    const accounts = dashboardState.getAccounts();
    for (const account of accounts) {
      dashboardState.updateAccount(account.email, {
        status: "idle",
        errors: [],
      });
    }

    res.json({
      success: true,
      message: `Reset job state for ${resetCount} account(s)`,
      resetCount,
    });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/memory - Get current memory usage
apiRouter.get("/memory", (_req: Request, res: Response) => {
  try {
    const memUsage = process.memoryUsage();
    res.json({
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
      formatted: {
        heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(1)} MB`,
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`,
      },
    });
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/account-history - Get all account histories
apiRouter.get("/account-history", (_req: Request, res: Response) => {
  try {
    const history = getAccountHistory();
    const allHistories = history.getAllHistories();
    res.json(allHistories);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/account-history/:email - Get specific account history
apiRouter.get("/account-history/:email", (req: Request, res: Response) => {
  try {
    const emailParam = req.params.email;
    if (!emailParam) {
      res.status(400).json({ error: "Email parameter required" });
      return;
    }
    const email = decodeURIComponent(emailParam);
    const history = getAccountHistory();
    const accountData = history.getAccountHistory(email);
    res.json(accountData);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/account-stats/:email - Get account statistics
apiRouter.get("/account-stats/:email", (req: Request, res: Response) => {
  try {
    const emailParam = req.params.email;
    if (!emailParam) {
      res.status(400).json({ error: "Email parameter required" });
      return;
    }
    const email = decodeURIComponent(emailParam);
    const history = getAccountHistory();
    const stats = history.getStats(email);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/stats/historical - Get historical point data
apiRouter.get("/stats/historical", (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const historical = statsManager.getHistoricalStats(days);
    res.json(historical);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/stats/activity-breakdown - Get activity breakdown
apiRouter.get("/stats/activity-breakdown", (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const breakdown = statsManager.getActivityBreakdown(days);
    res.json(breakdown);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// GET /api/stats/global - Get global statistics
apiRouter.get("/stats/global", (_req: Request, res: Response) => {
  try {
    const global = statsManager.getGlobalStats();
    res.json(global);
  } catch (error) {
    res.status(500).json({ error: getErr(error) });
  }
});

// Helper to mask sensitive URLs
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const maskedHost =
      parsed.hostname.length > 6
        ? `${parsed.hostname.slice(0, 3)}***${parsed.hostname.slice(-3)}`
        : "***";
    const maskedPath =
      parsed.pathname.length > 5 ? `${parsed.pathname.slice(0, 3)}***` : "***";
    return `${parsed.protocol}//${maskedHost}${maskedPath}`;
  } catch {
    return "***";
  }
}

// Helper to send error response
function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

// Helper to send success response
function sendSuccess(res: Response, data: Record<string, unknown>): void {
  res.json({ success: true, ...data });
}
