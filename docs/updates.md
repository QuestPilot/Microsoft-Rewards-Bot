# Auto-Updates

`npm start` checks for updates before building and launching the bot.

`npm run dev` and any launch using `-dev` always skip auto-update, so local development is not overwritten by the public release branch.

Docker containers skip auto-update by default because container filesystems are normally disposable. Build or pull a newer image instead. If you deliberately run a writable container and want the updater anyway, set `MSRB_AUTO_UPDATE_IN_DOCKER=1`.

## Release Manifest

The default channel is `stable`. The updater reads:

```text
https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/release/updates/stable.json
```

The manifest includes:

- `botVersion`
- `coreVersion`
- `compatibleNode`
- `archiveUrl`
- `sha256`
- `signature` (optional legacy field)
- preserved paths

The updater always refuses an archive when the archive checksum is invalid.
Manifest signatures are optional for the public release channel so the updater can keep working even when the old signing key is unavailable.
Set `MSRB_UPDATE_REQUIRE_SIGNATURE=1` only if you are maintaining a signed private channel and you have the matching private key.

The updater never backs up internal updater state, Git metadata, dependencies, or build output. Those paths are preserved by skipping them during the copy step, not by recursively copying them into `.updates/backup`.

## Preserved User Files

Updates preserve local user data:

- `src/config.json`
- `src/accounts.json`
- `plugins/plugins.jsonc`
- `sessions/`
- `logs/`
- `diagnostics/`
- `.updates/`

After an update, missing keys from `config.example.json` and `accounts.example.json` are added without replacing user values.
Known deprecated keys, such as the old open-source `dashboard` config block, are removed during migration.

## Commands

```bash
npm start
npm run update:check
npm run update:doctor
npm run update:prepare
```

Set `MSRB_UPDATE_CHANNEL=beta` to use another channel. Set `MSRB_UPDATE_MANIFEST_URL` for a custom manifest URL. Set `MSRB_AUTO_UPDATE=0` only for CI or emergency local recovery.

`update:doctor` compares the package version, local manifest, remote manifest, and Core checksums. Use it when users do not see a release; if the remote manifest still shows the old version, the update has not been published yet.
