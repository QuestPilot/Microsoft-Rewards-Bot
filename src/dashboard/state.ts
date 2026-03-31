import { MicrosoftRewardsBot } from "../index";
import {
    loadAllPointsFromSessions,
    loadPointsFromJobState,
} from "./SessionLoader";

interface DashboardStatus {
  running: boolean;
  lastRun?: string;
  currentAccount?: string;
  totalAccounts: number;
  startTime?: string;
}

export interface DashboardLog {
  timestamp: string;
  level: "log" | "warn" | "error";
  platform: string;
  title: string;
  message: string;
}

interface AccountStatus {
  email: string;
  maskedEmail: string;
  points?: number;
  lastSync?: string;
  status: "idle" | "running" | "completed" | "error";
  errors?: string[];
  progress?: string;
}

type ChangeListener = (type: string, data: unknown) => void;

class DashboardState {
  private botInstance?: MicrosoftRewardsBot;
  private status: DashboardStatus = { running: false, totalAccounts: 0 };
  private logs: DashboardLog[] = [];
  private accounts: Map<string, AccountStatus> = new Map();
  private maxLogsInMemory = 500;
  private changeListeners: Set<ChangeListener> = new Set();

  public addChangeListener(listener: ChangeListener): void {
    this.changeListeners.add(listener);
  }

  public removeChangeListener(listener: ChangeListener): void {
    this.changeListeners.delete(listener);
  }

  private notifyChange(type: string, data: unknown): void {
    for (const listener of this.changeListeners) {
      try {
        listener(type, data);
      } catch (error) {
        // Silently ignore listener errors to prevent state corruption
        // Listeners are non-critical (UI updates, logging)
      }
    }
  }

  getStatus(): DashboardStatus {
    return { ...this.status };
  }

  setRunning(running: boolean, currentAccount?: string): void {
    this.status.running = running;
    this.status.currentAccount = currentAccount;

    if (running && !this.status.startTime) {
      this.status.startTime = new Date().toISOString();
    }

    if (!running) {
      this.status.lastRun = new Date().toISOString();
      this.status.startTime = undefined;
      if (currentAccount === undefined) {
        this.status.currentAccount = undefined;
      }
    }

    this.notifyChange("status", this.getStatus());
  }

  setBotInstance(bot: MicrosoftRewardsBot | undefined): void {
    this.botInstance = bot;
  }

  getBotInstance(): MicrosoftRewardsBot | undefined {
    return this.botInstance;
  }

  addLog(log: DashboardLog): void {
    this.logs.push(log);
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs.shift();
    }
    this.notifyChange("log", log);
  }

  getLogs(limit = 100): DashboardLog[] {
    return this.logs.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
    this.notifyChange("logs_cleared", true);
  }

  updateAccount(email: string, update: Partial<AccountStatus>): void {
    const existing = this.accounts.get(email) || {
      email,
      maskedEmail: this.maskEmail(email),
      status: "idle",
    };
    const updated = { ...existing, ...update };
    this.accounts.set(email, updated);
    this.status.totalAccounts = this.accounts.size;
    this.notifyChange("account_update", updated);
  }

  getAccounts(): AccountStatus[] {
    return Array.from(this.accounts.values());
  }

  getAccount(email: string): AccountStatus | undefined {
    return this.accounts.get(email);
  }

  private maskEmail(email: string): string {
    const parts = email.split("@");
    if (parts.length !== 2) return "***@***";

    const [local, domain] = parts;
    if (!local || !domain) return "***@***";

    // SECURITY: More aggressive masking to prevent account enumeration
    const maskedLocal =
      local.length <= 2
        ? "**"
        : local.slice(0, 2) + "*".repeat(Math.min(local.length - 2, 5));

    const domainParts = domain.split(".");
    const tld = domainParts.pop() || "com";
    const maskedDomain =
      domain.length <= 4 ? `***.${tld}` : `${domain.slice(0, 2)}***.${tld}`;

    return `${maskedLocal}@${maskedDomain}`;
  }

  // Initialize accounts from config
  public initializeAccounts(emails: string[]): void {
    // Load points from sessions if available
    const pointsMap = loadAllPointsFromSessions();

    for (const email of emails) {
      if (!this.accounts.has(email)) {
        // Try to get points from session or job state
        let points = pointsMap.get(email);
        if (points === undefined) {
          points = loadPointsFromJobState(email);
        }

        this.accounts.set(email, {
          email,
          maskedEmail: this.maskEmail(email),
          status: "idle",
          points: points,
          lastSync: points !== undefined ? new Date().toISOString() : undefined,
        });
      }
    }
    this.status.totalAccounts = this.accounts.size;
    this.notifyChange("accounts", this.getAccounts());
  }
}

export const dashboardState = new DashboardState();
