# Example plugin — earnings-estimator

A complete, sandbox-safe plugin that shows the whole Phase 2 capability surface:
**settings**, **storage**, and a Desk **panel** — with no Node.js access and no Desk
patching.

## What it does

You enter how many points equal one euro and a number of days. After each account
run it adds that account's collected points to a running total, then shows what
you've earned so far and projects it over your chosen number of days.

## Files

- `plugin.json` — the manifest the Desk reads (declared `permissions` + the `settings`
  form fields). This is static; your code never runs just to show the settings form.
- `index.js` — the plugin: reads `ctx.settings`, keeps a total in `ctx.storage`, and
  pushes a `ctx.ui.panel(...)` snapshot the Desk renders in the Plugins page.

## Try it locally

1. Copy this folder into the bot's `plugins/` directory:
   `plugins/earnings-estimator/`
2. Add it to `plugins/plugins.jsonc`:
   ```jsonc
   { "earnings-estimator": { "enabled": true } }
   ```
3. Start the bot, open **Rewards Desk → Plugins**, click **Settings** on the card,
   set your values, and run the bot once. The panel fills in after the first run.

## Publish it

Zip this folder (with `index.js` at the root) and upload it on the **Developers**
page of the dashboard. It runs sandboxed for everyone — no elevated permissions,
nothing to approve manually.

See [Create a plugin](../../create-plugin.md) and the
[Plugin API reference](../../plugin-api.md) for the full contract.
