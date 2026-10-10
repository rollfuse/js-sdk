---
"@rollfuse/contracts": patch
---

Sync openapi.yaml with rollfuse/rollfuse's improve-console-ux API additions: the Project flag listing gains `sort`, `state_environment_id` and `state` parameters and returns `ListedFeatureFlag` items with `environment_states`; `RenameFeatureFlagRequest` documents `tags`; history actors carry `display_name`; restore and promote document a 202 `PendingConfigurationChange` and the already-pending 409.
