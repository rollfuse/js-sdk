import type { components } from "./openapi.js";

/**
 * Curated, stably-named re-exports of the OpenAPI schemas `@growth-ops/sdk-js`
 * (and other TypeScript consumers) need, so callers never have to reach into
 * `openapi.d.ts`'s generated `components["schemas"][...]` path structure
 * directly. Regenerate `src/openapi.d.ts` via `npm run generate` when
 * `apps/api/openapi/openapi.yaml` changes, then add/update the re-export
 * here for any newly needed schema.
 */

export type Configuration = components["schemas"]["Configuration"];
export type FlagConfig = components["schemas"]["FlagConfig"];
export type EvaluationVariation = components["schemas"]["EvaluationVariation"];
export type EvaluationRule = components["schemas"]["EvaluationRule"];
export type EvaluationOutcome = components["schemas"]["EvaluationOutcome"];
export type EvaluateRequest = components["schemas"]["EvaluateRequest"];
export type EvaluationResult = components["schemas"]["EvaluationResult"];
export type EvaluateResponse = components["schemas"]["EvaluateResponse"];
export type ExposureEvent = components["schemas"]["ExposureEvent"];
export type ExposureEventSubmission = components["schemas"]["ExposureEventSubmission"];
export type SubmitExposureEventsRequest = components["schemas"]["SubmitExposureEventsRequest"];
export type SubmitExposureEventsResponse = components["schemas"]["SubmitExposureEventsResponse"];
