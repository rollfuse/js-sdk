---
"@rollfuse/contracts": minor
---

Sync `openapi.yaml` from the rollfuse API and regenerate types. Adds
schemas and paths for flag change history (list/get/compare/restore),
a distinct flag-disable (kill switch) endpoint, environment
clone/promote/compare, and the environment approval policy, plus
several schema changes accumulated since the last sync (`FeatureFlag`
now requires `description` and `tags`; `Configuration` now requires
`poll_interval_seconds`).
