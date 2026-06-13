# Session Health

Session Health checks the official `sessions/` directory and reports:

- missing session storage before the first login;
- empty account session directories;
- sessions whose files have not changed recently.

It reports counts only and never reads or exposes cookie contents.

```jsonc
"session-health": {
  "enabled": false,
  "priority": 20,
  "config": {
    "sessionPath": "sessions",
    "staleDays": 30
  }
}
```
