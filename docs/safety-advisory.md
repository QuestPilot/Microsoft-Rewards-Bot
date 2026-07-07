<div align="center">
  <img src="../assets/banner.png" alt="Microsoft Rewards Bot" width="100%">
</div>

---

# Safety Advisory

Navigation: [Documentation index](./README.md) · [Account safety](./account-safety.md)

The safety advisory check lets maintainers flag that running the bot is temporarily risky. It is enabled by default and is intentionally not part of the normal user configuration.

Every run fetches the current advisory once from `https://bot.lgtw.tf/api/safety-advisory` (backed by Core-API + Redis) before starting. Maintainers toggle it instantly from the admin dashboard — no JSON file to hand-edit or commit.

The advisory payload has this shape:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "severity": "info",
  "message": "No active safety advisory is currently published.",
  "updatedAt": "2026-05-10T00:00:00.000Z"
}
```

A published advisory looks like:

```json
{
  "schemaVersion": 1,
  "status": "blocked",
  "severity": "critical",
  "message": "Maintainers have marked the current Microsoft Rewards flow as risky. Running now may put accounts at risk.",
  "updatedAt": "2026-05-10T00:00:00.000Z"
}
```

## Blocked Behavior

| Value | Behavior |
| --- | --- |
| `prompt` | Shows the warning. Interactive users can press Enter to continue at their own risk. Non-interactive runs stop. |
| `continue` | Shows the warning and continues. |
| `stop` | Shows the warning and stops. |
