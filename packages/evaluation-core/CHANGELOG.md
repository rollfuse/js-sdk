# @rollfuse/evaluation-core

## 0.5.1

### Patch Changes

- 8cb4d2d: Bumped `CLIENT_FORMAT_VERSION` from 1 to 2. Section 5.8 already implemented every FormatVersion2 construct (composed ClauseTree, individual targets, prerequisites) in this package, but the constant was never bumped to declare that capability to the platform — meaning the platform has been silently marking those constructs `non_evaluable` for this client in production regardless of its real capability. Also added `TestTargetingModel`-equivalent coverage for the shared conformance fixture's rollout vectors.

## 0.5.0

### Minor Changes

- fb842bb: Adds `ClauseTree` (AND/OR/NOT composition, nesting bounded at 5),
  `IndividualTarget` and `Prerequisite` to the targeting model
  (`expand-targeting-model` section 5), independently mirroring
  `apps/api`'s and `go-sdk`'s own implementations. `evaluateFlag`/
  `evaluateFlagTyped` now take the full `flags` array as their first
  argument so a prerequisite can resolve against the caller's
  already-fetched Configuration with no extra network call (chain depth
  bounded at 4 as a defensive fail-safe). Regex clauses are validated
  against an explicit excluded-construct list (backreferences,
  lookaround) before ever compiling a pattern, since native `RegExp`
  accepts a strictly larger, pathologically-vulnerable grammar than the
  RE2-safe subset Go's stdlib `regexp` enforces structurally.

## 0.4.0

### Minor Changes

- 2d5c465: Adds typed attribute values (string/number/boolean/list of strings) and
  the closed nine-operator clause set (eq/neq/gt/gte/lt/lte/in/prefix/
  suffix/substring/regex/semver comparisons/present), independently
  implementing the same model `apps/api`'s own evaluation domain and
  `go-sdk` implement. `evaluateFlag(map<string,string>)` is unchanged for
  every existing caller; the new `evaluateFlagTyped` entry point and
  `numberAttr`/`boolAttr`/`listAttr`/`stringAttr` helpers are what a
  caller needing a number, boolean or list attribute reaches. Bounded
  regex is validated against an explicit excluded-construct list
  (backreferences, lookaround) before ever compiling a pattern, since
  native `RegExp` accepts a strictly larger, pathologically-vulnerable
  grammar than the RE2-safe subset Go's stdlib `regexp` enforces
  structurally.

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
