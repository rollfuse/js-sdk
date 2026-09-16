---
"@rollfuse/contracts": patch
---

Fix `PutEnvironmentFlagConfigResponse`'s schema wrongly requiring `environment_flag_config` even when `status` is `pending_approval`, where the API never sends that field. This made `validateSchema("PutEnvironmentFlagConfigResponse", ...)` reject every real `pending_approval` response as malformed. `required` now lists only `status`, matching the sibling `GrantRoleResponse` schema's own discriminated-by-status pattern.
