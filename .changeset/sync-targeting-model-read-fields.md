---
"@rollfuse/contracts": patch
---

Sync `openapi.yaml`. The `GET /v1/config` `FlagConfig`/`EvaluationRule`
schemas gained `condition` (composed clause tree), `individual_targets`
and `prerequisites`, and the write-side `PutEnvironmentFlagConfigRequest`
schemas gained matching fields — `apps/api`'s own handlers have served
and accepted these since `expand-targeting-model` sections 5/7/8 merged,
but the contract document itself never declared them (a repo-recurring
gap: handler behavior and contract declaration drifting independently).
No behavior change here, only generated types catching up to reality.
