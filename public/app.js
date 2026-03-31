/**
 * Microsoft Rewards Bot Dashboard - Frontend JavaScript
 */

// State
const state = {
  isRunning: false,
  autoScroll: true,
  logs: [],
  accounts: [],
  stats: {
    totalAccounts: 0,
    totalPoints: 0,
    completed: 0,
    errors: 0,
    startTime: null,
  },
  currentLogFilter: "all",
  ws: null,
  reconnectAttempts: 0,
};

let pointsChart = null;
let activityChart = null;

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  initWebSocket();
  initCharts();
  loadInitialData();
  startUptimeTimer();
  loadTheme();
});

// WebSocket
function initWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = protocol + "//" + window.location.host;

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = function () {
      updateConnectionStatus(true);
      state.reconnectAttempts = 0;
      console.log("[WS] Connected");
    };

    state.ws.onmessage = function (event) {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    state.ws.onclose = function () {
      updateConnectionStatus(false);
      attemptReconnect();
    };

    state.ws.onerror = function (e) {
      console.error("[WS] Error:", e);
    };
  } catch (e) {
    console.error("[WS] Failed:", e);
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (state.reconnectAttempts >= 10) {
    showToast("Connection lost. Please refresh.", "error");
    return;
  }
  state.reconnectAttempts++;
  setTimeout(
    initWebSocket,
    Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 30000),
  );
}

function handleWsMessage(data) {
  if (data.type === "init" && data.data) {
    if (data.data.logs) data.data.logs.forEach(addLogEntry);
    if (data.data.status) updateBotStatus(data.data.status);
    if (data.data.accounts) renderAccounts(data.data.accounts);
    return;
  }

  const payload = data.payload || data.data || data;

  switch (data.type) {
    case "log":
      addLogEntry(payload.log || payload);
      break;
    case "status":
      updateBotStatus(payload);
      break;
    case "stats":
      updateStats(payload);
      break;
    case "account":
    case "account_update":
      updateAccountStatus(payload);
      break;
    case "accounts":
      renderAccounts(payload);
      break;
  }
}

function updateConnectionStatus(connected) {
  const el = document.getElementById("connectionStatus");
  if (el) {
    el.className =
      "connection-status " + (connected ? "connected" : "disconnected");
    el.innerHTML =
      '<i class="fas fa-circle"></i> ' +
      (connected ? "Connected" : "Disconnected");
  }
}

// Charts
function initCharts() {
  // FIXED: Fallback if Chart.js blocked by tracking prevention
  if (typeof Chart === "undefined") {
    console.warn(
      "[Charts] Chart.js not loaded (may be blocked by tracking prevention)",
    );
    const pointsCanvas = document.getElementById("pointsChart");
    const activityCanvas = document.getElementById("activityChart");
    if (pointsCanvas) {
      pointsCanvas.parentElement.innerHTML =
        '<div style="padding: 2rem; text-align: center; color: #8b949e;">Charts unavailable (Chart.js blocked by browser)</div>';
    }
    if (activityCanvas) {
      activityCanvas.parentElement.innerHTML =
        '<div style="padding: 2rem; text-align: center; color: #8b949e;">Charts unavailable (Chart.js blocked by browser)</div>';
    }
    return;
  }
  initPointsChart();
  initActivityChart();
}

function initPointsChart() {
  const ctx = document.getElementById("pointsChart");
  if (!ctx) return;

  const gradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, "rgba(88, 166, 255, 0.3)");
  gradient.addColorStop(1, "rgba(88, 166, 255, 0)");

  pointsChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: generateDateLabels(7),
      datasets: [
        {
          label: "Points",
          data: new Array(7).fill(0), // Real data loaded from API
          borderColor: "#58a6ff",
          backgroundColor: gradient,
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: "#58a6ff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "#21262d" }, ticks: { color: "#8b949e" } },
        y: {
          grid: { color: "#21262d" },
          ticks: { color: "#8b949e" },
          beginAtZero: true,
        },
      },
    },
  });
}

function initActivityChart() {
  const ctx = document.getElementById("activityChart");
  if (!ctx) return;

  activityChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Searches", "Daily Set", "Punch Cards", "Quizzes", "Other"],
      datasets: [
        {
          data: [45, 25, 15, 10, 5],
          backgroundColor: [
            "#58a6ff",
            "#3fb950",
            "#d29922",
            "#a371f7",
            "#39c5cf",
          ],
          borderColor: "#161b22",
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8b949e", font: { size: 11 } },
        },
      },
    },
  });
}

