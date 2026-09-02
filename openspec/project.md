# Project Context

## Product

**js-sdk** is the JS/TS client family for **rollfuse**, a developer-first
feature-flag and progressive-delivery platform. This repository holds only
the client SDKs and the primitives they're built on — the platform itself
(API, web console, the Go SDK) lives elsewhere: `rollfuse/rollfuse` and
`rollfuse/go-sdk`.

It was extracted from `rollfuse/rollfuse`'s `packages/contracts`,
`packages/evaluation-core`, `packages/sdk-js`, `packages/sdk-browser`, and
`packages/sdk-react` by `extract-js-sdk-monorepo`, preserving each
package's full commit history, so the family can be published and
versioned as a normal npm workspaces monorepo instead of living inside a
private application monorepo.

## What This Repo Does

Five independently versioned, independently released npm packages:

- **contracts** — TypeScript types generated from the platform's OpenAPI
  document, plus a runtime schema validator.
- **evaluation-core** — the dependency-free, browser-and-Node-safe
  deterministic flag-evaluation and bucketing algorithm shared by `sdk`
  and `sdk-browser`.
- **sdk** (published as `@rollfuse/sdk-js`) — the Node.js server SDK.
- **sdk-browser** — the browser SDK, Public-Credential-only by
  construction.
- **sdk-react** — React/Next.js bindings: a Provider and
  `useFlag`/`useFlags` hooks.

Every SDK evaluates flags **locally**, against a cached, versioned
Configuration fetched from the platform's API, instead of calling the API
synchronously on every evaluation (ADR 0004 in `rollfuse/rollfuse`:
Evaluate Flags Locally in SDKs).

## Engineering Priorities

1. Correctness — an evaluation result must always match what the platform
   API would have returned for the same Configuration Version, flag,
   subject key and attributes, and must match across every package and
   every language SDK (`rollfuse/go-sdk` included).
2. Availability — an integrating application must remain operational when
   the platform is unreachable (safe fallback, failure isolation).
3. Maintainability
4. Performance

## Architecture Constraints

- `sdk` holds a Service Credential secret — server-only, never meant for
  browser code.
- `sdk-browser` accepts only a Public Credential (`config:read`-scoped);
  it must never offer an API surface that could accept a regular Service
  Credential.
- `sdk-react` never imports `sdk` and never accepts a Service Credential
  — that boundary is structural, so it can be safely bundled into browser
  code.
- Evaluation (`evaluate`/`evaluateAll`) MUST be synchronous and MUST NOT
  perform a network call once a Configuration is cached.
- The bucketing algorithm's output MUST match `rollfuse/rollfuse`'s API
  and `rollfuse/go-sdk` bit for bit — see `openspec/config.yaml`'s context
  for the cross-repo fixture-parity mechanism.
- This repo has no HTTP server, no database, and no multi-tenant request
  handling — those concerns live in `rollfuse/rollfuse` and are out of
  scope here.
- Packages cross-depend on each other via real npm workspace links in
  this repo (development), resolving to real published semver ranges at
  publish time — never a `workspace:`/`file:` reference in what actually
  ships.

## Repository Shape

```text
/
├── packages/
│   ├── contracts/          Generated OpenAPI types + runtime validator
│   ├── evaluation-core/    Shared bucketing/evaluation algorithm
│   ├── sdk/                Node.js server SDK (@rollfuse/sdk-js)
│   ├── sdk-browser/        Browser SDK
│   └── sdk-react/          React/Next.js bindings
├── .changeset/              Per-package independent versioning
├── openspec/
└── README.md                 Sells the whole family
```

## Specification Rules

- `openspec/specs/` contains the currently accepted behavior and
  constraints for this SDK family. `sdk-js`, `sdk-react`, and
  `sdk-trace-propagation` are the authoritative behavioral contracts —
  `rollfuse/rollfuse`'s `platform-conformance-harness` (its JS driver,
  `tools/harness/js`) exercises `packages/sdk` directly against a real
  environment as one way of verifying it.
- `openspec/changes/` contains proposed deltas and implementation plans.
- A change design explains only the implementation of that change.
- Tests are part of the same task as the behavior they validate.
