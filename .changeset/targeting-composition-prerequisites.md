---
"@rollfuse/evaluation-core": minor
---

Adds `ClauseTree` (AND/OR/NOT composition, nesting bounded at 5),
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
