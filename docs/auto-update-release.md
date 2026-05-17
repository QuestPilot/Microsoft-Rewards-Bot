# Auto-Update Manifest Checklist

This guide explains only how to prepare the files used by the auto-updater. It does not cover Git history cleanup or repository publishing.

## Goal

Make `npm start` detect a new release, download the expected archive, verify it, preserve user files, and apply the update.

## Required Environment

- Node.js `24.15.0`
- access to the update signing private key in `MSRB_UPDATE_PRIVATE_KEY` only for private signed channels

## Files Used By The Updater

- `updates/stable.json`: manifest for the stable channel
- `updates/beta.json`: optional signed manifest for the beta channel
- `scripts/updater/UpdateManager.js`: manifest verification, archive verification, staging, apply, rollback
- `scripts/updater/ConfigMigrator.js`: non-destructive `config.json` and `accounts.json` migration
- `plugins/official-core.json`: official Core checksum
- `plugins/catalog.json`: local store catalogue and Core checksum display

## Signature Policy

Public stable updates use GitHub as the source of trust and always verify the downloaded archive with `sha256`.
The `signature` field is now optional because the original signing private key is not available.

Signed manifests are still supported for private channels by setting `MSRB_UPDATE_REQUIRE_SIGNATURE=1`.
In that mode, the manifest must be signed with the private key matching the public Ed25519 key embedded in `scripts/updater/UpdateManager.js`.

If you maintain a signed private channel, run this before signing:

```bash
MSRB_UPDATE_PRIVATE_KEY="<ed25519-private-key-pem>" npm run update:key:check
```

If it fails, stop. Changing the updater public key only helps users after they have manually installed a build containing the new public key.

## Preparation Steps

1. Build and test the open-source bot.

```bash
npm run node:check
npm install
npx tsc --noEmit
npm test
npm run test:dashboard:mock
npm audit --audit-level=moderate
```

2. Rebuild the official Core plugin from `Core-Source` with Node.js `24.15.0`.

```bash
cd ../Core-Source
npm install
npx tsc --noEmit
npm audit --audit-level=moderate
npm run build:release
```

3. Copy the Core release into the open-source repository.

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

5. Commit and push the release code before preparing the manifest.

The archive must be immutable. Do not point `archiveUrl` at `refs/heads/release.tar.gz`, because every later commit changes that archive and breaks the checksum.

Use the two-commit flow:

- commit A: the actual release code and Core files
- commit B: `updates/stable.json` pointing to commit A's archive

For this release, commit A should contain the `4.0.7` version bump, dashboard/Core changes, documentation, and updated Core checksums. Only after that commit exists on the `release` branch should `updates/stable.json` be regenerated.

6. Prepare `updates/stable.json`.

```bash
npm run update:prepare
```

This fills the manifest from the current clean `HEAD`:

- `botVersion` from `package.json`
- `coreVersion` from `plugins/official-core.json`
- `compatibleNode` from `package.json`
- `archiveUrl` as `https://github.com/QuestPilot/Microsoft-Rewards-Bot/archive/<commit>.tar.gz`
- `sha256` from the downloaded immutable archive

Review the generated values before committing. The public stable manifest does not need `signature`.

7. Optional: sign the manifest for a private signed channel.

```bash
MSRB_UPDATE_PRIVATE_KEY="<ed25519-private-key-pem>" npm run update:key:check
MSRB_UPDATE_PRIVATE_KEY="<ed25519-private-key-pem>" npm run update:sign
```

8. Validate the update in dry-run mode.

```bash
npm run update:check
```

Expected result:

- local and remote versions are printed
- preserved paths are listed
- no checksum error appears

9. Commit only the manifest and any documentation updates, then push.

## Preserved User Files

The updater must preserve user-owned files and folders:

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

If new config keys are added, update the example files. The updater migrates missing keys from examples without replacing user values.

## What Not To Do

- Do not ship database tokens, API keys, private keys, or license backend secrets.
- Do not point `archiveUrl` at a moving branch archive.
- Do not rebuild Core bytecode with another Node.js version.
- Do not publish source files from Core in `plugins/core`.
- Do not rely on obfuscation as secret storage.
