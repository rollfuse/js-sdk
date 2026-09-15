---
"@rollfuse/evaluation-core": patch
---

Republish under a new version. `0.3.0`'s automated publish reported success
(the git tag `@rollfuse/evaluation-core@0.3.0` was created) but the package
was never actually visible on the npm registry — confirmed via the raw
registry API, not just `npm view`'s local cache. npm never allows reusing
a version number once its release tooling has claimed it, so the registry
permanently rejects `0.3.0`. No functional change from what `0.3.0` would
have been; this only carries the format-version work already released
under `@rollfuse/sdk-js@0.3.0`/`@rollfuse/sdk-browser@0.3.0`, whose
`@rollfuse/evaluation-core: ^0.3.0` dependency is otherwise unresolvable.
