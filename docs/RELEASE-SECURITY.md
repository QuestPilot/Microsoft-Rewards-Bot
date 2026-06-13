# Core release signing

The bot uses Ed25519 only to verify the proprietary Core plugin before Core
receives privileged APIs:

- `scripts/security/core-public-key.pem` verifies `plugins/official-core.json`.

Private keys must never be committed. The local release keys are stored under
`%USERPROFILE%\.msrb-release\` with access restricted to the current Windows user.

Bot auto-updates do not use a private signing key, signed manifest, or GitHub
Actions secret. They resolve the configured `main` branch to a full commit SHA,
then use that SHA consistently for package metadata and archive/Git application.

## Core release setup

`Core-Source/scripts/release-core-multitarget.ps1` uses
`MSRB_CORE_PRIVATE_KEY_PATH`, or defaults to:

```text
%USERPROFILE%\.msrb-release\core-private-key.pem
```

The generated `plugins/official-core.sig` signs the exact bytes of
`plugins/official-core.json`. Any target hash, version, or metadata change invalidates it.

## Core key rotation

Key rotation requires a normal trusted release that embeds the new public key before
artifacts are signed by the new private key. Losing a private key without such a transition
requires Core users to install a trusted Core release manually.
