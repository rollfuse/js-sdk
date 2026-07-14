# contracts

Placeholder for shared, versioned API/event contracts (e.g. generated types
from `apps/api/openapi/openapi.yaml`).

No implementation exists yet. Do not add speculative code here; the OpenAPI
document at `apps/api/openapi/openapi.yaml` is currently the single source of
truth for the API contract. This package will be populated when a second
consumer (an SDK or another service) needs a generated, versioned artifact
instead of hand-written typed clients like `apps/web/src/lib/api-client.ts`.
