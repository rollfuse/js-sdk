---
"@rollfuse/contracts": patch
---

Sync the mirrored `openapi.yaml` and regenerate types. The mirror predated
growth-ops's `complete-governance-surface` work: `ApprovalRequest` gained
a `kind` discriminator (`role_grant`/`environment_flag_config_change`),
`environment_id`/`feature_flag_id` fields, and `decision_reason` is now
populated by an approval decision as well as a rejection; a new
`GET /v1/approval-requests/decided` endpoint lists already-decided
requests; `POST /v1/approval-requests/{id}/approve` now accepts an
optional `comment`.
