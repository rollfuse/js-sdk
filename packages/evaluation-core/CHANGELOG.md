# @rollfuse/evaluation-core

## 0.3.1

### Patch Changes

- 6ff5891: Republish under a new version. `0.3.0`'s automated publish reported success
  (the git tag `@rollfuse/evaluation-core@0.3.0` was created) but the package
  was never actually visible on the npm registry — confirmed via the raw
  registry API, not just `npm view`'s local cache. npm never allows reusing
  a version number once its release tooling has claimed it, so the registry
  permanently rejects `0.3.0`. No functional change from what `0.3.0` would
  have been; this only carries the format-version work already released
  under `@rollfuse/sdk-js@0.3.0`/`@rollfuse/sdk-browser@0.3.0`, whose
  `@rollfuse/evaluation-core: ^0.3.0` dependency is otherwise unresolvable.

## 0.3.0

### Minor Changes

- fc2a352: Configuration now carries a `format_version`, and every `GET /v1/config`
  request declares this client's own supported version via
  `X-Rollfuse-Client-Format-Version`. A flag using a construct newer than
  this client understands is now served as `non_evaluable: true` with no
  rules/variations; `evaluate()`/`evaluate` throws the new
  `FlagNotEvaluableError` (or serves the caller's supplied fallback) for
  such a flag instead of mis-evaluating it, and `evaluateAll()` omits it
  entirely. No construct newer than format version 1 exists yet, so this
  has no effect on any flag today — it's the mechanism a future construct
  will actually exercise.

### Patch Changes

- Updated dependencies [fc2a352]
  - @rollfuse/contracts@0.8.4

## 0.2.3

### Patch Changes

- adfa19a: Internal refactor: rollout split resolution now converts a split's wire
  percentage into bucket positions once, through a named helper, instead of
  recomputing the same multiplication inline on every accumulation step.
  No behavior change — the conversion was already exact integer arithmetic
  for any whole percentage. Structural parity with the platform's own
  `RolloutSplit.BucketPositions` and go-sdk's equivalent, ahead of
  `expand-targeting-model`'s planned fractional-rollout precision work.

## 0.2.2

### Patch Changes

- Updated dependencies [098cf9c]
  - @rollfuse/contracts@0.8.0

## 0.2.1

### Patch Changes

- c67c8d8: Republish with the correct `@rollfuse/contracts` dependency range. The
  previously published `0.2.0` archive declared `^0.2.2`, five minor versions
  behind the workspace's actual `contracts` dependency (`^0.7.0`), because the
  package was published from a workstation, by hand, out of sync with the
  source. This patch carries no functional change; it exists solely to get a
  correct archive onto the registry under a new version, since an
  already-published version is never overwritten.
