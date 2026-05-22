# Run Summary Plugin

Run Summary is a free optional plugin that writes local account result summaries after each account finishes.

It creates:

- `diagnostics/run-summary/accounts.jsonl`
- `diagnostics/run-summary/latest.json`
- `diagnostics/run-summary/latest.md`

## Configuration

Enable it in `plugins/plugins.jsonc`:

```jsonc
"run-summary": {
  "enabled": true,
  "priority": 40,
  "config": {
    "outputDir": "diagnostics/run-summary",
    "includeEmails": false,
    "writeMarkdown": true
  }
}
```

`includeEmails` is disabled by default, so account emails are masked in the generated files.