function generateDateLabels(days) {
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    );
  }
  return labels;
}

function setChartPeriod(period, btn) {
  document.querySelectorAll(".period-btn").forEach((b) => {
    b.classList.remove("active");
  });
  btn.classList.add("active");

  const days = period === "7d" ? 7 : 30;
  if (pointsChart) {
    pointsChart.data.labels = generateDateLabels(days);

    // Fetch actual data from account history
    fetch("/api/account-history")
      .then((r) => r.json())
      .then((history) => {
        const pointsData = extractPointsFromHistory(history, days);
        pointsChart.data.datasets[0].data = pointsData;
        pointsChart.update("none");
      })
      .catch(() => {
        // Fallback to zeros if API fails
        pointsChart.data.datasets[0].data = new Array(days).fill(0);
        pointsChart.update("none");
      });
  }
}

function extractPointsFromHistory(history, days) {
  const dataByDate = {};
  const today = new Date();

  // Initialize all days with 0
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dataByDate[key] = 0;
  }

  // Fill with actual data
  for (const email in history) {
    const accountHistory = history[email];
    for (const day in accountHistory) {
      if (dataByDate.hasOwnProperty(day)) {
        const dayData = accountHistory[day];
        dataByDate[day] += dayData.pointsEarnedToday || 0;
      }
    }
  }

  // Convert to array (reverse chronological)
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push(dataByDate[key] || 0);
  }

  return result;
}

// Data Loading
function loadInitialData() {
  fetch("/api/status")
    .then((r) => {
      return r.json();
    })
    .then(updateBotStatus)
    .catch(() => {});
  fetch("/api/accounts")
    .then((r) => {
      return r.json();
    })
    .then(renderAccounts)
    .catch(() => {});
  loadAccountHistoryData(); // FIXED: Load real historical data for charts
}

// FIXED: Load account history from API to populate charts with real data
function loadAccountHistoryData() {
  fetch("/api/account-history")
    .then((r) => r.json())
    .then((histories) => {
      if (histories && Object.keys(histories).length > 0) {
        updateChartsWithRealData(histories);
      }
    })
    .catch((e) => {
      console.warn("[History] Failed to load:", e);
    });
}

// FIXED: Update charts with real historical data
function updateChartsWithRealData(histories) {
  const last7Days = {};
  const activityCounts = {
    "Desktop Search": 0,
    "Mobile Search": 0,
    "Daily Set": 0,
    Quizzes: 0,
    Other: 0,
  };

  // Process each account's history
  Object.values(histories).forEach((accountHistory) => {
    if (!accountHistory.history) return;

    accountHistory.history.forEach((entry) => {
      const date = entry.date || entry.timestamp.split("T")[0];

      // Aggregate points by day
      if (!last7Days[date]) {
        last7Days[date] = 0;
      }
      last7Days[date] += entry.totalPoints || 0;

      // Count activity types
      if (entry.completedActivities) {
        entry.completedActivities.forEach((activity) => {
          if (activity.includes("Search")) {
            if (entry.desktopPoints > 0) activityCounts["Desktop Search"]++;
            if (entry.mobilePoints > 0) activityCounts["Mobile Search"]++;
          } else if (activity.includes("DailySet")) {
            activityCounts["Daily Set"]++;
          } else if (activity.includes("Quiz") || activity.includes("Poll")) {
            activityCounts["Quizzes"]++;
          } else {
            activityCounts["Other"]++;
          }
        });
      }
    });
  });

  // Update points chart with last 7 days
  if (pointsChart) {
    const sortedDates = Object.keys(last7Days).sort().slice(-7);
    const labels = sortedDates.map((d) => {
      const date = new Date(d);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    });
    const data = sortedDates.map((d) => {
      return last7Days[d];
    });

    pointsChart.data.labels =
      labels.length > 0 ? labels : generateDateLabels(7);
    pointsChart.data.datasets[0].data =
      data.length > 0 ? data : new Array(7).fill(0);
    pointsChart.update();
  }

  // Update activity chart
  if (activityChart) {
    const total = Object.values(activityCounts).reduce((sum, val) => {
      return sum + val;
    }, 0);
    if (total > 0) {
      activityChart.data.labels = Object.keys(activityCounts);
      activityChart.data.datasets[0].data = Object.values(activityCounts);
      activityChart.update();
    }
  }
}

