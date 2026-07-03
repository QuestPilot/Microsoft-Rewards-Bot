# Marketplace trusted public keys

This directory holds the **Ed25519 public key(s)** the bot trusts to sign the plugin
marketplace catalog (`plugins/marketplace.json` → `plugins/marketplace.sig`).

- Drop one `*.pem` file per trusted key. The catalog verifies if **any** key matches,
  so you can publish a `next` key alongside the `current` one and **rotate without a
  bot release** (ship the new public key in an update, switch the server to sign with
  it, then retire the old key in a later release).
- This is a **separate** trust root from the official Core key
  (`scripts/security/core-public-key.pem`) — marketplace trust must never grant Core
  premium entitlement.
- The matching **private key lives only on the server** (core-api). It must never be
  committed here or shipped to any client. Sign with `npm run marketplace:sign`
  (`MSRB_MARKETPLACE_PRIVATE_KEY` / `MSRB_MARKETPLACE_PRIVATE_KEY_PATH`).

If this directory has no keys, the bot cannot verify a marketplace catalog and will
**fail closed** for marketplace-sourced plugins (they will not load).
