# Auto-Updates

Navigation: [Documentation index](./README.md) -> [Node.js version](./node-version.md) -> [Docker](./docker.md) -> [Troubleshooting](./troubleshooting.md)

`npm start` checks the official GitHub `main` branch before building and launching the bot.

`npm run dev` and any launch using `-dev` skip auto-update so local development is not overwritten.

Docker never self-updates. It only logs when a newer version exists. Update Docker installs by pulling or rebuilding the image.

## How It Works

The updater uses GitHub directly:

1. read the latest commit SHA from `QuestPilot/Microsoft-Rewards-Bot#main`;
2. read `package.json` at that SHA;
3. compare the remote version with the local `package.json`;
4. download the immutable GitHub tarball for that SHA;
5. mirror managed project files from the archive;
6. preserve user files;
7. run `npm ci` or `npm install`.

The updater no longer depends on `updates/stable.json`, archive checksums, or manifest signatures.

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
- `MSRB_UPDATE_REPO=QuestPilot/Microsoft-Rewards-Bot`: override the GitHub repo.
- `MSRB_UPDATE_BRANCH=main`: override the update branch.

## Manual Install From Git

Use the supported public branch:

```bash
git clone --branch main https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot
npm install
npm start
```

The `main` branch is the same source used by auto-update. Cloning another branch can install development files that do not match the public updater or compiled Core bytecode.
