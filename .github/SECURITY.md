# Security Policy

Microsoft Rewards Bot handles your Microsoft account credentials, so security is a first-class concern. This page explains how we protect your data and how to report a problem.

## How your data is protected

- **Credentials are encrypted at rest** with a key sealed in your operating system's secure vault — Windows DPAPI, macOS Keychain, or Linux Secret Service. They are never stored in plaintext.
- **Your secrets never leave your machine.** Passwords, cookies, session tokens, proxy credentials, and webhook URLs are used locally only. They are not sent to us or to any third party.
- **Anonymous telemetry is redacted** before it ever leaves your machine (emails masked, no secrets) and can be turned off in one line. See **[Privacy & Telemetry](../docs/privacy.md)** for exactly what is and isn't collected.
- **The optional Core plugin is integrity-verified** (Ed25519 signature + SHA-256 checksum) before it loads, and marketplace plugins run **sandboxed** in a V8 isolate with no Node APIs.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue for a vulnerability.

1. **Preferred:** open a private [GitHub Security Advisory](https://github.com/QuestPilot/Microsoft-Rewards-Bot/security/advisories/new).
2. **Or:** message the maintainers in the [Discord](https://discord.gg/JWhCkhSYtg) (a private/DM channel for security reports).

Please include: affected version, your OS, steps to reproduce, and the impact. We aim to acknowledge reports within a few days and will keep you updated on the fix.

## Supported versions

Security fixes target the latest release on the `main` branch. Please update to the latest version before reporting (auto-update is built in: `npm run update:check`).

## Scope

In scope: credential handling, the plugin sandbox and Core integrity verification, the local Rewards Desk server, the auto-updater, and any path that could leak secrets off the machine. Out of scope: account bans or point loss from using automation (see the disclaimer in the README — automation of Microsoft Rewards carries inherent account risk).
