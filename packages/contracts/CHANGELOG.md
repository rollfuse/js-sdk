# @rollfuse/contracts

## 0.8.6

### Patch Changes

- 50a3bb4: Sync `openapi.yaml`. The `GET /v1/config` `FlagConfig`/`EvaluationRule`
  schemas gained `condition` (composed clause tree), `individual_targets`
  and `prerequisites`, and the write-side `PutEnvironmentFlagConfigRequest`
  schemas gained matching fields — `apps/api`'s own handlers have served
  and accepted these since `expand-targeting-model` sections 5/7/8 merged,
  but the contract document itself never declared them (a repo-recurring
  gap: handler behavior and contract declaration drifting independently).
  No behavior change here, only generated types catching up to reality.

## 0.8.5

### Patch Changes

- 4fd452f: Sync the mirrored `openapi.yaml` and regenerate types. Picks up
  `expand-targeting-model` task 4.1's `Rule.op`/`Rule.value_type` fields
  (the closed, enumerated operator set beyond exact-string equality),
  which the growth-ops repo already published but this mirror predated.

## 0.8.4

### Patch Changes

- fc2a352: Configuration now carries a `format_version`, and every `GET /v1/config`
  request declares this client's own supported version via
  `X-Rollfuse-Client-Format-Version`. A flag using a construct newer than
  this client understands is now served as `non_evaluable: true` with no
  rules/variations; `evaluate()`/`evaluate` throws the new
  `FlagNotEvaluableError` (or serves the caller's supplied fallback) for
  such a flag instead of mis-evaluating it, and `evaluateAll()` omits it
  entirely. No construct newer than format version 1 exists yet, so this
  has no effect on any flag today — it's the mechanism a future construct
  will actually exercise.

## 0.8.3

### Patch Changes

- 07fcef4: Sync the mirrored `openapi.yaml` and regenerate types. The mirror predated
  growth-ops's `complete-governance-surface` work: `ApprovalRequest` gained
  a `kind` discriminator (`role_grant`/`environment_flag_config_change`),
  `environment_id`/`feature_flag_id` fields, and `decision_reason` is now
  populated by an approval decision as well as a rejection; a new
  `GET /v1/approval-requests/decided` endpoint lists already-decided
  requests; `POST /v1/approval-requests/{id}/approve` now accepts an
  optional `comment`.

## 0.8.2

### Patch Changes

- 5445188: Sync the mirrored `openapi.yaml` and regenerate types. Adds `AuditEvent`'s
  `actor_type`/`actor_id` fields and the `predates_actor_capture` marker
  (`complete-governance-surface` sections 1-2), plus an `actor_type`/
  `actor_id` filter on the audit listing and export endpoints.

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
