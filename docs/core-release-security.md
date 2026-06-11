# Core Release Integrity

This page defines the public repository rules for accepting an official Core plugin artifact.

## Core Principle

Local plugin files are not a place for server authority. Durable security decisions must stay server-side:

- license validation;
- entitlement decisions;
- revocation;
- quotas and abuse controls;
- durable mutation audit;
- backend secrets and private keys.

Never ship database tokens, service API keys, private keys, or license backend secrets in Core bytecode, public source, release scripts, Docker images, or examples.

## Public Repository Contract

The public repository must only receive official Core artifacts from the private maintainer pipeline. Do not document or reproduce private Core build internals in this repository.

The public repository may describe only the public contract:

- publish only official compiled Core artifacts and minimal metadata;
- pin checksums in the official manifest and plugin catalog;
- keep sensitive authority on Core-API, not in the local plugin.

## Runtime Target Rule

Official Core artifacts are runtime-targeted. Maintainers must publish separate official artifacts for each supported OS/architecture/Node target and pin every checksum in the official metadata.

## Public Repository Leak Rules

The public repository must never contain:

- `Core-Source/src/**`;
- Core `.ts` files;
- Core sourcemaps;
- unobfuscated Core `dist/**/*.js`;
- `.env` files;
- private keys;
- database URLs or tokens;
- dashboard backend secrets;
- license signing secrets.

The only allowed JavaScript file inside `plugins/core` is the minimal loader. It must not contain business logic.

Allowed Core artifact types:

- `.jsc`;
- `index.js` loader;
- `package.json`;
- `package-lock.json`;
- `LICENSE`;
- `official-core.json` metadata.

## Release Gate

Before pushing `main`, maintainers must verify:

```bash
npm run core:release-check
npm run update:doctor
npm test
```

When Core changed, also verify:

- the private maintainer pipeline produced the official target artifacts;
- `plugins/official-core.json` matches every shipped Core target checksum;
- `plugins/catalog.json` matches the same target checksum metadata;
- the Intel macOS compatibility target is identical to its declared Linux x64 source artifact;
- no Core source, sourcemap, `.env`, or private secret exists in the public repository.
