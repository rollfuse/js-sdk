---
"@rollfuse/contracts": patch
---

Sync `openapi.yaml` with rollfuse/rollfuse's `apps/api/openapi/openapi.yaml`.
This mirror had fallen behind: it now also documents `GET /v1/config/stream`,
`GET /v1/segments/{segment_id}/referencing-flags` (`SegmentReferencesResponse`)
and the client-format-version compatibility fields. From harden-dos-resilience
(rollfuse/rollfuse#440): `ExposureEventSubmission` and `EvaluateRequest.subject_key`
declare their length limits and `config_version`'s minimum, and the evaluation,
exposure, metric-observation, acquisition-context and identity-link routes
declare their `429` (`rate_limited`) and `503` (`request_deadline_exceeded`)
responses. Generated types only; no runtime change.
