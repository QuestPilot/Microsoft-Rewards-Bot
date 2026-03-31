import express from "express";
import rateLimit from "express-rate-limit";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { DISCORD } from "../constants";
import { computeErrorId } from "../util/core/ErrorId";
import { getErrorMessage } from "../util/core/Utils";
import { logEventEmitter } from "../util/notifications/Logger";
import { apiRouter } from "./routes";
import { DashboardLog, dashboardState } from "./state";

// Dashboard logging helper (uses events, NOT interception)
const dashLog = (
  message: string,
  type: "log" | "warn" | "error" = "log",
): void => {
  const logEntry: DashboardLog = {
    timestamp: new Date().toISOString(),
    level: type,
    platform: "MAIN",
    title: "DASHBOARD",
    message,
  };

  // Add to console
  console.log(
    `[${logEntry.timestamp}] [${logEntry.platform}] [${logEntry.title}] ${message}`,
  );

  // Add to dashboard state
  dashboardState.addLog(logEntry);
};

const PORT = process.env.DASHBOARD_PORT
  ? parseInt(process.env.DASHBOARD_PORT)
  : 3000;
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";

export class DashboardServer {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private heartbeatInterval?: NodeJS.Timeout;
  private dashboardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs for dashboard UI
    standardHeaders: true,
    legacyHeaders: false,
  });
  private apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // reasonable cap for API interactions
    standardHeaders: true,
    legacyHeaders: false,
  });
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupLogEventListener(); // FIXED: Use event listener instead of function interception
    this.setupStateListener();
  }

  private setupStateListener(): void {
    // Listen to dashboard state changes and broadcast to all clients
    dashboardState.addChangeListener((type, data) => {
      this.broadcastUpdate(type, data);
    });
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // Disable caching for all static files
    this.app.use((req, res, next) => {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      next();
    });

    this.app.use(
      "/assets",
      express.static(path.join(__dirname, "../../assets"), {
        etag: false,
        maxAge: 0,
      }),
    );
    this.app.use(
      express.static(path.join(__dirname, "../../public"), {
        etag: false,
        maxAge: 0,
      }),
    );
  }

  private setupRoutes(): void {
    this.app.use("/api", this.apiLimiter, apiRouter);

    // Health check
    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    // Error reporting endpoint (community error collection)
    // Adds deterministic error ID and simple in-memory dedupe to avoid spam
    const dashboardErrorCache = new Map();
    const DASHBOARD_ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour

    this.app.post("/api/report-error", this.apiLimiter, async (req, res) => {
      try {
        const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
        if (!webhookUrl) {
          dashLog(
            "Error reporting: DISCORD_ERROR_WEBHOOK_URL not configured",
            "warn",
          );
          return res
            .status(503)
            .json({ error: "Error reporting service unavailable" });
        }

        const payload = req.body;
        if (!payload?.error) {
          return res.status(400).json({ error: "Invalid payload" });
        }

        // Compute deterministic ID and dedupe similar errors for a short window
        const sanitizedError = String(payload.error || "");
        const sanitizedStack = payload.stack
          ? String(payload.stack)
          : undefined;
        const computedId = computeErrorId({
          error: sanitizedError,
          stack: sanitizedStack,
          context: payload.context,
          additionalContext: payload.additionalContext,
        });

        const now = Date.now();
        const existing = dashboardErrorCache.get(computedId);
        if (existing && existing.expires > now) {
          existing.count = (existing.count || 0) + 1;
          dashboardErrorCache.set(computedId, existing);
          dashLog(`Duplicate error suppressed (id=${computedId})`, "warn");
          return res.json({ success: true, duplicate: true, id: computedId });
        }
        dashboardErrorCache.set(computedId, {
          expires: now + DASHBOARD_ERROR_TTL_MS,
          count: 1,
        });

        // Build Discord embed with ID included
        const embed = {
          title: "🔴 Bot Error Report",
          description: `\`\`\`\n${String(payload.error).slice(0, 1900)}\n\`\`\``,
          color: 0xdc143c,
          fields: [
            {
              name: "Version",
              value: String(payload.context?.version || "unknown"),
              inline: true,
            },
            {
              name: "Platform",
              value: String(payload.context?.platform || "unknown"),
              inline: true,
            },
            {
              name: "Node",
              value: String(payload.context?.nodeVersion || "unknown"),
              inline: true,
            },
          ],
          timestamp: new Date().toISOString(),
          footer: {
            text: `Community Error Reporting — Error ID: ${computedId}`,
          },
        };

        if (payload.stack) {
          const stackLines = String(payload.stack)
            .split("\n")
            .slice(0, 15)
            .join("\n");
          embed.fields.push({
            name: "Stack Trace",
            value: `\`\`\`\n${stackLines.slice(0, 1000)}\n\`\`\``,
            inline: false,
          });
        }

        // Send to Discord (use native axios, not AxiosClient)
        const axios = (await import("axios")).default;
        await axios.post(
          webhookUrl,
          {
            username: DISCORD.WEBHOOK_USERNAME,
            avatar_url: DISCORD.AVATAR_URL,
            embeds: [embed],
          },
          { timeout: DISCORD.WEBHOOK_TIMEOUT },
        );

        dashLog(`Error report sent to Discord (id=${computedId})`, "log");
        return res.json({
          success: true,
          message: "Error report received",
          id: computedId,
        });
      } catch (error) {
        dashLog(`Error reporting failed: ${getErrorMessage(error)}`, "error");
        return res.status(500).json({ error: "Failed to send error report" });
      }
    });

    // Serve dashboard UI
    this.app.get("/", this.dashboardLimiter, (_req, res) => {
      const indexPath = path.join(__dirname, "../../public/index.html");

      // Force no cache on HTML files
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send(`
          <!DOCTYPE html>
          <html><head><title>Dashboard - API Only Mode</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Dashboard API Active</h1>
            <p>Frontend UI not found. API endpoints are available:</p>
            <ul style="list-style: none; padding: 0;">
              <li><a href="/api/status">GET /api/status</a></li>
              <li><a href="/api/accounts">GET /api/accounts</a></li>
              <li><a href="/api/logs">GET /api/logs</a></li>
              <li><a href="/api/metrics">GET /api/metrics</a></li>
              <li><a href="/health">GET /health</a></li>
            </ul>
          </body></html>
        `);
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      const tracked = ws as WebSocket & { isAlive?: boolean };
      tracked.isAlive = true;

      this.clients.add(tracked);
      dashLog("WebSocket client connected");

      tracked.on("pong", () => {
        tracked.isAlive = true;
      });

      tracked.on("close", () => {
        this.clients.delete(tracked);
        dashLog("WebSocket client disconnected");
      });

      tracked.on("error", (error) => {
        dashLog(`WebSocket error: ${getErrorMessage(error)}`, "error");
      });

      // Send initial data on connect
      const recentLogs = dashboardState.getLogs(100);
      const status = dashboardState.getStatus();
      const accounts = dashboardState.getAccounts();

      tracked.send(
        JSON.stringify({
          type: "init",
          data: {
            logs: recentLogs,
            status,
            accounts,
          },
        }),
      );
    });

    // Heartbeat to drop dead connections and keep memory clean
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        const tracked = client as WebSocket & { isAlive?: boolean };
        if (tracked.isAlive === false) {
          tracked.terminate();
          this.clients.delete(tracked);
          continue;
        }
        tracked.isAlive = false;
        try {
          tracked.ping();
        } catch (error) {
          dashLog(`WebSocket ping error: ${getErrorMessage(error)}`, "error");
          tracked.terminate();
          this.clients.delete(tracked);
        }
      }
    }, 30000);
  }

  /**
   * FIXED: Listen to log events instead of intercepting Logger.log function
   * This prevents WebSocket disconnection issues and function interception conflicts
   */
  private setupLogEventListener(): void {
    logEventEmitter.on("log", (logEntry: DashboardLog) => {
      // Add to dashboard state and broadcast
      dashboardState.addLog(logEntry);
      this.broadcastUpdate("log", { log: logEntry });
    });

    dashLog("Log event listener active");
  }

  public broadcastUpdate(type: string, data: unknown): void {
    const payload = JSON.stringify({ type, data });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (error) {
          dashLog(
            `Error broadcasting update: ${getErrorMessage(error)}`,
            "error",
          );
        }
      }
    }
  }

  public start(): void {
    this.server.listen(PORT, HOST, () => {
      dashLog(`Server running on http://${HOST}:${PORT}`);
      dashLog("WebSocket ready for live logs");
    });
  }

  public stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.wss.close();
    this.server.close();
    dashLog("Server stopped");
  }
}

export function startDashboardServer(): DashboardServer {
  const server = new DashboardServer();
  server.start();
  return server;
}