function refreshData() {
  const btn = document.querySelector('[onclick="refreshData()"] i');
  if (btn) btn.classList.add("fa-spin");
  loadInitialData();
  setTimeout(() => {
    if (btn) btn.classList.remove("fa-spin");
    showToast("Data refreshed", "success");
  }, 500);
}

// Bot Control
function startBot() {
  updateButtonStates(true);
  fetch("/api/start", { method: "POST" })
    .then((r) => {
      return r.json();
    })
    .then((result) => {
      if (result.success || result.pid) {
        state.isRunning = true;
        state.stats.startTime = Date.now();
        updateBotStatus({ running: true });
        showToast("Bot started", "success");
      } else {
        updateButtonStates(false);
        showToast(result.error || "Failed to start", "error");
      }
    })
    .catch((e) => {
      updateButtonStates(false);
      showToast("Failed: " + e.message, "error");
    });
}

function stopBot() {
  fetch("/api/stop", { method: "POST" })
    .then((r) => {
      return r.json();
    })
    .then((result) => {
      if (result.success) {
        state.isRunning = false;
        updateBotStatus({ running: false });
        showToast("Bot stopped", "info");
      } else {
        showToast(result.error || "Failed to stop", "error");
      }
    })
    .catch((e) => {
      showToast("Failed: " + e.message, "error");
    });
}

function restartBot() {
  showToast("Restarting...", "info");
  fetch("/api/restart", { method: "POST" })
    .then((r) => {
      return r.json();
    })
    .then((result) => {
      if (result.success) {
        state.stats.startTime = Date.now();
        showToast("Bot restarted", "success");
      } else {
        showToast(result.error || "Failed to restart", "error");
      }
    })
    .catch((e) => {
      showToast("Failed: " + e.message, "error");
    });
}

function resetJobState() {
  showModal(
    "Reset Job State",
    "<p>This will clear all completed task records for today.</p>" +
      '<p style="color: var(--accent-orange); margin-top: 1rem;">' +
      '<i class="fas fa-exclamation-triangle"></i> This cannot be undone.</p>',
    [
      { text: "Cancel", cls: "btn btn-secondary", action: "closeModal()" },
      {
        text: "Reset",
        cls: "btn btn-danger",
        action: "confirmResetJobState()",
      },
    ],
  );
}

function confirmResetJobState() {
  closeModal();
  fetch("/api/reset-state", { method: "POST" })
    .then((r) => {
      return r.json();
    })
    .then((result) => {
      if (result.success) {
        showToast("Job state reset", "success");
        state.stats.completed = 0;
        state.stats.errors = 0;
        updateStatsDisplay();
      } else {
        showToast(result.error || "Failed to reset", "error");
      }
    })
    .catch((e) => {
      showToast("Failed: " + e.message, "error");
    });
}

function updateButtonStates(running) {
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  if (btnStart) btnStart.disabled = running;
  if (btnStop) btnStop.disabled = !running;
}

// Status Updates
function updateBotStatus(status) {
  state.isRunning = status.running;
  updateButtonStates(status.running);

  const badge = document.getElementById("statusBadge");
  if (badge) {
    badge.className =
      "status-badge " + (status.running ? "status-running" : "status-stopped");
    badge.innerHTML =
      '<i class="fas fa-circle"></i><span>' +
      (status.running ? "RUNNING" : "STOPPED") +
      "</span>";
  }

  if (status.startTime) {
    state.stats.startTime = new Date(status.startTime).getTime();
  }
}

function updateStats(stats) {
  if (stats.totalAccounts !== undefined)
    state.stats.totalAccounts = stats.totalAccounts;
  if (stats.totalPoints !== undefined)
    state.stats.totalPoints = stats.totalPoints;
  if (stats.completed !== undefined) state.stats.completed = stats.completed;
  if (stats.errors !== undefined) state.stats.errors = stats.errors;
  updateStatsDisplay();
}

