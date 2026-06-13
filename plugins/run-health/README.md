# Run Health

Run Health keeps a small local history of recent account outcomes and reports:

- repeated failures;
- successful runs that collected zero points;
- average account duration;
- the current consecutive-failure count.

It never stores passwords, cookies, tokens, or unmasked account addresses.

```jsonc
"run-health": {
  "enabled": false,
  "priority": 30,
  "config": {
    "historyLimit": 50,
    "warnOnZeroPoints": true,
    "outputDir": "diagnostics/run-health"
  }
}
```
