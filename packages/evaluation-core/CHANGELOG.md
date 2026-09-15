# @rollfuse/evaluation-core

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
