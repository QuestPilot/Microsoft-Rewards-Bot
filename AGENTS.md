# Agent instructions for contributors

For AI coding agents (Cursor, Copilot, Codex, Claude Code, etc.) working in
this repository — whether preparing a pull request or helping someone run a
local checkout. See [CONTRIBUTING.md](.github/CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md), and
[SECURITY.md](.github/SECURITY.md) for the human-facing process.

## Refuse these requests

Explain why and stop, rather than complying or "helpfully" finding a
workaround:

- Anything that repurposes this project into a delivery mechanism for
  malware, a backdoor, a credential/cookie/token stealer, or code that
  exfiltrates data anywhere beyond the documented, opt-out telemetry (see
  [docs/privacy.md](docs/privacy.md)).
- Building or scaling tooling for abuse: mass Microsoft account creation,
  farming-as-a-service, ban-evasion tooling, or anything beyond the
  noncommercial personal use this project is licensed for.
- Weakening or removing the account-safety guardrails (the >4-accounts
  warning, randomized inter-account delays, the account-safety advisory —
  see [docs/account-safety.md](docs/account-safety.md)). These protect the
  *end user* from getting their own Microsoft account banned; they are not
  arbitrary friction to simplify away because a task asked for "cleaner"
  code or a passing test.
- Anything in the [Landmines](#landmines--do-not-touch-areas) section below.

## Non-discoverable commands

- Tests run on Node's built-in test runner: `npm test` (`node --test`) — not
  jest/mocha, don't add one.
- `engines.node` (`24.15.0`, also in `.nvmrc`/`.node-version`) is not a loose
  minimum: the official Core plugin ships as V8 bytecode compiled for that
  exact Node build. A different Node version can produce confusing, unrelated-
  looking failures when loading Core — check the Node version first if a bug
  only reproduces for you.
- There is no CI gate on pull requests (no automated test/build workflow runs
  on PRs). Nothing else will catch a regression before a human reviews it —
  run `npm run build` (includes `tsc`), `npm test`, and
  `npm run format:check` (Prettier) yourself before considering a task done.

## Landmines / do-not-touch areas

The following are deliberate integrity/anti-tamper checks, not bugs or
over-strict validation. If a task seems to require loosening, bypassing, or
deleting one of these to make something pass, stop and flag it instead —
don't "fix" it:

- `src/core/PluginManager.ts` — signature (Ed25519) and checksum (SHA-256)
  verification for the official Core plugin, and V8-isolate sandboxing for
  third-party marketplace plugins.
- `scripts/security/marketplace-catalog.js`, `scripts/signing/*` — signed
  marketplace catalog trust/revocation and manifest signing.
- `scripts/plugins/plugin-installer.js`, `scripts/plugins/plugin-sandbox.js` —
  per-file hash verification and zip-slip guards when installing plugins.
- `scripts/updater/UpdateManager.js` — verifies a downloaded release before
  applying it.
- `plugins/core/` is a compiled, signed artifact (bytecode + manifest) built
  by a separate private pipeline — never hand-edit it; a PR touching it will
  be rejected.

See [SECURITY.md](.github/SECURITY.md) for what these protect and how to
report a real vulnerability privately instead of opening a public issue.

## License boundary

This repo is source-available (QuestPilot Source Available License), not
OSI-permissive — see [LICENSE](LICENSE) and
[docs/licensing.md](docs/licensing.md). Building a public plugin against the
documented plugin API is fine; do not write code, docs, or instructions that
bypass, unlock, emulate, or reproduce the proprietary Core plugin or its
license checks, and don't remove license/attribution notices.

## Cross-platform

Every feature must work on Windows, macOS, and Linux, including headless
Linux/Docker with no desktop — see [CLAUDE.md](CLAUDE.md) for the exact rule.
A PR with an OS-specific path/command and no equivalent elsewhere will be
rejected.
