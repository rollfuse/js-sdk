# @rollfuse/openfeature-provider

## 0.2.0

### Minor Changes

- cace6d6: `RollfuseClient` gains `subscribe(listener)` to observe Configuration
  changes after construction, not just via the constructor-time
  `onConfigRefreshed` callback. `RollfuseProvider` uses it to emit
  OpenFeature's `PROVIDER_CONFIGURATION_CHANGED` event, and now reports a
  non-string evaluation-context attribute through the SDK's logger
  (`logger.warn`) instead of silently excluding it from rule matching.

### Patch Changes

- Updated dependencies [cace6d6]
- Updated dependencies [cace6d6]
- Updated dependencies [cace6d6]
- Updated dependencies [cace6d6]
  - @rollfuse/sdk-js@0.2.0

## 0.1.1

### Patch Changes

- bcbdea4: Republish under a new version. `0.1.0` was published, then unpublished
  while correcting its npm trusted-publishing configuration; npm never
  allows reusing a version number once it has been published (even after an
  unpublish), so the registry now permanently rejects `0.1.0`. No functional
  change from what `0.1.0` would have been.
