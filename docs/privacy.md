# Privacy & Telemetry

We believe a tool that handles your Microsoft account should be **transparent** about what it sends. This page tells you exactly what the bot collects, what it never collects, and how to turn it off.

> **Community decision.** Telemetry is enabled by default because the community asked for it: in a public poll, **19 of 22 voters (86%) chose to keep anonymous telemetry on** so we can find and fix bugs faster. It remains your choice — opting out is one line (below).

## What is collected (anonymous)

When `analytics.enabled` is on, the bot sends **redacted, anonymous diagnostics** so we can improve reliability:

- Run lifecycle: run started/completed, scheduler triggers, updates applied.
- Aggregate results: searches completed, workers executed, accounts completed/banned (counts and status only).
- Errors and crashes (redacted stack/diagnostics) — this is how silent bugs get noticed and fixed.
- Feature usage: which features/toggles and plugins are used (so we invest in what people actually use).

Each install uses a **random anonymous instance ID**. There is no account, no login, and no analytics key in the client — data is relayed through our endpoint, not sent directly to any analytics vendor.

## What is NEVER collected

- ❌ Passwords, 2FA secrets, recovery emails
- ❌ Cookies, session tokens, OAuth/access tokens
- ❌ Core license keys
- ❌ Proxy credentials or webhook URLs
- ❌ Your real email address — emails are **masked** before anything is sent
- ❌ Full file paths, IPs, or raw URLs — these are redacted

Redaction happens **on your machine, before sending**.

## How to turn it off

Set telemetry off in your `config.json`:

```jsonc
{
  "analytics": { "enabled": false }
}
```

> Note: disabling telemetry also disables **error reporting**, which means crashes on your install can no longer be detected or fixed automatically. That's a fair trade-off to make — it's your call.

## Where the data goes

Diagnostics are sent over HTTPS to the project's own relay endpoint, which forwards anonymized events to our analytics. No third-party analytics SDK runs inside the bot, and no analytics key ships in the client.

See also: **[Security Policy](../SECURITY.md)** for how your credentials are protected.