function updateStatsDisplay() {
  let el;
  el = document.getElementById("totalAccounts");
  if (el) el.textContent = state.stats.totalAccounts;
  el = document.getElementById("totalPoints");
  if (el) el.textContent = state.stats.totalPoints.toLocaleString();
  el = document.getElementById("completed");
  if (el) el.textContent = state.stats.completed;
  el = document.getElementById("errors");
  if (el) el.textContent = state.stats.errors;
  el = document.getElementById("accountsBadge");
  if (el) el.textContent = state.stats.totalAccounts;
}

// Accounts
function renderAccounts(accounts) {
  state.accounts = accounts;
  state.stats.totalAccounts = accounts.length;

  const container = document.getElementById("accountsList");
  if (!container) return;

  if (accounts.length === 0) {
    container.innerHTML = '<div class="log-empty">No accounts configured</div>';
    return;
  }

  let html = "";
  accounts.forEach((account) => {
    const initial = (account.email || "U")[0].toUpperCase();
    const displayEmail = account.email ? maskEmail(account.email) : "Unknown";
    const statusClass = account.status || "pending";
    const statusText =
      statusClass.charAt(0).toUpperCase() + statusClass.slice(1);

    html +=
      '<div class="account-item" data-email="' +
      (account.email || "") +
      '">' +
      '<div class="account-info">' +
      '<div class="account-avatar">' +
      initial +
      "</div>" +
      '<span class="account-email">' +
      displayEmail +
      "</span>" +
      "</div>" +
      '<span class="account-status ' +
      statusClass +
      '">' +
      statusText +
      "</span>" +
      "</div>";
  });
  container.innerHTML = html;
  updateStatsDisplay();
}

function updateAccountStatus(data) {
  const accountEl = document.querySelector(
    '.account-item[data-email="' + data.email + '"]',
  );
  if (accountEl) {
    const statusEl = accountEl.querySelector(".account-status");
    if (statusEl) {
      statusEl.className = "account-status " + data.status;
      statusEl.textContent =
        data.status.charAt(0).toUpperCase() + data.status.slice(1);
    }
  }
}

function maskEmail(email) {
  if (!email) return "Unknown";
  const parts = email.split("@");
  if (parts.length < 2) return email;
  const local = parts[0];
  const domain = parts[1];
  const masked =
    local.length > 3
      ? local.slice(0, 2) + "***" + local.slice(-1)
      : local[0] + "***";
  return masked + "@" + domain;
}

