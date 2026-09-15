---
"@rollfuse/contracts": patch
"@rollfuse/evaluation-core": minor
"@rollfuse/sdk-js": minor
"@rollfuse/sdk-browser": minor
---

Configuration now carries a `format_version`, and every `GET /v1/config`
request declares this client's own supported version via
`X-Rollfuse-Client-Format-Version`. A flag using a construct newer than
this client understands is now served as `non_evaluable: true` with no
rules/variations; `evaluate()`/`evaluate` throws the new
`FlagNotEvaluableError` (or serves the caller's supplied fallback) for
such a flag instead of mis-evaluating it, and `evaluateAll()` omits it
entirely. No construct newer than format version 1 exists yet, so this
has no effect on any flag today — it's the mechanism a future construct
will actually exercise.
