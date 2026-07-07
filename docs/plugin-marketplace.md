<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Plugin Marketplace

Navigation: [Documentation index](./README.md) → [Plugin system overview](./plugins.md) → [Create a plugin](./create-plugin.md) → [Plugin API reference](./plugin-api.md)

The marketplace lets community developers publish plugins that anyone can install. Every published plugin is **cryptographically signed**, **content‑pinned**, and **sandboxed by default** — so installing one is safe even though it was written by someone else.

```
Author → publishes on the website (Discord login, no Core license)
      → an automated safety scan runs
      → it is stored + the signed catalog is updated (published instantly)
Bot   → fetches the signed catalog → verifies → installs → runs the plugin SANDBOXED
```

Publishing is **open**: there is no manual pre‑approval queue. A submission that passes the automated scan goes live immediately; the safety of the whole system rests on the **sandbox** (a marketplace plugin has no Node/fs/raw‑network access) plus **reactive controls** — community reports, a per‑plugin **revoke/takedown**, and a global **kill switch** the owner can flip at any time.

---

## Publishing a plugin (authors)

You do **not** need a Core license to publish — making plugins is free and separate from Core.

1. Go to **`https://bot.lgtw.tf/?view=developers`**.
2. **Sign in with Discord.** This only identifies you as the author; it does not touch any license.
3. Fill in the form: **name**, **version** (`x.y.z`), a short **description**, and your plugin — a single **`index.js`**, or a **`.zip`** (with `index.js` at its root, plus an optional `plugin.json` for settings/permissions).
4. Publish. The automated scan runs and, unless it flags something serious, your plugin is **live immediately** — you can install it from any bot. You can delete or unpublish any version from **My plugins** at any time.
5. If the scan blocks it (e.g. no `index.js`, or a non‑text upload), it is **held for a quick manual check** instead of going live; the status shows under **My plugins**.

Once published, your plugin is committed to the official storage repository and added to the signed catalog. From that moment any bot can install it.

**Rules**

- A plugin **name is owned by its first author** — nobody else can publish under a name you already use.
- To ship a fix, **bump the version** and publish again (an already‑published version is immutable). To take a version down, **unpublish** it from **My plugins** — it is removed from the catalog and revoked so bots that installed it drop it.
- Marketplace plugins run **sandboxed**: no `require`, `fs`, `process`, or raw network. Use the public plugin API — `ctx.settings`, `ctx.storage`, `ctx.ui.panel`, and (with a declared + user‑approved `net:<host>` permission) `ctx.fetch`. See [Create a plugin](./create-plugin.md).
- Be honest about what your plugin does and **never claim official Core capabilities** — only the verified Core plugin can grant premium entitlement.

---

## Installing a marketplace plugin (users)

A marketplace plugin is declared in `plugins/plugins.jsonc` with `source: "marketplace"`:

```jsonc
{
  "cool-plugin": {
    "enabled": true,
    "source": "marketplace",
    "version": "1.2.0"
  }
}
```

On the next start the bot **downloads it from the catalog, verifies the signature + checksum, installs it, and runs it sandboxed** — no manual file copying. This works on a normal desktop and **headless/CLI** alike. You can also flip a marketplace plugin on/off from the **Plugins** page in [Rewards Desk](./rewards-desk.md).

If an update or anything else removes the plugin folder, the bot simply **re‑downloads it** on the next run (your `plugins.jsonc` intent is preserved across updates).

---

## Permissions & trust

> Only install plugins from authors you trust. The marketplace makes that safe by default, but **you** are always in control of how much access a plugin gets.

- **Sandboxed (default).** Every `source: "marketplace"` plugin runs inside a V8 isolate with **no Node APIs** — no `fs`, `process`, `child_process`, network, the OS credential vault, or the bot object. It sees only the public plugin API over a JSON bridge, and account emails are tokenized before they cross the boundary. A repeatedly‑failing sandboxed plugin is automatically disabled by a circuit breaker.
- **Trusted Mode (opt‑in, `trust: "full"`).** A plugin that genuinely needs full in‑process access must be granted Trusted Mode — an **explicit, local** decision the marketplace can never make for you. In Rewards Desk this is a per‑plugin **“Trusted Mode”** checkbox that pops a clear warning first; without the Desk, set `"trust": "full"` on the entry in `plugins.jsonc`. Either way the bot prints a loud warning on every run while a community plugin is trusted.
- **Always verified.** Whether sandboxed or trusted, a marketplace plugin is checked against the signed catalog (signature + pinned `sha256` + not revoked + not stale) **before any of its code runs**. If the check fails, it does not load (fail‑closed).
- **Community warning.** Enabling a community plugin in the Desk shows a “made by the community, not the official team” notice, so it is never silent.

