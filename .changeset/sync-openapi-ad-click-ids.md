---
"@rollfuse/contracts": patch
---

Sync `openapi.yaml` with rollfuse/rollfuse's `apps/api/openapi/openapi.yaml`:
`VisitorAcquisition` gains the optional Google Ads click identifiers `gclid`,
`gbraid` and `wbraid` (rollfuse/rollfuse#447). Generated types only; no
runtime change.
