# Microsoft-Rewards-Bot — Agent Instructions

How to work in this repository. External contributors: also read
[AGENTS.md](AGENTS.md) (contribution boundaries, refusals, landmines) and
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). This file is the
engineering methodology — it applies to every change, big or small.

## What this project is

Source-available Microsoft Rewards automation in TypeScript/Node.js:
stealth browser automation (patchright + fingerprints + human-like input),
multi-account with encrypted credentials, a local web control panel
(**Rewards Desk**), a sandboxed plugin system with a signed marketplace, an
optional compiled premium **Core** plugin, silent auto-updates, and full
Docker/headless support. Users trust it with their Microsoft passwords —
treat every change as security-sensitive by default.

## The working loop

Follow this loop for every task. Steps are cheap to follow and expensive to
skip — most past regressions came from skipping one of them.

1. **Understand before editing.** Read the whole relevant module and its
   tests, not just the lines you plan to touch. Check `git status --short`
   first and preserve unrelated pending changes.
2. **Find the root cause.** When fixing a bug, reproduce it (or explain
   precisely why you can't), then fix the cause — not the symptom. A patch
   that makes the error message disappear without explaining *why* it
   appeared is not a fix.
3. **Make the smallest complete change.** Complete = code + tests + docs +
   removal of what it replaces. Small = no drive-by refactors, no renames,
   no "while I'm here" edits outside the task.
4. **Prove it works — don't assume it.** See [Verification](#verification).
   Reading the code and concluding "this should work" is not verification.
5. **Report honestly.** State what you verified and how, what you did not
   verify, and anything you left in a worse or uncertain state. "Built but
   not tested on macOS" is a useful report; silence about it is a bug.

## Verification

There is **no CI gate on pull requests**. Local checks are the only gate
before a human review, so run them yourself, every time:

```bash
npm run build                          # tsc + asset copy — zero errors
npm test                               # Node built-in runner, scripts/tests/
npx prettier --check <files you touched>
```

(Repo-wide `npm run format:check` is not currently clean — check only the
files you changed, and don't reformat unrelated files in your commit.)

- Run a single test file with `node --test scripts/tests/<file>.test.js`.
- Tests use Node's built-in runner only — never add jest/mocha/vitest.
- If the change has a runtime surface (Desk, launcher, updater, scheduler,
  browser task…), **exercise that flow for real** after the tests pass:
  start it, click it, watch it do the thing. Several real bugs in this
  project (profile lock collisions, EPERM self-overwrite, orphan scheduler
  processes) were invisible to tests and found only by running the app.
- If a scenario genuinely can't be run here (other OS, Docker, a live
  Microsoft account), say so explicitly in your report instead of implying
  full coverage.

## Non-negotiable rules

### 1. Always cross-platform

Every feature must work on Windows, macOS, and Linux — including headless
Linux/Docker where there is no desktop/GUI. Never ship an OS-specific path,
command, or assumption without an equivalent (or an explicit, deliberate
no-op) on the other platforms. When a feature genuinely cannot make sense on
one platform (e.g. a GUI notification on a headless server), detect that
platform explicitly and skip cleanly — never let it silently break or crash
there.

### 2. No dead code

Never keep old/legacy code, files, or fallback paths around "just in case"
once they're superseded. When something is replaced, remove the old version
in the same change — don't leave both living side by side. This applies even
when the old path exists for backward compatibility with already-deployed
clients: if a graceful failure path already exists (fetch error, 404, etc.
handled without crashing), prefer the clean cutover and let old clients hit
the graceful failure path. If keeping a legacy path is genuinely required (a
hard compatibility constraint, not just caution), say so explicitly and ask
before doing it.

### 3. No inline selectors

CSS selectors for Microsoft pages never live inline in task/automation code.
They belong in the selector registries (`src/automation/DashboardSelectors.ts`
for the public bot; Core has its own registry), where they are named,
centralized, and validated. Markers internal to our own UI are named local
constants, not magic strings scattered through logic.

### 4. Safety guardrails are features, not friction

The account-safety mechanisms (inter-account stagger and jitter, the
>4-accounts warning, free-tier pacing, the remote safety advisory) exist to
protect end users from getting their Microsoft accounts banned. Never
weaken, bypass, or "simplify away" one of them to make a task easier or a
test pass. Same for the security boundaries (plugin signature/checksum
verification, sandbox, updater verification) — see the Landmines section of
[AGENTS.md](AGENTS.md). If a task seems to require loosening one, stop and
flag it.

### 5. Exact Node version

`engines.node` (see `.nvmrc`) is exact, not a minimum: the official Core
plugin ships as V8 bytecode compiled for that Node build. If a bug looks
impossible or only reproduces on one machine, check the Node version before
anything else.

## Architecture map

| Area | Where | Notes |
| --- | --- | --- |
| Entry point | `src/index.ts` | Account loop, worker orchestration |
| Browser + stealth | `src/automation/` | `BrowserManager`, fingerprints, `MagicCursor`, viewport |
| Login flows | `src/automation/auth/` | Strategy per method: password, TOTP, passwordless, recovery… |
| Dashboard actions | `src/automation/dashboard/` | `legacy/` + `next/` behind one factory — both must keep working |
| Task engine | `src/core/` | `ActivityRunner`, `SearchOrchestrator`, `Scheduler`, `TaskBase` |
| Plugin system | `src/core/PluginManager.ts`, `src/plugin-api.ts` | Signature checks + V8-isolate sandbox — landmine area |
| Config / data | `src/helpers/` | `ConfigLoader` (zod schemas), `DataManager`, encrypted accounts |
| Rewards Desk | `scripts/desk/` | Local control panel; `app-window.js` is very large — read the region you touch, fully |
| Updater | `scripts/updater/` | Verifies releases before applying; excludes user data — landmine area |
| Launchers | `scripts/runtime/`, `scripts/launchers/` | `scripts/runtime/` is gitignored but required at runtime: it is generated/self-healed, never assume it ships in a release |
| Compiled Core | `plugins/core/` | Signed artifact from a separate private pipeline — never hand-edit |
| Tests | `scripts/tests/` | Node test runner |
| Docs | `docs/` | User-facing product surface — see below |

Config lives in `src/config.json` (user) vs `src/config.example.json`
(template): when adding a config option, update the example, the zod schema
in `ConfigLoader`, and the relevant docs page in the same change.

## Documentation rules

The docs are part of the product — for a tool that asks for Microsoft
credentials, clear and honest docs *are* the trust argument.

- Every user-visible feature or config option gets documented in the
  matching `docs/*.md` page **in the same change** that introduces it.
- Write simply: short sentences, second person, task-first ("To do X…").
  No hype, no unexplained jargon, no screenshots of things that don't exist.
- Be transparent about trade-offs: ban risk, telemetry (opt-out, documented
  in `docs/privacy.md`), what's free vs what's Core. Overselling costs more
  trust than it buys.
- New pages must be linked from `docs/README.md` (the index) — an unlinked
  page doesn't exist.

## Git etiquette

- Never push, tag, or publish a release unless explicitly asked. Committing
  locally when a task is done is fine.
- This repository is **public**. Never commit secrets, private keys, `.env`
  files, tokens, real account data, or references to private
  infrastructure. Before committing, review `git diff --cached` with that in
  mind.
- One logical change per commit, imperative subject line
  (`fix: …`, `feat: …`, `docs: …` as in the existing history).
- Never use destructive git commands (`reset --hard`, `checkout --`,
  force-push) on work you didn't create in this session.
