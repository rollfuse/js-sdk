---
"@rollfuse/evaluation-core": minor
---

Adds typed attribute values (string/number/boolean/list of strings) and
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
