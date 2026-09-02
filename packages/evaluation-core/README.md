# @rollfuse/evaluation-core

The dependency-free, browser-and-Node-safe deterministic flag evaluation
and bucketing algorithm behind [rollfuse](https://rollfuse.com)'s SDKs.
`@rollfuse/sdk-js` and `@rollfuse/sdk-browser` both build on this package
instead of each shipping their own copy, so the two can never silently
resolve a flag to a different variation for the same subject.

Part of the [rollfuse JS/TS SDK family](https://github.com/rollfuse/js-sdk)
— most apps want `@rollfuse/sdk-js`, `@rollfuse/sdk-browser`, or
`@rollfuse/sdk-react` instead of depending on this package directly.

## What's here

- **`bucket(flagKey, subjectKey)`** — the stable rollout-bucketing
  contract: FNV-1a (32-bit) of `flagKey + ":" + subjectKey`, modulo
  `BUCKET_MODULUS` (10000, for 0.01% rollout granularity). Reproduced
  bit-for-bit from the platform API's own Go implementation, and verified
  against the exact same cross-language golden-vector fixture the
  [Go SDK](https://github.com/rollfuse/go-sdk) checks its own bucketing
  against — the two can never drift apart without both test suites
  failing.
- **`evaluateFlag(config, subjectKey, attributes)`** — deterministic,
  local flag evaluation: rules evaluated in order with first-match-wins, a
  rule's conditions matching only when every attribute is present and
  equal, and a rollout outcome resolved via `bucket`. Never throws — every
  input resolves to some variation.
- **`resolveTraceHeaders()` / `applyTraceHeaders()`** — W3C trace-context
  propagation for outbound SDK calls: reuses an active host
  OpenTelemetry context when one exists (`@opentelemetry/api` is an
  optional peer dependency), or self-issues a valid `traceparent`
  otherwise, so every SDK-originated call belongs to a linkable trace.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build   # emits dist/ (gitignored), a dual ESM+CJS build via tsup
```

Depends on `@rollfuse/contracts` (published separately to npm) for its
request/response types. `@opentelemetry/api` is an optional peer
dependency — the package works correctly without it installed.

### Publishing

This repo uses [Changesets](https://github.com/changesets/changesets) for
independent per-package versioning:

```bash
npx changeset            # describe your change, pick which package(s) and bump level
# commit the generated .changeset/*.md file(s) with your PR
```

Merging to `main` opens or updates a "Version Packages" PR that applies
every pending changeset (bumps `version`, updates `CHANGELOG.md`).
Merging *that* PR publishes every package whose version changed to npm,
automatically, via `.github/workflows/release.yml` (`NPM_TOKEN` configured
as a repo secret) — no manual `npm publish` step.
