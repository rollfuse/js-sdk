# @rollfuse/contracts

> **Renamed from `@growth-ops/contracts`.** The package identifier changed;
> the API it wraps did not. Update your `package.json` dependency and
> imports from `@growth-ops/contracts` to `@rollfuse/contracts` — no other
> code change is required.

TypeScript types generated from `apps/api/openapi/openapi.yaml`, for
`@rollfuse/sdk-js` and any other TypeScript client that needs the
platform's request/response shapes without hand-writing them.

## What's here

- `src/openapi.d.ts`: the full, mechanically generated output of
  [`openapi-typescript`](https://openapi-ts.dev/) run against
  `apps/api/openapi/openapi.yaml`. Do not hand-edit this file.
- `src/index.ts`: a small, stably-named set of re-exports of the schemas
  consumers actually need (`Configuration`, `FlagConfig`,
  `EvaluationResult`, `ExposureEvent`, etc.), so nothing outside this
  package has to reach into `openapi.d.ts`'s generated
  `components["schemas"][...]` path structure directly.

## Regenerating

Generation is a manual, reviewed step — it does not run automatically in
CI or as part of any other package's build, matching this repo's existing
discipline around explicit, reviewed schema changes (see
`docs/adr/` for the precedent on migrations). After changing
`apps/api/openapi/openapi.yaml`:

```bash
npm run generate   # rewrites src/openapi.d.ts
```

Then update `src/index.ts` if the change added or renamed a schema this
package re-exports, and commit both files together with the OpenAPI change
that motivated them.

## Building

```bash
npm install
npm run build       # emits dist/ (gitignored, rebuilt by consumers)
npm run typecheck
npm run lint
```
