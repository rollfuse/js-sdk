---
"@rollfuse/evaluation-core": patch
---

Bumped `CLIENT_FORMAT_VERSION` from 1 to 2. Section 5.8 already implemented every FormatVersion2 construct (composed ClauseTree, individual targets, prerequisites) in this package, but the constant was never bumped to declare that capability to the platform — meaning the platform has been silently marking those constructs `non_evaluable` for this client in production regardless of its real capability. Also added `TestTargetingModel`-equivalent coverage for the shared conformance fixture's rollout vectors.
