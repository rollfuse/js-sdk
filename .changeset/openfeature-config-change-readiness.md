---
"@rollfuse/sdk": minor
"@rollfuse/openfeature-provider": minor
---

`RollfuseClient` gains `subscribe(listener)` to observe Configuration
changes after construction, not just via the constructor-time
`onConfigRefreshed` callback. `RollfuseProvider` uses it to emit
OpenFeature's `PROVIDER_CONFIGURATION_CHANGED` event, and now reports a
non-string evaluation-context attribute through the SDK's logger
(`logger.warn`) instead of silently excluding it from rule matching.
