# Core Release Security And Obfuscation

This page defines the maintainer rules for publishing the proprietary Core plugin inside the public bot repository.

## Core Principle

Obfuscation is not a security boundary.

`javascript-obfuscator` and `bytenode` make reverse engineering slower, but they do not make local code impossible to inspect, patch, or replace. The durable security boundary must stay server-side:

- license validation;
- entitlement decisions;
- revocation;
- quotas and abuse controls;
- durable mutation audit;
- backend secrets and private keys.

Never ship database tokens, service API keys, private keys, or license backend secrets in Core bytecode, public source, release scripts, Docker images, or examples.

## Supported Protection Model

The public release should only receive private Core release artifacts from the maintainer pipeline. Do not document or reproduce the private Core build internals in the public repository.

The public repository is allowed to describe the security boundary:

- publish only compiled Core artifacts and minimal metadata;
- pin checksums in the official manifest and plugin catalog;
- keep sensitive authority on Core-API, not in the local plugin.

This is commercial friction, not absolute secrecy. Treat every shipped local artifact as inspectable by a motivated user.

## Runtime Target Rule

`bytenode` bytecode is not portable.

A Core artifact is tied to:

- Node.js version;
- V8 version;
- operating system;
- CPU architecture.

Do not publish a Windows-built `.jsc` as Docker/Linux compatible. Do not publish a Linux-built `.jsc` as Windows compatible. A single `plugins/core/index.jsc` can only be treated as one official runtime target.

The supported Docker target is:

```text
linux-x64-node-24.15.0
```

The supported Windows target is:

```text
win32-x64-node-24.15.0
```

To support both reliably, Core must use a multi-target layout.

## Required Multi-Target Layout

The robust distribution layout is:

```text
plugins/core/
  index.js
  package.json
  targets/
    linux-x64-node-24.15.0/
      index.jsc
      ...
    win32-x64-node-24.15.0/
      index.jsc
      ...
```

The loader must select exactly one target at runtime, and the manifest must pin checksums per target:

```json
{
  "plugin": "core",
  "version": "1.0.4",
  "targets": {
    "linux-x64-node-24.15.0": {
      "indexSha256": "..."
    },
    "win32-x64-node-24.15.0": {
      "indexSha256": "..."
    }
  }
}
```

Until this layout exists, do not claim that the same Core bytecode supports Windows, Linux, and Docker.

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

Before pushing `release`, maintainers must verify:

```bash
npm run core:release-check
npm run update:doctor
npm test
```

When Core changed, also verify:

- the Core artifact was built on the intended target OS and architecture;
- `official-core.json` records the correct target;
- `plugins/official-core.json` matches every shipped Core target;
- `plugins/catalog.json` matches the same target checksums;
- no Core source, sourcemap, `.env`, or private secret exists in the public repository.

## Best Next Step

The next architecture change should be multi-target Core packaging. It solves the current Docker/Linux/Windows conflict without weakening the current obfuscation model.

Do not try to solve this by adding more Debian packages or by rebuilding the same single `.jsc` on Windows. That only changes which platform works.
