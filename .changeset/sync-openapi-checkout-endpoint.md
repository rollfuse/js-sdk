---
"@rollfuse/contracts": minor
---

Sync the checked-in OpenAPI mirror with the platform's current document and regenerate types. Adds `CheckoutRequest` and the `checkoutOrganizationSubscription` operation (`POST /v1/organizations/{organization_id}/billing/subscription/checkout`), plus a new `Subscription.can_start_new_checkout` field and the previously-undocumented `Subscription.requires_payment_method_to_activate` field. Also pulls in every other endpoint/schema added to the platform's OpenAPI document since the last sync (e.g. `POST /v1/visitor/events`).
