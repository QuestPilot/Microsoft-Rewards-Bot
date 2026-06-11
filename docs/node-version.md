# Node.js Version

Navigation: [Documentation index](./README.md) -> [Install and auto-updates](./updates.md) -> [Troubleshooting](./troubleshooting.md)

Use **Node.js 24.15.0**.

The accepted version is:

```text
24.15.0
```

The bot checks this before `npm start`, `npm run dev`, and `npm run ts-start`.

## Check Your Version

```powershell
node -v
npm run node:check
```

If the check fails, install Node.js 24.15.0, then reinstall dependencies:

```powershell
npm install
npm start
```

## Why This Is Strict

The official Core plugin is runtime-targeted. Running it on another Node.js version or another runtime target can fail at runtime or behave unpredictably.

Core currently ships for Windows x64, Linux x64, Linux ARM64, and Intel macOS x64 on Node.js `24.15.0`. The Intel macOS target is a verified compatibility alias of the Linux x64 V8 bytecode artifact, not a native macOS build. Apple Silicon requires running the x64 Node.js runtime through Rosetta until a native `darwin-arm64` artifact is produced and tested.

For this reason, the official release refuses every Node.js version except 24.15.0 before loading the bot.

## Common Fix on Windows

If `npm start` reports another version, install Node.js 24.15.0 globally, then open a new PowerShell window:

```powershell
node -v
npm install
npm start
```

If Windows still reports the old version, check that `C:\Program Files\nodejs` is first in your Node path and remove the newer Node.js installation from Windows Apps or Programs and Features.

## Security Note

Compiled local artifacts are not secret storage. Never ship database tokens, API keys, private keys, or license backend secrets inside Core artifacts. Server secrets must stay server-side.

The supported protection model is:

- strict Node.js version for bytecode compatibility;
- signed/checksummed Core artifacts;
- license validation through your backend;
- no server secrets in the shipped plugin;
- public plugins cannot grant official Core entitlement.

For public release integrity rules, see [Core release integrity](./core-release-security.md).
