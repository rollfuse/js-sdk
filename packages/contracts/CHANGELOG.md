# @rollfuse/contracts

## 0.8.1

### Patch Changes

- 4622cf4: Sync the mirrored `openapi.yaml` and regenerate types. The mirror predated
  several merged rollfuse API changes, most recently `connect-commercial-funnel`'s
  newly-documented platform social sign-in endpoints
  (`GET /v1/auth/social/google`, `GET /v1/auth/social/google/callback`) and
  three previously-undocumented billing/entitlements routes found by a new
  route-vs-contract coverage check (`POST .../billing/setup-intent`,
  `POST .../billing/billing-details`, `POST .../billing/subscription/cancel`,
  `GET`/`POST .../entitlements/{resource_key}[/selection]`).

## 0.8.0

### Minor Changes

- 098cf9c: Sync `openapi.yaml` from the rollfuse API and regenerate types. Adds
  schemas and paths for flag change history (list/get/compare/restore),
  a distinct flag-disable (kill switch) endpoint, environment
  clone/promote/compare, and the environment approval policy, plus
  several schema changes accumulated since the last sync (`FeatureFlag`
  now requires `description` and `tags`; `Configuration` now requires
  `poll_interval_seconds`).

## 0.7.0

### Minor Changes

- 0d7d0fc: Sync the checked-in OpenAPI mirror with the platform's current document and regenerate types. Adds `CheckoutRequest` and the `checkoutOrganizationSubscription` operation (`POST /v1/organizations/{organization_id}/billing/subscription/checkout`), plus a new `Subscription.can_start_new_checkout` field and the previously-undocumented `Subscription.requires_payment_method_to_activate` field. Also pulls in every other endpoint/schema added to the platform's OpenAPI document since the last sync (e.g. `POST /v1/visitor/events`).
