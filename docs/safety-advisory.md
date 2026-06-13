# Safety Advisory

The safety advisory check lets maintainers publish a small JSON file when running the bot is temporarily risky. It is enabled by default and is intentionally not part of the normal user configuration.

## Advisory File

The remote JSON file uses this shape:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "severity": "info",
  "message": "No active safety advisory is currently published.",
  "updatedAt": "2026-05-10T00:00:00.000Z"
}
```

To warn users, publish:

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
