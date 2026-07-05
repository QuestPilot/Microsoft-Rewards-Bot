# Account Safety

Automating Microsoft Rewards always carries some risk to your account. This bot is built to be **safe by default** and gives you knobs to be even more cautious. This page explains both.

> ⚠️ **Reality check.** Microsoft actively detects automation (timing patterns, repeated queries, browser signatures), and bans do happen — they can wipe your points and streak. **Use a throwaway account you can afford to lose, not your main.** No tool can promise "undetectable."

## Safe by default

You don't have to configure anything to get these:

- **Realistic browsing** — a stealth browser with realistic device fingerprints, human-like mouse movement and typing, and randomized delays between searches.
- **Accounts are spaced out** — in a multi-account run, the bot waits a randomized interval between accounts instead of hammering Microsoft back-to-back.
- **Accounts are shuffled** — the processing order is randomized each run, so the same account isn't always first or last.
- **Your proxy covers everything** — when you set a proxy, *all* traffic (searches **and** account API calls) goes through it, so your real IP isn't exposed mid-session.
- **Daily caps respected** — searching stops when the day's points are earned (it doesn't keep hammering for no reason).

## Tuning (optional)

All under `searchSettings` in your `config.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `accountDelay` `{min,max}` | `40sec`–`4min` | Randomized pause **between accounts**. Widen it for more caution with many accounts. |
| `shuffleAccounts` | `true` | Randomize account order each run. Set `false` to keep config order. |
| `delayMultiplier` | `1` | Multiplies **every** randomized delay. Set `2` to run roughly twice as slow/cautious. |
| `searchDelay` `{min,max}` | `30sec`–`1min` | Delay between individual searches. |

Example — a cautious multi-account setup:

```jsonc
{
  "searchSettings": {
    "delayMultiplier": 2,
    "accountDelay": { "min": "2min", "max": "8min" },
    "shuffleAccounts": true
  }
}
```

## Proxies

Set a per-account proxy in `accounts.json` (`proxy.url`, `port`, `username`, `password`). HTTP(S) and SOCKS4/5 are supported. By default a configured proxy is used for **both** the browser and the HTTP client; set `proxy.proxyAxios: false` only if you deliberately want API calls to skip the proxy. Prefer **residential** proxies and **one IP per account** — shared/datacenter IPs and reusing one IP across many accounts are common ban triggers.

## How many accounts is safe?

Fewer is safer. The bot warns above **4 accounts** because larger fleets meaningfully increase risk. If you run many, widen `accountDelay`, raise `delayMultiplier`, and give each account its own residential proxy.

## See also

- [Privacy & Telemetry](./privacy.md) — what data the bot does and doesn't send.
- [Security Policy](../.github/SECURITY.md) — how your credentials are protected.
- [Safety advisory](./safety-advisory.md) — the remote safety kill-switch.
