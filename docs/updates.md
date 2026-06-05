# Auto-Updates

Navigation: [Documentation index](./README.md) -> [Node.js version](./node-version.md) -> [Docker](./docker.md) -> [Troubleshooting](./troubleshooting.md)

`npm start` checks the official GitHub `main` branch before building and launching the bot.

`npm run dev` and any launch using `-dev` skip auto-update so local development is not overwritten.

Docker never self-updates. It only logs when a newer version exists. Update Docker installs by pulling or rebuilding the image.

## How It Works

The updater has two apply strategies:

- Git installs: fetch the exact branch commit reported by GitHub, reset the working tree to that commit, clean managed project paths, restore user files, and verify the local version.
- ZIP/archive installs: download the immutable GitHub tarball for the same commit, mirror managed project paths from the archive, preserve user files, and verify the local version.

The default strategy is `auto`: use Git when `.git` exists, `git` is installed, and `origin` matches the configured update repository; otherwise use the archive strategy.

The update flow is:

1. read the latest commit SHA from the configured update branch;
2. read `package.json` at that SHA;
3. compare the remote version with the local `package.json`;
4. apply the exact commit with Git or the exact commit archive;
5. remove obsolete files from managed project paths;
6. preserve and migrate user files;
7. verify that the local `package.json` now matches the remote version;
8. run `npm ci` or `npm install`.

The updater does not report `Updated` unless the version on disk matches the remote version after the apply step.

The updater no longer depends on `updates/stable.json`, archive checksums, or manifest signatures for the public channel.

## Preserved User Files

Updates preserve:

- `src/config.json`
- `src/accounts.json`
- `plugins/plugins.jsonc`
- `sessions/`
- `logs/`
- `diagnostics/`
- `Page/`
- `.updates/`
- `.git/`

After an update, missing keys from `config.example.json` and `accounts.example.json` are added without replacing user values.

## Commands

```bash
npm start
npm run update:check
npm run update:doctor
```

Useful environment variables:

- `MSRB_AUTO_UPDATE=0`: disable update checks and updates.
- `MSRB_UPDATE_CHECK_ONLY=1`: check and log only; do not apply updates.
- `MSRB_UPDATE_STRATEGY=auto`: choose Git when possible, otherwise archive.
- `MSRB_UPDATE_STRATEGY=git`: require Git update mode and fail if this is not a compatible Git working tree.
- `MSRB_UPDATE_STRATEGY=archive`: force archive download mode.
- `MSRB_UPDATE_REPO=QuestPilot/Microsoft-Rewards-Bot`: override the GitHub repo.
- `MSRB_UPDATE_BRANCH=main`: override the update branch.

## Manual Install From Git

Use the supported public branch:

```bash
git clone https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot
npm install
npm start
```

The `main` branch is the same source used by auto-update. Cloning another branch can install development files that do not match the public updater or compiled Core bytecode.
