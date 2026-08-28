# @rollfuse/contracts

> **Renamed from `@growth-ops/contracts`.** The package identifier changed;
> the API it wraps did not. Update your `package.json` dependency and
> imports from `@growth-ops/contracts` to `@rollfuse/contracts` — no other
> code change is required.

TypeScript types generated from `apps/api/openapi/openapi.yaml`, plus a
runtime schema validator, for `@rollfuse/sdk-js`, `apps/web`, and any other
TypeScript client that needs the platform's request/response shapes
without hand-writing them — and without only *hoping* a hand-written type
still matches what the API actually returns.

Published to the public npm registry; consumers depend on the published
version (`^0.2.x`), not a local workspace/`file:` link — bump the version,
run `npm publish`, then bump the dependent's declared range and reinstall
to pick up a new release. (A `0.x` package's `^` range only allows patch
bumps per semver — bumping the *minor* version here always requires
bumping the declared range in every consumer's `package.json` too, not
just republishing.)

## What's here — the generate → re-export → validate pattern

- `src/openapi.d.ts`: the full, mechanically generated output of
  [`openapi-typescript`](https://openapi-ts.dev/) run against
  `apps/api/openapi/openapi.yaml`. Do not hand-edit this file. Copied into
  `dist/openapi.d.ts` at build time (see "Building" below) — every other
  generated `.d.ts` file references it by relative import, so the built
  package must carry its own copy, not just the `src/` original.
- `src/schemas.json`: `components.schemas` extracted from the same YAML,
  as plain JSON — the input `validateSchema` (below) compiles Ajv
  validators from. Traces back to the exact same source as
  `openapi.d.ts`, in the same generation step, so the static types and
  the runtime validators cannot drift from each other by construction.
- `src/openapi-schemas.ts`: **auto-generated, never hand-edited** — every
  schema in `schemas.json`, re-exported under its own name
  (`export type FeatureFlag = components["schemas"]["FeatureFlag"];`,
  one line per schema). Regenerated in full every time `npm run generate`
  runs; a new OpenAPI schema is available under its own name immediately,
  no manual re-export step needed.
- `src/validate.ts`: exports `validateSchema(schemaName, value): boolean`,
  compiling (and memoizing) an Ajv validator from `schemas.json` on first
  use per schema name. A consumer calls this at the network boundary —
  after `await response.json()`, before trusting the parsed value as the
  corresponding TypeScript type — so a response that doesn't actually
  match its declared schema surfaces as a real validation failure instead
  of silently flowing through an unchecked `as T` cast. See
  `apps/web/src/lib/api-client.ts`'s `interpretResponse`/`parseJsonOrThrow`
  for the reference integration.
- `src/index.ts`: the package's public entry point — re-exports
  everything from `openapi-schemas.ts` plus `validateSchema`. This is the
  only file consumers should import from.

**Adding a new schema to the platform API requires no manual step here**:
regenerate (below), and the new schema is available from `src/index.ts`
under its own name and validatable via `validateSchema` automatically.

## Regenerating

Generation is a manual, reviewed step — it does not run automatically in
CI or as part of any other package's build, matching this repo's existing
discipline around explicit, reviewed schema changes (see
`docs/adr/` for the precedent on migrations). After changing
`apps/api/openapi/openapi.yaml`:

```bash
npm run generate   # rewrites src/openapi.d.ts, src/schemas.json, src/openapi-schemas.ts
```

Commit the regenerated files together with the OpenAPI change that
motivated them. No further manual step is needed — `openapi-schemas.ts`
is fully auto-generated, so a newly added schema needs no hand-written
re-export.

## Building and publishing

```bash
npm install
npm run build       # emits dist/ — tsc, then copies src/openapi.d.ts into dist/ (see package.json's build script)
npm run typecheck
npm run lint
npm test
```

To ship a change to consumers, from the repo root:

```bash
make sdk-bump pkg=contracts level=<patch|minor|major>   # opens a PR with the version bump
# ...review and merge the PR...
make sdk-release pkg=contracts                            # builds, gates, and publishes
```

`sdk-bump` runs lint/typecheck/test/audit, bumps `version` in
`package.json` (`files` is `["dist"]` only — `src/` is not published,
keeping the tarball small) and opens the PR; `sdk-release` re-runs the
same gates, builds, and runs `npm publish`. `NPM_TOKEN` must be set in
the calling shell (an npm Automation token, so 2FA/OTP prompts don't
block the non-interactive publish step) — never written to a file. After
publishing, bump the declared `@rollfuse/contracts` range in each
consumer and run `npm install` there (not automated — a separate,
deliberate PR per consumer).
