---
"@rollfuse/contracts": patch
---

Sync the mirrored `openapi.yaml` and regenerate types. The mirror predated
several merged rollfuse API changes, most recently `connect-commercial-funnel`'s
newly-documented platform social sign-in endpoints
(`GET /v1/auth/social/google`, `GET /v1/auth/social/google/callback`) and
three previously-undocumented billing/entitlements routes found by a new
route-vs-contract coverage check (`POST .../billing/setup-intent`,
`POST .../billing/billing-details`, `POST .../billing/subscription/cancel`,
`GET`/`POST .../entitlements/{resource_key}[/selection]`).
