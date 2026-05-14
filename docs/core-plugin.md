# Official Core Plugin

The bot is open source, but the official Core plugin is proprietary and requires a paid license. Core is preinstalled in `plugins/core`, loaded from bytecode, and trusted only when its checksum matches `plugins/official-core.json`.

## Open Source vs Core

| Feature | Open source | Official Core |
| --- | --- | --- |
| Bing searches | Yes | Yes |
| Daily Set | Limited to 2 quests per day | Unlimited |
| Simple URL rewards and quizzes | Yes | Yes |
| Public plugin API | Yes | Yes |
| Dashboard diagnostics | Yes | Yes |
| Claim points cards | No | Yes |
| Daily streak details | No | Yes |
| Streak protection sync | Forced off when accessible | Forced on when accessible |
| App rewards | No | Yes |
| Redeem goal automation | No | Yes |
| Advanced side-panel automation | No | Yes |

## License And Payment

To buy or renew Core access, contact `@lightzirconite`/`683712256243925066` by private Discord message.

Accepted payment methods for v1:

- PayPal
- gift cards accepted by the maintainer

Xbox and PlayStation gift cards are not accepted.

After payment, you receive a license key. Enable the preinstalled Core plugin in `plugins/plugins.jsonc` and start the bot.

Core validates licenses against the official Turso license database. The official release already includes the required private runtime configuration; only override it if you are running a custom backend or database.

Example:

```jsonc
"core": {
  "enabled": true,
  "priority": 100
}
```

The files `plugins/core/license-admin.html`, `plugins/core/license-admin-server.js`, and `plugins/core/license-admin.config.example.js` are the local License Desk shipped from the private Core source release. The example config contains no secret; the real `license-admin.config.local.js` is for the private maintainer workspace and is ignored in the public bot repository.

## Protection Boundary

The public plugin API cannot grant official Core entitlement and cannot register premium Core tasks. Only the signed official Core bytecode can unlock those paths in the official release.

Because the open-source repository is modifiable, a fork can remove local limits from its own copy. The project does not pretend otherwise. The protected value is the maintained, signed Core release, its license checks, and the advanced dashboard automation that is not shipped as source.

## Before Publishing Core

Before copying a new Core build into the open-source repo:

- verify no database token, API token, private key, or local `.env` value is committed;
- revoke any token that was ever shipped in bytecode or source;
- run `npx tsc --noEmit` and `npm audit --audit-level=moderate` in both repositories;
- rebuild Core release and copy only bytecode/package/license artifacts;
- rebuild Core using Node.js 24.15.0;
- verify `plugins/official-core.json` matches `plugins/core/index.jsc`;
- run the dashboard checks in [Dashboard testing](./dashboard-testing.md).
