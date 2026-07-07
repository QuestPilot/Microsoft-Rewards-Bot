<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Install & Auto-Updates

Navigation: [Documentation index](./README.md) · [Node.js version](./node-version.md) · [Docker](./docker.md) · [Troubleshooting](./troubleshooting.md)

Every `npm start` does three things: check the official `main` branch for a newer version, build, then launch the bot. You never have to update by hand.

- `npm run dev` (or any launch with `-dev`) **skips auto-update**, so local development is never overwritten.
- **Docker never self-updates.** It only logs when a newer version exists — update by pulling or rebuilding the image.

## Install

Requires [Node.js 24.15.0](./node-version.md). Windows users can use the [automated installer](../README.md#quick-start) instead.

```bash
git clone https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
cd Microsoft-Rewards-Bot
npm install
npm start
```

Manual installs and auto-updates both follow `main` — the supported public channel.

## Your files are safe

Updates never touch what's yours:

- `src/config.json` and `src/accounts.json` (or `accounts.enc.json`)
- `plugins/plugins.jsonc` and your custom plugin folders
- `sessions/`, `logs/`, `diagnostics/`, `Page/`, `.updates/`, `.git/`

After an update, new keys from `config.example.json` and `accounts.example.json` are added to your files without replacing your values.

On every `npm start`, the launcher also self-heals missing files: a missing `src/config.json` is created from the example, and `src/accounts.json` is created from the example only if no plain *or* encrypted accounts file exists. Existing user files are never overwritten.

## Commands

```bash
npm start               # update check + build + launch
npm run update:check    # check only, apply nothing
npm run update:repair   # re-apply the current version if files look damaged
npm run update:doctor   # diagnose update problems + verify installed files
```

Repair mode preserves the same user files as a normal update and refuses to downgrade.

## App window or terminal

`npm start` opens the Rewards Desk app window by default — the right mode for everyday use (see [Rewards Desk](./rewards-desk.md)). To force the classic terminal for one launch:

```bash
npm start -- --terminal
```

Docker, CI, and forced-headless launches always keep terminal mode automatically, since they cannot open a desktop window.

## Under the hood

<details>
<summary><strong>How an update is applied</strong> (for the curious)</summary>

<br>

The updater has two apply strategies:

- **Git installs**: resolve `main` to a full commit SHA, fetch `main`, verify the fetched commit still matches that SHA, reset the working tree, restore user files, and verify the local version.
- **ZIP/archive installs**: resolve `main` to a full commit SHA, download the GitHub tarball for that SHA, mirror managed project paths from the archive, preserve user files, and verify the local version.

The default strategy is `auto`: Git when `.git` exists, `git` is installed, and `origin` matches the configured update repository; otherwise archive.

The full flow:

1. resolve the configured `main` branch through the GitHub API;
2. require a full 40-character commit SHA;
3. read `package.json` at that exact SHA;
4. acquire `.updates/update.lock` before mutating files;
5. apply the same commit with Git or its exact commit archive;
6. delete files that the previous release installed but this one no longer ships (tracked in `.updates/applied.json`), plus known obsolete paths;
7. preserve and migrate user files;
8. verify **every synced file** against the release (SHA-256), and only then write the new `package.json` — the version marker on disk is always the last thing written;
9. record the applied-release manifest and clean old update workdirs (the last two are kept);
10. run `npm ci` (falling back to `npm install` if `ci` fails);
11. restart the launcher once with an internal guard, rebuild `dist/`, and start the new version.

One update operation is pinned to the single SHA resolved at its start — if the branch moves mid-update, the update fails rather than mixing commits. Because the version marker is written last, an interrupted or failed apply leaves the old version in place and the next launch simply re-applies the same release; the updater can never claim a version whose files aren't actually on disk and intact. `npm run update:doctor` re-checks the installed files against the applied-release manifest at any time.

After a successful non-Docker update, the launcher exits and restarts itself once: the restart skips a second update check, rebuilds the runtime from the new source, and opens the normal app window or terminal mode.

</details>

<details>
<summary><strong>Advanced environment variables</strong> (most people never need these)</summary>

<br>

- `MSRB_AUTO_UPDATE=0` — disable update checks and updates.
- `MSRB_NO_APP_WINDOW=1` — keep terminal mode even when `terminal.enabled` is `false`.
- `MSRB_FORCE_APP_WINDOW=1` — force the app window on a desktop machine.
- `MSRB_UPDATE_CHECK_ONLY=1` — check and log only; do not apply updates.
- `MSRB_UPDATE_FORCE=1` — re-apply the current remote version when local and remote versions are equal.
- `MSRB_UPDATE_LOCK_WAIT_MS=120000` — maximum time to wait for another updater process before continuing with the local version.
- `MSRB_UPDATE_LOCK_STALE_MS=1800000` — age after which an updater lock can be treated as stale.
- `MSRB_UPDATE_STRATEGY=auto` — choose Git when possible, otherwise archive. `git` requires Git update mode; `archive` forces archive download mode.
- `MSRB_UPDATE_REPO=QuestPilot/Microsoft-Rewards-Bot` — override the GitHub repo.
- `MSRB_UPDATE_BRANCH=main` — branch used as the auto-update source.
- `MSRB_POST_UPDATE_RESTART=1` — internal one-shot restart guard; never set it manually.

</details>

## Related pages

- [Rewards Desk](./rewards-desk.md)
- [Docker](./docker.md)
- [Node.js version](./node-version.md)
- [Troubleshooting](./troubleshooting.md)
