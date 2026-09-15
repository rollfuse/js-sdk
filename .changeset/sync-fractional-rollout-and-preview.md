---
"@rollfuse/contracts": patch
---

Sync `openapi.yaml`. `RolloutSplit.percentage` and `EvaluationOutcome.rollout[].percentage`
changed from `integer` to `number` (expand-targeting-model task 8.5,
fractional rollout precision), and a new
`POST /v1/environments/{environment_id}/feature-flags/{feature_flag_id}/config/preview`
endpoint (task 8.6) was added, with its `PreviewEnvironmentFlagConfigRequest`/
`PreviewEnvironmentFlagConfigResponse`/`PreviewAttributeValue` schemas.
No behavior change to any existing field; generated types only.