---

## The trust model (how the signing works)

The marketplace is anchored by a **signed catalog** the bot fetches from core‑api (`/api/marketplace/catalog`) and caches locally (`plugins/marketplace.json` + `plugins/marketplace.sig`):

- An **Ed25519** detached signature over the raw catalog bytes, verified against the trusted public key(s) in `scripts/security/marketplace-keys/`. This is a **separate** trust root from the official Core key — marketplace trust never grants Core entitlement.
- Each plugin is **pinned by `sha256`**; a download whose bytes don’t match is rejected regardless of where it came from.
- A monotonic **`sequence`** (anti‑rollback) and a freshness **TTL** (fail‑closed once too stale), plus per‑plugin **`revoked`** entries and a global **`killSwitch`**.
- The **private signing key lives only on the server** (core‑api), never on a client.

Plugins are stored in a **public** GitHub repository and served by **jsDelivr** (pinned to the exact commit), so the install URL is immutable. The repo must stay public for jsDelivr to serve it; integrity comes from the signature + checksum, not from secrecy.

---

## Security & moderation

- **Open publishing, sandbox‑first.** Plugins publish instantly after an automated static scan (which rejects broken/non‑text uploads and surfaces smells like obfuscation or a declared network permission). Real safety comes from the **sandbox** — a marketplace plugin cannot touch Node, the filesystem, or raw network — not from a human reading every line up front.
- **Reactive takedown.** Anyone can **report** a plugin from Rewards Desk; the owner can **revoke** a specific version (or a whole name) — it leaves the catalog and bots that installed it drop it on next sync — and can flip a **global kill switch** that disables every marketplace plugin at once. A held (scan‑blocked) submission can still be reviewed and published manually.
- **Author gating.** Logins/submissions are checked server‑side (Redis): abusive accounts can be banned, and an optional invite‑only allowlist can restrict who may publish. A per‑author cap limits spam.
- **No impersonation.** Authors are bound to their Discord identity; nobody can publish under another author’s plugin name; commits to the storage repo are made by the server under a **neutral marketplace identity**, never the maintainer’s personal account.
- **Hardened API.** Author sessions are sealed (AES‑GCM) `HttpOnly; Secure; SameSite=Lax` cookies; CORS is pinned to the app origin; all database access is parameterized; names/versions are validated (no path traversal).

---

## For maintainers (running the marketplace)

Server‑side (core‑api / Vercel env):

- `MARKETPLACE_SIGNING_PRIVATE_KEY` — the Ed25519 private key whose public half ships in `scripts/security/marketplace-keys/`.
- `MARKETPLACE_GH_TOKEN` — a GitHub token with **Contents: write** on the storage repo (a fine‑grained token scoped to just that repo is recommended; a classic `repo` token also works). `MARKETPLACE_GH_REPO` defaults to `QuestPilot/marketplace-plugins`.
- Optional: `MARKETPLACE_REQUIRE_ALLOWLIST=1` (invite‑only), `MARKETPLACE_GIT_NAME`/`MARKETPLACE_GIT_EMAIL` (commit identity).

Bot‑side:

- `MSRB_MARKETPLACE_CATALOG_URL=https://bot.lgtw.tf/api/marketplace/catalog` so the bot pulls the latest signed catalog.
- Ship the trusted **public** key in `scripts/security/marketplace-keys/` (commit it upstream so it survives auto‑updates). Sign locally with `npm run marketplace:sign` only for offline/testing — production signs on the server.

Moderate from the dashboard **Admin → Marketplace** section: review the held queue, **revoke** a published plugin, ban authors, and flip the marketplace **kill switch**. The separate **Admin → Safety & Kill Switch** section publishes the global bot‑stop advisory (halts all bots during an incident).

## Related pages

- [Plugin system overview](./plugins.md)
- [Create a plugin](./create-plugin.md)
- [Plugin API reference](./plugin-api.md)
- [Rewards Desk](./rewards-desk.md)
- [Official Core plugin](./core-plugin.md)
