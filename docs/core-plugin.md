<div align="center">
  <img src="../assets/banner-core.png" alt="Microsoft Rewards Bot — Core" width="100%">
</div>

---

# Official Core Plugin

Navigation: [Documentation index](./README.md) · [Core technical reference](./core-plugin-reference.md) · [Core Dashboard](./dashboard.md)

The free bot handles Bing searches and daily tasks. **Core goes further** — it captures every point the free version misses, protects your streak, applies coupons automatically, and gives you a remote dashboard to watch and control your machines from anywhere.

---

## Try Core Free — 3 Days

Not sure yet? **Claim a free 3-day trial** before buying anything.

<div align="center">

**[Join the Discord → discord.gg/JWhCkhSYtg](https://discord.gg/JWhCkhSYtg)**

</div>

Once in the server, click the **View Store** button in the bot — from there you can claim your trial directly, no payment needed.

---

## Free vs Core

| Feature | Free | Core |
| --- | :---: | :---: |
| Works on both dashboards (new + classic) | ✓ auto-detected | ✓ auto-detected |
| Bing searches | ✓ | ✓ |
| Daily Set | Limited | Full maintained coverage |
| Activities & quizzes | ✓ | ✓ |
| Claimable point cards | — | ✓ |
| Dashboard coupons | — | ✓ |
| Daily streak protection | — | ✓ |
| App rewards | — | ✓ |
| Temporary quest pages | — | Best effort |
| Run summary | Basic logs | Full embed with points & coupon impact |
| Remote web dashboard | — | ✓ |
| Silent background mode | — | ✓ |
| Auto-start on boot | — | ✓ |

---

## Remote Dashboard

<div align="center">
  <img src="../assets/website.png" alt="Core remote web dashboard" width="90%">
</div>

<br>

Monitor every machine from a single web panel — no local server, no VPN needed. Core opens a secure outbound connection to the official dashboard.

From the dashboard you can see every connected device, follow live logs, check the bot's status, start or stop a run remotely, install auto-start, edit accounts, and more. Machines stay visible for up to 30 days after going offline.

Access is tied to your Core license and Discord login — no separate account to manage.

---

## Full Rewards Coverage

Core reaches the parts of the Rewards dashboard that the free bot skips entirely:

- **Claimable point cards** — detected and claimed automatically when points are ready.
- **Dashboard coupons** — opened, applied one by one, and logged with name and expiry.
- **Streak protection** — your daily streak is tracked and synced so one missed day does not reset weeks of progress.
- **App rewards** — daily check-in and read-to-earn handled silently every run.
- **Run summary** — a structured Discord notification after each run with per-account results, balance changes, coupons applied, and a Core vs free comparison.

---

## Works on both Microsoft dashboards

Microsoft is rolling out a new Rewards dashboard, but plenty of accounts are still on the **classic** one — and it varies from account to account. The bot detects which dashboard each account is served and runs the right path automatically, so **every account is fully covered on either dashboard** — one install, no configuration.

- On the **new** dashboard, Core works the on-page cards (claim, coupons, streak panel, quests).
- On the **classic** dashboard, Core uses the matching account endpoints to claim your ready points, keep your streak protected, and clear punch cards — and the classic dashboard often exposes *more* earnable activities, so there's more for Core to collect.

If Microsoft eventually migrates everyone, nothing changes for you — the bot simply stays on the new path.

---

## Silent & Automatic

Core can run entirely in the background — no terminal window, no Rewards Desk open. Configure it once, and it starts silently with your computer and appears in the dashboard ready for the next run.

Auto-start is installed in one click from the dashboard, with no administrator rights required, on Windows, Linux, and macOS.

---

## Terminal Page Harvester

Maintainers can analyze the live Rewards pages once, independently of a normal points run:

```powershell
npm start -- harvester
```

The command uses the first enabled account and the official Core plugin, rebuilds `Page/` with the HTML, RSC payloads, screenshots, and `summary.json`, then prints the complete analysis in the terminal. It does not start the scheduler or remote dashboard, send analytics or webhooks, or update configuration, statistics, and sessions.

---

## Your Data Stays Yours

Core only sends sanitized data to the dashboard: masked account emails, run state, filtered logs, and point summaries. Passwords, cookies, tokens, and webhook URLs never leave your machine.

Account edits from the dashboard are encrypted in your browser before being sent. Only your local bot can decrypt and apply them.

Automatic error reports and feedback go to your own configured webhook by default, and only travel through the project's relay if you opt in by setting `MSRB_AUTOREPORT_RELAY=1`.

---

## Get Core

<div align="center">

**[Join the Discord → discord.gg/JWhCkhSYtg](https://discord.gg/JWhCkhSYtg)**

</div>

The store is inside the **[QuestPilot Discord](https://discord.gg/JWhCkhSYtg)**. Click **View Store** in the bot to see pricing and choose a plan. Accepted payment methods: PayPal and select gift cards (Xbox and PlayStation gift cards are not accepted).

After purchase you receive a license key. Open the **Core Panel** channel in the Discord, follow the panel instructions, and paste your key in Rewards Desk when the bot starts — that's it.

---

## Good to Know

Microsoft Rewards varies by country, account level, available offers, and time. Core improves coverage and keeps up with Microsoft changes, but it does not guarantee a fixed monthly point value. Some dashboard cards — sweepstakes, subscriptions, app-only offers — are detected and logged but cannot be automated.

---

## Learn More

- [Core Dashboard](./dashboard.md) — full details on the remote dashboard.
- [Core technical reference](./core-plugin-reference.md) — coverage model, security boundaries, and release integrity.
- [Docker](./docker.md) — Core in Docker.
- [Troubleshooting](./troubleshooting.md) — if something does not load or activate.
