# Release Update Checklist

This guide covers the files that make `npm start` detect and apply a public update.

## Goal

Publish the `release` branch so existing local installs can detect a higher `package.json` version, download that exact commit archive, preserve user files, and replace managed project files.

## Required Environment

- Node.js `24.15.0`
- access to rebuild the official Core plugin when Core changes
- write access to the official `release` branch

## Preparation Steps

1. Build and test the public bot.

```bash
npm run node:check
npm install
npx tsc --noEmit
npm test
npm run test:dashboard:mock
npm audit --audit-level=moderate
npm run update:doctor
```

2. Rebuild the official Core plugin from `Core-Source` with Node.js `24.15.0` when Core changed.

```bash
cd ../Core-Source
npm install
npx tsc --noEmit
npm audit --audit-level=moderate
npm run build:release
```

For Docker support, build the Core release artifact on Linux `x64` with Node.js `24.15.0`. The generated `official-core.json` records the bytecode target.

3. Copy the Core release into the public repository when Core changed.

- copy `Core-Source/release/*` to `Microsoft-Rewards-Bot/plugins/core/`
- copy `Core-Source/release/official-core.json` to `Microsoft-Rewards-Bot/plugins/official-core.json`
- remove `plugins/core/official-core.json` after copying
- update `plugins/catalog.json` with the SHA-256 of `plugins/core/index.jsc`

4. Verify the Core checksum.

```powershell
(Get-FileHash -Algorithm SHA256 plugins/core/index.jsc).Hash.ToLowerInvariant()
```

The value must match:

- `plugins/core/package.json` -> `msrb.indexSha256`
- `plugins/official-core.json` -> `indexSha256`
- `plugins/catalog.json` -> Core `sha256`

5. Commit and push the final release code to the `release` branch.

The updater reads `package.json` directly from `release`, then downloads the immutable tarball for that branch commit SHA. There is no second manifest commit.

6. Validate after push.

```bash
npm run update:check
npm run update:doctor
```

Expected result:

- local and remote versions are printed;
- the release branch SHA is printed;
- Core checksum values match;
- Docker users only receive an update notification.

## Preserved User Files

The updater must preserve:

- `.git`
- `.updates`
- `node_modules`
- `dist`
- `release`
- `logs`
- `diagnostics`
- `Page`
- `sessions`
- `src/config.json`
- `src/accounts.json`
- `plugins/plugins.jsonc`
- `plugins/*/node_modules`
- `plugins/*/.cache`

Managed project paths are mirrored from the release archive before copy. This removes old source files that no longer exist in the release while preserving the user-owned paths above.

## What Not To Do

- Do not ship database tokens, API keys, private keys, or license backend secrets.
- Do not publish source files from Core in `plugins/core`.
- Do not rebuild Core bytecode with another Node.js version.
- Do not rely on `updates/stable.json` or signed update manifests for the public channel.
- Do not rely on obfuscation as secret storage.
