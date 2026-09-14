---
"@rollfuse/contracts": patch
---

Sync the mirrored `openapi.yaml` and regenerate types. Adds `AuditEvent`'s
`actor_type`/`actor_id` fields and the `predates_actor_capture` marker
(`complete-governance-surface` sections 1-2), plus an `actor_type`/
`actor_id` filter on the audit listing and export endpoints.
