# Microsoft Rewards Bot Docs

Welcome to the **Legacy version** documentation for the old Microsoft Rewards dashboard.

> 🚀 **Looking for V4?** Check out [V4 on the main branch](https://git.justw.tf/LightZirconite/Microsoft-Rewards-Bot/src/branch/main/) for the new dashboard interface.

These guides cover everything from first-time setup to advanced configuration.

## Getting Started

- **[Setup](setup.md)** — Install prerequisites and configure your accounts.
- **[Running](running.md)** — Commands to start the bot.
- **[Modes](modes.md)** — Understand the different running modes.

## Configuration

- **[Configuration](configuration.md)** — Adjust bot behavior via `config.jsonc`.
- **[Config Merging](config-merging.md)** — How automatic config updates preserve your settings.
- **[Scheduling](scheduling.md)** — Automate daily runs with built-in scheduler.
- **[Notifications](notifications.md)** — Discord webhooks and NTFY push alerts.

## Features

- **[Dashboard](dashboard.md)** — Real-time web monitoring panel.
- **[Account Creation](account-creation.md)** — Create new Microsoft accounts (use with caution).
- **[Error Reporting](error-reporting.md)** — Automatic anonymized bug reports.

## Deployment

- **[Docker](docker.md)** — Run the bot in a container with scheduling.
- **[Update](update.md)** — Keep the project up to date.

## Help

- **[Troubleshooting](troubleshooting.md)** — Quick fixes for common issues.

---

## Quick Reference

| Command                  | Description                |
| ------------------------ | -------------------------- |
| `npm start`              | Build and run the bot      |
| `npm run dashboard`      | Start web monitoring panel |
| `npm run creator`        | Account creation wizard    |
| `npm run dev`            | Development mode           |
| `npm run docker:compose` | Run in Docker              |
