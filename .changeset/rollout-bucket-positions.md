---
"@rollfuse/evaluation-core": patch
---

Internal refactor: rollout split resolution now converts a split's wire
percentage into bucket positions once, through a named helper, instead of
recomputing the same multiplication inline on every accumulation step.
No behavior change — the conversion was already exact integer arithmetic
for any whole percentage. Structural parity with the platform's own
`RolloutSplit.BucketPositions` and go-sdk's equivalent, ahead of
`expand-targeting-model`'s planned fractional-rollout precision work.
