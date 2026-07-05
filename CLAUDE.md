# Microsoft-Rewards-Bot Agent Instructions

## No dead code

Never keep old/legacy code, files, or fallback paths around "just in case" once
they're superseded. When something is replaced, remove the old version in the
same change — don't leave both the new and the old living side by side.

This applies even when the old path exists for backward compatibility with
already-deployed clients (e.g. an old bot version hitting a URL baked into its
compiled code): if a graceful failure path already exists (fetch error, 404,
etc. handled without crashing), prefer the clean cutover and let old clients
hit the graceful failure path, rather than shipping and maintaining two parallel
implementations indefinitely.

If keeping a legacy path is genuinely required (a hard compatibility
constraint, not just caution), say so explicitly and ask before doing it.
