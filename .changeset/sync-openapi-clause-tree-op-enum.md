---
"@rollfuse/contracts": patch
---

Sync `openapi.yaml`: `ClauseTree.op`'s enum incorrectly listed a literal
`"leaf"` value that `apps/api/internal/evaluation/domain`'s `ClauseTree`
never actually serializes — a leaf node's `op` is its own clause operator
(`eq`/`neq`/`gt`/.../`present`) directly, not a `"leaf"` wrapper tag. The
generated TypeScript type inherited this inaccuracy, making it impossible
to construct a correctly-typed leaf `ClauseTree` node without a cast.
Corrects the enum to the real value space: `and`/`or`/`not`/`segment` for
a group/negation/segment node, or one of the closed operator set for a
leaf. No runtime behavior change — this only fixes the contract
declaration to match what the platform has always actually sent and
accepted.
