# Run Summary Plugin

Run Summary is a free optional plugin that writes local account result summaries after each account finishes.

It creates:

- `data/run-summary/accounts.jsonl`
- `data/run-summary/latest.json`
- `data/run-summary/latest.md`

## Configuration

Enable it in `plugins/plugins.jsonc`:

```jsonc
"run-summary": {
  "enabled": true,
  "priority": 40,
  "config": {
    "outputDir": "data/run-summary",
    "includeEmails": false,
    "writeMarkdown": true
  }
}
```

`includeEmails` is disabled by default, so account emails are masked in the generated files.

