# @rollfuse/sdk-js

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
  - @rollfuse/evaluation-core@0.3.0

## 0.2.1

### Patch Changes

- 844b3fd: Fixed `start()`'s init-timeout timer being `unref()`'d, the same as the
  poll/retry timer beside it. That's correct for the poll/retry timer, but
  wrong for the init timer: against a platform that refuses the connection
  immediately rather than hanging, nothing else was left pending, so the
  whole process could exit silently (code 0) before the timer ever fired,
  leaving `start()`'s returned Promise abandoned forever unsettled instead
  of rejecting with `InitializationTimeoutError`. Found running against a
  real deployment (task 11.2), not reproducible against a mocked fetch.
- Updated dependencies [4622cf4]
  - @rollfuse/contracts@0.8.1

## 0.2.0

### Minor Changes

- cace6d6: Deduplicate exposure events by observation identity (subject key + flag
  key + variation key) within a configurable window (`dedupeWindowMs`,
  default 60s), so a component re-rendering or re-evaluating the same flag
  for the same subject no longer inflates exposure counts. Drops caused by
  dedup or a full queue are now aggregated and reported once per flush
  instead of being silently discarded. Also guards `runFlush()` against
  overlapping concurrent flushes.
- cace6d6: `sdk-browser` now flushes queued exposure events on page dismissal
  (`visibilitychange`/`pagehide`) using `fetch(..., {keepalive: true})`, so
  events queued just before a tab close are no longer lost. `close()` on
  both packages now accepts a bound via `closeTimeoutMs`
  (`DEFAULT_CLOSE_TIMEOUT_MS`) instead of waiting indefinitely for an
  in-flight flush, and releases config-change subscribers. Fixed a bug
  where calling `start()` again after `stop()` left the client's poll loop
  permanently inert instead of resuming polling.
- cace6d6: `RollfuseClient` gains `subscribe(listener)` to observe Configuration
  changes after construction, not just via the constructor-time
  `onConfigRefreshed` callback. `RollfuseProvider` uses it to emit
  OpenFeature's `PROVIDER_CONFIGURATION_CHANGED` event, and now reports a
  non-string evaluation-context attribute through the SDK's logger
  (`logger.warn`) instead of silently excluding it from rule matching.

### Patch Changes

- cace6d6: Configuration polling now revalidates via `If-None-Match`/ETag (a 304
  response keeps the current cache instead of re-decoding an unchanged
  payload), applies random jitter on top of the configured interval to
  avoid synchronized thundering-herd polling across clients, and honors a
  server-advised poll interval when present. Exposure batches larger than
  the platform's accepted request size are now split into chunks instead
  of failing outright.

## 0.1.2

### Patch Changes

- Updated dependencies [098cf9c]
  - @rollfuse/contracts@0.8.0
  - @rollfuse/evaluation-core@0.2.2
