---
"@rollfuse/contracts": patch
---

Sync the mirrored `openapi.yaml` and regenerate types. Picks up
`expand-targeting-model` task 4.1's `Rule.op`/`Rule.value_type` fields
(the closed, enumerated operator set beyond exact-string equality),
which the growth-ops repo already published but this mirror predated.