// Logging
function addLogEntry(log) {
  const container = document.getElementById("logsContainer");
  if (!container) return;

  const emptyMsg = container.querySelector(".log-empty");
  if (emptyMsg) emptyMsg.remove();

  const normalizedLog = {
    timestamp: log.timestamp || new Date().toISOString(),
    level: log.level || "log",
    source: log.source || log.title || "BOT",
    message: log.message || "",
  };

  state.logs.push(normalizedLog);

  if (
    state.currentLogFilter !== "all" &&
    normalizedLog.level !== state.currentLogFilter
  ) {
    return;
  }

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML =
    '<span class="log-time">' +
    formatTime(normalizedLog.timestamp) +
    "</span>" +
    '<span class="log-level ' +
    normalizedLog.level +
    '">' +
    normalizedLog.level +
    "</span>" +
    '<span class="log-source">[' +
    normalizedLog.source +
    "]</span>" +
    '<span class="log-message">' +
    escapeHtml(normalizedLog.message) +
    "</span>";

  container.appendChild(entry);

  while (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }

  if (state.autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function filterLogs() {
  const filter = document.getElementById("logFilter");
  if (!filter) return;

  state.currentLogFilter = filter.value;

  const container = document.getElementById("logsContainer");
  if (!container) return;

  container.innerHTML = "";

  const filtered =
    state.currentLogFilter === "all"
      ? state.logs
      : state.logs.filter((log) => {
          return log.level === state.currentLogFilter;
        });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="log-empty">No logs to display</div>';
    return;
  }

  filtered.forEach((log) => {
    const entry = document.createElement("div");
    entry.className = "log-entry";
    entry.innerHTML =
      '<span class="log-time">' +
      formatTime(log.timestamp) +
      "</span>" +
      '<span class="log-level ' +
      log.level +
      '">' +
      log.level +
      "</span>" +
      '<span class="log-source">[' +
      log.source +
      "]</span>" +
      '<span class="log-message">' +
      escapeHtml(log.message) +
      "</span>";
    container.appendChild(entry);
  });
}

function clearLogs() {
  state.logs = [];
  const container = document.getElementById("logsContainer");
  if (container) {
    container.innerHTML = '<div class="log-empty">No logs to display</div>';
  }
  showToast("Logs cleared", "info");
}

function toggleAutoScroll() {
  state.autoScroll = !state.autoScroll;
  const btn = document.getElementById("btnAutoScroll");
  if (btn) {
    btn.classList.toggle("btn-primary", state.autoScroll);
    btn.classList.toggle("btn-secondary", !state.autoScroll);
  }
  showToast(
    "Auto-scroll " + (state.autoScroll ? "enabled" : "disabled"),
    "info",
  );
}

// Quick Actions
function runSingleAccount() {
  if (state.accounts.length === 0) {
    showToast("No accounts available", "warning");
    return;
  }

  const options = state.accounts
    .map((a) => {
      return (
        '<option value="' + a.email + '">' + maskEmail(a.email) + "</option>"
      );
    })
    .join("");

  showModal(
    "Run Single Account",
    '<p style="margin-bottom: 1rem;">Select an account to run:</p>' +
      '<select id="singleAccountSelect" class="log-filter" style="width: 100%; padding: 0.5rem;">' +
      options +
      "</select>",
    [
      { text: "Cancel", cls: "btn btn-secondary", action: "closeModal()" },
      { text: "Run", cls: "btn btn-primary", action: "executeSingleAccount()" },
    ],
  );
}

function executeSingleAccount() {
  const select = document.getElementById("singleAccountSelect");
  if (!select) return;

  const email = select.value;
  closeModal();

  if (!email) {
    showToast("No account selected", "error");
    return;
  }

  showToast("Starting bot for: " + maskEmail(email), "info");

  // Call API to run single account
  fetch("/api/run-single", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showToast("✓ Bot started for account: " + maskEmail(email), "success");
        refreshData(); // FIXED: Use refreshData() instead of undefined loadStatus()
      } else {
        showToast(
          "✗ Failed to start: " + (data.error || "Unknown error"),
          "error",
        );
      }
    })
    .catch((err) => {
      console.error("[API] Run single failed:", err);
      showToast("✗ Request failed: " + err.message, "error");
    });
}

