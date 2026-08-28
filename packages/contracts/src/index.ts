/**
 * Public API of @rollfuse/contracts.
 *
 * Every OpenAPI schema is available by its own name, auto-generated into
 * `openapi-schemas.ts` by `npm run generate` (never hand-edited) — see
 * that file's header. `validateSchema` runtime-checks a parsed response
 * against the same schema `schemas.json` and the static types both trace
 * back to, so a caller isn't only trusting a compile-time assertion; see
 * `validate.ts` and README.md's "generate → re-export → validate" pattern.
 */
export * from "./openapi-schemas.js";
export { validateSchema } from "./validate.js";