function exportLogs() {
  if (state.logs.length === 0) {
    showToast("No logs to export", "warning");
    return;
  }

  const logText = state.logs
    .map((log) => {
      return (
        "[" +
        formatTime(log.timestamp) +
        "] [" +
        (log.level || "LOG").toUpperCase() +
        "] [" +
        (log.source || "BOT") +
        "] " +
        log.message
      );
    })
    .join("\n");

  const blob = new Blob([logText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    "rewards-bot-logs-" + new Date().toISOString().slice(0, 10) + ".txt";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Logs exported", "success");
}

function openConfig() {
  showModal(
    "Configuration Viewer",
    `
        <div class="config-loading">Loading configuration...</div>
    `,
    [],
  );

  // Fetch config (read-only view)
  fetch("/api/config")
    .then((r) => r.json())
    .then((data) => {
      const body = `
                <div class="config-editor">
                    <div class="config-warning">
                        ⚠️ <strong>Read-Only View</strong><br>
                        This is a simplified preview. To edit config:<br>
                        1. Open <code>src/config.jsonc</code> in a text editor<br>
                        2. Make your changes<br>
                        3. Save and restart the bot
                    </div>
                    <textarea id="configEditor" class="config-textarea" readonly>${JSON.stringify(data.config, null, 2)}</textarea>
                    <p class="config-hint">💡 Manual editing preserves comments and complex settings</p>
                </div>
            `;
      const buttons = [
        {
          cls: "btn btn-sm btn-secondary",
          action: "closeModal()",
          text: "Close",
        },
      ];
      showModal("Configuration Viewer", body, buttons);
    })
    .catch((e) => {
      showToast("Failed to load config: " + e.message, "error");
      closeModal();
    });
}

function saveConfig() {
  // Config editing is disabled - this function is now unused
  showToast(
    "Config editing disabled. Edit src/config.jsonc manually.",
    "warning",
  );
  closeModal();
}

function viewHistory() {
  showModal(
    "Run History",
    '<div class="config-loading">Loading history...</div>',
    [],
  );

  fetch("/api/history")
    .then((r) => r.json())
    .then((history) => {
      if (!history || history.length === 0) {
        showModal(
          "Run History",
          '<p class="log-empty">No history available yet</p>',
          [
            {
              cls: "btn btn-sm btn-secondary",
              action: "closeModal()",
              text: "Close",
            },
          ],
        );
        return;
      }

      const rows = history
        .slice(0, 10)
        .map(
          (h) => `
                <div class="history-row">
                    <div class="history-date">${new Date(h.timestamp || Date.now()).toLocaleString()}</div>
                    <div class="history-stats">
                        <span>✅ ${h.successCount || 0} success</span>
                        <span>❌ ${h.errorCount || 0} errors</span>
                        <span>🎯 ${h.totalPoints || 0} pts</span>
                    </div>
                </div>
            `,
        )
        .join("");

      const body = `<div class="history-list">${rows}</div>`;
      const buttons = [
        {
          cls: "btn btn-sm btn-secondary",
          action: "closeModal()",
          text: "Close",
        },
      ];
      showModal("Run History (Last 10 Runs)", body, buttons);
    })
    .catch((e) => {
      showToast("Failed to load history: " + e.message, "error");
      closeModal();
    });
}

// UI Utilities
function showToast(message, type) {
  type = type || "info";
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast " + type;

  const icons = {
    success: "fa-check-circle",
    error: "fa-times-circle",
    warning: "fa-exclamation-circle",
    info: "fa-info-circle",
  };

  toast.innerHTML =
    '<i class="fas ' +
    (icons[type] || icons.info) +
    '"></i><span>' +
    message +
    "</span>";
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "slideIn 0.3s ease reverse";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

function showModal(title, body, buttons) {
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  const modalFooter = document.getElementById("modalFooter");

  if (!modal || !modalTitle || !modalBody || !modalFooter) return;

  modalTitle.textContent = title;
  modalBody.innerHTML = body;

  let footerHtml = "";
  (buttons || []).forEach((btn) => {
    footerHtml +=
      '<button class="' +
      btn.cls +
      '" onclick="' +
      btn.action +
      '">' +
      btn.text +
      "</button>";
  });
  modalFooter.innerHTML = footerHtml;

  modal.classList.add("show");
}

function closeModal() {
  const modal = document.getElementById("modal");
  if (modal) modal.classList.remove("show");
}

// Theme
function toggleTheme() {
  document.body.classList.toggle("light-theme");
  const isLight = document.body.classList.contains("light-theme");
  try {
    localStorage.setItem("theme", isLight ? "light" : "dark");
  } catch (e) {}

  const btn = document.querySelector(".theme-toggle i");
  if (btn) btn.className = isLight ? "fas fa-sun" : "fas fa-moon";

  updateChartsTheme(isLight);
}

function loadTheme() {
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light") {
      document.body.classList.add("light-theme");
      const btn = document.querySelector(".theme-toggle i");
      if (btn) btn.className = "fas fa-sun";
      updateChartsTheme(true);
    }
  } catch (e) {}
}

function updateChartsTheme(isLight) {
  const gridColor = isLight ? "#eaeef2" : "#21262d";
  const textColor = isLight ? "#656d76" : "#8b949e";

  if (pointsChart) {
    pointsChart.options.scales.x.grid.color = gridColor;
    pointsChart.options.scales.y.grid.color = gridColor;
    pointsChart.options.scales.x.ticks.color = textColor;
    pointsChart.options.scales.y.ticks.color = textColor;
    pointsChart.update("none");
  }

  if (activityChart) {
    activityChart.options.plugins.legend.labels.color = textColor;
    activityChart.update("none");
  }
}

// Uptime Timer
function startUptimeTimer() {
  setInterval(() => {
    if (state.isRunning && state.stats.startTime) {
      const elapsed = Date.now() - state.stats.startTime;
      const el = document.getElementById("uptime");
      if (el) el.textContent = formatDuration(elapsed);
    }
  }, 1000);
}

// Formatting
function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return pad(hrs) + ":" + pad(mins) + ":" + pad(s);
}

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Event listeners
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal")) closeModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
